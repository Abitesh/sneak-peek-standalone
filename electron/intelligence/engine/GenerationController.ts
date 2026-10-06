/**
 * Provider-agnostic generation lifecycle for Natively Intelligence.
 *
 * The engine hands this layer one already-assembled final prompt.  This module
 * does not inspect the question, evidence, context plan, or prompt semantics.
 * ProviderRouter decides the ordered provider/model attempts; the injected
 * transport performs one provider generation; this controller owns streaming,
 * first-token timing, cancellation, commit, pre-commit fallback, and terminal
 * errors.
 */

import {
  routeGenerationProviders,
  type ProviderAttempt,
  type ProviderRouteOptions,
} from '../../llm/ProviderRouter';

export interface ProviderGenerationTransport {
  streamFinalPrompt(
    provider: ProviderAttempt['provider'],
    model: string | undefined,
    finalPrompt: string,
    options?: {
      abortSignal?: AbortSignal;
      thinkingBudget?: number;
    },
  ): AsyncGenerator<string, void, unknown>;
}


export type GenerationLifecycleState =
  | 'IDLE'
  | 'PLANNING'
  | 'RETRIEVING'
  | 'GENERATING'
  | 'COMMITTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface GenerationLifecycleSnapshot {
  requestId: string;
  state: GenerationLifecycleState;
  changedAt: number;
  history: Array<{ state: GenerationLifecycleState; at: number; reason?: string }>;
}

