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
    const outcome: GenerationOutcome = {
      requestId: request.requestId,
      status: 'not-started',
      fallbackUsed: false,
      attempts: [],
    };

    const stream = this.run(request, outcome);
    return { stream, outcome };
  }

  private async *run(
    request: GenerationRequest,
    outcome: GenerationOutcome,
  ): AsyncGenerator<string, void, unknown> {
    const startedAt = Date.now();
    outcome.startedAt = startedAt;

    if (request.abortSignal?.aborted) {
      outcome.status = 'cancelled';
      outcome.endedAt = Date.now();
      return;
    }

    const attempts = routeGenerationProviders(request.route).filter(
      (attempt) => attempt.status === 'available',
    );

    if (attempts.length === 0) {
      outcome.status = 'failed';
      outcome.error = 'No available provider can satisfy this generation request.';
      outcome.endedAt = Date.now();
      return;
    }

    let attemptedCount = 0;

    for (const attempt of attempts) {
      if (request.abortSignal?.aborted) {
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
            record.status = 'committed';
            outcome.committedProvider = attempt.provider;
            outcome.committedModel = attempt.model;
          }

          yield chunk;
        }

        if (request.abortSignal?.aborted) {
          record.status = 'cancelled';
          record.endedAt = Date.now();
          outcome.status = 'cancelled';
          outcome.endedAt = Date.now();
          return;
        }

        record.status = 'succeeded';
        record.endedAt = Date.now();
        outcome.status = 'completed';
        outcome.endedAt = record.endedAt;
        return;
      } catch (error: any) {
        const message = error?.message ? String(error.message) : String(error);
        record.error = message.slice(0, 500);
        record.endedAt = Date.now();

        if (request.abortSignal?.aborted) {
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

    outcome.status = 'failed';
    outcome.error = outcome.attempts[outcome.attempts.length - 1]?.error
      ?? 'All selected providers failed before first token.';
    outcome.endedAt = Date.now();
  }
}