const ALLOWED_LIFECYCLE_TRANSITIONS: Record<GenerationLifecycleState, readonly GenerationLifecycleState[]> = {
  IDLE: ['PLANNING', 'GENERATING', 'CANCELLED', 'FAILED'],
  PLANNING: ['RETRIEVING', 'GENERATING', 'CANCELLED', 'FAILED'],
  RETRIEVING: ['GENERATING', 'CANCELLED', 'FAILED'],
  GENERATING: ['COMMITTED', 'CANCELLED', 'FAILED'],
  COMMITTED: ['COMPLETED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

/**
 * Canonical lifecycle state machine shared by the new generation path and
 * legacy/manual streaming integration. It owns lifecycle state only; it does
 * not select context, providers, or answer content.
 */
export class GenerationLifecycle {
  private _state: GenerationLifecycleState = 'IDLE';
  private readonly _history: GenerationLifecycleSnapshot['history'];

  constructor(public readonly requestId: string) {
    this._history = [{ state: 'IDLE', at: Date.now() }];
  }

  get state(): GenerationLifecycleState {
    return this._state;
  }

  get snapshot(): GenerationLifecycleSnapshot {
    return {
      requestId: this.requestId,
      state: this._state,
      changedAt: this._history[this._history.length - 1]?.at ?? Date.now(),
      history: this._history.map((entry) => ({ ...entry })),
    };
  }

  transition(next: GenerationLifecycleState, reason?: string): GenerationLifecycleSnapshot {
    if (next === this._state) return this.snapshot;
    const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid generation lifecycle transition: ${this._state} -> ${next}`);
    }
    const at = Date.now();
    this._state = next;
    this._history.push({ state: next, at, ...(reason ? { reason } : {}) });
    return this.snapshot;
  }

  cancel(reason = 'cancelled'): GenerationLifecycleSnapshot {
    if (this._state === 'COMPLETED' || this._state === 'FAILED' || this._state === 'CANCELLED') return this.snapshot;
    return this.transition('CANCELLED', reason);
  }

  fail(reason = 'failed'): GenerationLifecycleSnapshot {
    if (this._state === 'COMPLETED' || this._state === 'FAILED' || this._state === 'CANCELLED') return this.snapshot;
    return this.transition('FAILED', reason);
  }
}

export type GenerationStatus =
  | 'not-started'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GenerationAttemptRecord {
  provider: ProviderAttempt['provider'];
  model?: string;
  status: 'started' | 'committed' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
  error?: string;
}

export interface GenerationRequest {
  requestId: string;
  finalPrompt: string;
  route: ProviderRouteOptions;
  abortSignal?: AbortSignal;
  thinkingBudget?: number;
  lifecycle?: GenerationLifecycle;
}

export interface GenerationOutcome {
  requestId: string;
  status: GenerationStatus;
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
  firstTokenLatencyMs?: number;
  committedProvider?: ProviderAttempt['provider'];
  committedModel?: string;
  fallbackUsed: boolean;
  attempts: GenerationAttemptRecord[];
  error?: string;
  lifecycle: GenerationLifecycleSnapshot;
}

/**
 * The controller is intentionally reusable. It does not own provider clients;
 * those are supplied through ProviderGenerationTransport.
 */
export class GenerationController {
  constructor(private readonly transport: ProviderGenerationTransport) {}

  stream(request: GenerationRequest): {
    stream: AsyncGenerator<string, void, unknown>;
    outcome: GenerationOutcome;
  } {
    const lifecycle = request.lifecycle ?? new GenerationLifecycle(request.requestId);
    const outcome: GenerationOutcome = {
      requestId: request.requestId,
      status: 'not-started',
      fallbackUsed: false,
      attempts: [],
      lifecycle: lifecycle.snapshot,
    };

    const stream = this.run(request, outcome, lifecycle);
    return { stream, outcome };
  }

  private async *run(
    request: GenerationRequest,
    outcome: GenerationOutcome,
    lifecycle: GenerationLifecycle,
  ): AsyncGenerator<string, void, unknown> {
    const startedAt = Date.now();
    outcome.startedAt = startedAt;

    if (request.abortSignal?.aborted) {
      lifecycle.cancel('aborted before generation');
      outcome.lifecycle = lifecycle.snapshot;
      outcome.status = 'cancelled';
      outcome.endedAt = Date.now();
      return;
    }

    if (lifecycle.state === 'IDLE') lifecycle.transition('GENERATING', 'generation started without planning/retrieval phase');
    else if (lifecycle.state === 'PLANNING') lifecycle.transition('RETRIEVING', 'generation started');
    if (lifecycle.state === 'RETRIEVING') lifecycle.transition('GENERATING', 'provider generation started');

    const attempts = routeGenerationProviders(request.route).filter(
      (attempt) => attempt.status === 'available',
    );

    if (attempts.length === 0) {
      lifecycle.fail('no available provider');
      outcome.lifecycle = lifecycle.snapshot;
      outcome.status = 'failed';
      outcome.error = 'No available provider can satisfy this generation request.';
      outcome.endedAt = Date.now();
      return;
    }

    let attemptedCount = 0;

    for (const attempt of attempts) {
      if (request.abortSignal?.aborted) {
        lifecycle.cancel('aborted before provider attempt');
        outcome.lifecycle = lifecycle.snapshot;
        outcome.status = 'cancelled';
        outcome.endedAt = Date.now();
        return;
      }

      attemptedCount += 1;
      if (attemptedCount > 1) outcome.fallbackUsed = true;

      const record: GenerationAttemptRecord = {
        provider: attempt.provider,
        model: attempt.model,
        status: 'started',
        startedAt: Date.now(),
      };
      outcome.attempts.push(record);
      outcome.status = 'streaming';

      let committed = false;
      let emitted = false;

      try {
        const providerStream = this.transport.streamFinalPrompt(
          attempt.provider,
          attempt.model,
          request.finalPrompt,
          {
            abortSignal: request.abortSignal,
            thinkingBudget: request.thinkingBudget,
          },
        );

        for await (const chunk of providerStream) {
          if (request.abortSignal?.aborted) {
            lifecycle.cancel('aborted while consuming provider stream');
            outcome.lifecycle = lifecycle.snapshot;
            record.status = 'cancelled';
            record.endedAt = Date.now();
            outcome.status = 'cancelled';
            outcome.endedAt = Date.now();
            return;
          }

          if (!chunk) continue;

          if (!emitted) {
            emitted = true;
            const firstTokenAt = Date.now();
            record.firstTokenAt = firstTokenAt;
            outcome.firstTokenAt ??= firstTokenAt;
            outcome.firstTokenLatencyMs ??= firstTokenAt - startedAt;
          }

          // FIRST VISIBLE TOKEN = PROVIDER COMMIT POINT.
          // Once committed, this request must never switch providers and append
          // a second answer after a mid-stream provider failure.
          if (!committed) {
            committed = true;
            if (lifecycle.state === 'GENERATING') lifecycle.transition('COMMITTED', 'first visible token emitted');
            record.status = 'committed';
            outcome.committedProvider = attempt.provider;
            outcome.committedModel = attempt.model;
          }

          yield chunk;
        }

        if (request.abortSignal?.aborted) {
          lifecycle.cancel('aborted during provider stream');
          outcome.lifecycle = lifecycle.snapshot;
          record.status = 'cancelled';
          record.endedAt = Date.now();
          outcome.status = 'cancelled';
          outcome.endedAt = Date.now();
          return;
        }

        record.status = 'succeeded';
        record.endedAt = Date.now();
        if (lifecycle.state === 'COMMITTED') lifecycle.transition('COMPLETED', 'provider stream completed');
        else if (lifecycle.state === 'GENERATING') lifecycle.transition('COMPLETED', 'provider completed without visible output');
        outcome.lifecycle = lifecycle.snapshot;
        outcome.status = 'completed';
        outcome.endedAt = record.endedAt;
        return;
      } catch (error: any) {
        const message = error?.message ? String(error.message) : String(error);
        record.error = message.slice(0, 500);
        record.endedAt = Date.now();

        if (request.abortSignal?.aborted) {
          lifecycle.cancel('provider stream aborted');
          outcome.lifecycle = lifecycle.snapshot;
          record.status = 'cancelled';
          outcome.status = 'cancelled';
          outcome.endedAt = Date.now();
          return;
        }

        if (committed || emitted) {
          // A provider that has already emitted visible output is committed.
          // Do NOT append another provider's full answer after a post-commit
          // failure. The caller receives the partial stream as-is.
          record.status = 'failed';
          outcome.status = 'failed';
          lifecycle.fail(`provider ${attempt.provider} failed after commit`);
          outcome.lifecycle = lifecycle.snapshot;
          outcome.error = `Provider ${attempt.provider} failed after commit: ${message}`.slice(0, 700);
          outcome.endedAt = Date.now();
          return;
        }

        // Failure before first token: this provider never committed, so the
        // controller may safely try the next provider selected by the router.
        record.status = 'failed';
        continue;
      }
    }

    lifecycle.fail('all selected providers failed before first token');
    outcome.lifecycle = lifecycle.snapshot;
    outcome.status = 'failed';
    outcome.error = outcome.attempts[outcome.attempts.length - 1]?.error
      ?? 'All selected providers failed before first token.';
    outcome.endedAt = Date.now();
  }
}
