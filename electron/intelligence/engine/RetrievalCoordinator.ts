/**
 * Canonical retrieval execution boundary for Natively Intelligence.
 *
 * The ContextPlanner decides WHAT context is necessary. This coordinator is
 * the only new-engine component allowed to turn that plan into retrieval work.
 * It deliberately knows nothing about ranking, embeddings, prompts, providers,
 * or renderer state.
 *
 * Existing RetrievalPort implementations remain behind adapters. They are not
 * deleted or rewritten in Change 7 because they contain mature scope,
 * authority, version, and relevance safeguards. Migration can wire them into
 * this boundary without giving them permission to make a new retrieval
 * decision.
 */

import type { ContextPlan, ContextSource } from './ContextTypes';
import type { NativelyIntelligenceRequest, NativelyEvidence, NativelyEvidenceItem } from './types';

export interface RetrievalCapabilityRequest {
  query: string;
  source: ContextSource;
  request: NativelyIntelligenceRequest;
  contextPlan: ContextPlan;
  signal?: AbortSignal;
}

export interface RetrievalCapabilityResult {
  items: NativelyEvidenceItem[];
  /** Optional diagnostic detail from the underlying retrieval implementation. */
  metadata?: Record<string, unknown>;
}

export interface RetrievalCapability {
  source: ContextSource;
  retrieve(input: RetrievalCapabilityRequest): Promise<RetrievalCapabilityResult>;
}

export interface RetrievalDecisionTrace {
  decisionId: string;
  requestId: string;
  query: string;
  plannedSources: ContextSource[];
  executedSources: ContextSource[];
  skippedSources: ContextSource[];
  callCount: number;
}

export interface RetrievalCoordinatorResult {
  evidence: NativelyEvidence;
  trace: RetrievalDecisionTrace;
}

export interface RetrievalCoordinatorOptions {
  capabilities?: RetrievalCapability[];
  onDecision?: (trace: RetrievalDecisionTrace) => void;
}

/**
 * Sources that represent the same retrieval operation are collapsed here.
 * For example, a project question can have both `project_knowledge` and
 * `rag` in its ContextPlan: project_knowledge identifies the authoritative
 * pool while rag describes the retrieval mechanism. They must NOT become two
 * independent searches.
 */
const SOURCE_EXECUTION_PRIORITY: ContextSource[] = [
  'meeting_transcript',
  'project_knowledge',
  'my_files',
  'mode_documents',
  'personal_knowledge',
  'profile',
  'structured_knowledge',
  'screen',
  'longer_conversation',
  'recent_conversation',
  'rag',
];

const RETRIEVABLE = new Set<ContextSource>(SOURCE_EXECUTION_PRIORITY);

function chooseExecutionSources(plan: ContextPlan): ContextSource[] {
  const required = new Set(plan.requiredSources);
  const chosen: ContextSource[] = [];

  // A concrete source wins over the generic `rag` mechanism. This is the
  // critical anti-duplication rule for Change 7.
  for (const source of SOURCE_EXECUTION_PRIORITY) {
    if (!required.has(source)) continue;
    if (!RETRIEVABLE.has(source)) continue;
    chosen.push(source);
  }

  if (chosen.length > 0) {
    return chosen.filter((source) => source !== 'rag');
  }

  // Generic RAG is still a legitimate retrieval tool when the plan explicitly
  // requests it without naming a more authoritative source pool.
  return required.has('rag') ? ['rag'] : [];
}

function dedupeEvidence(items: NativelyEvidenceItem[]): NativelyEvidenceItem[] {
  const byKey = new Map<string, NativelyEvidenceItem>();
  for (const item of items) {
    const key = `${item.source}:${item.id}:${item.content.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    const previous = byKey.get(key);
    if (!previous || (item.score ?? 0) > (previous.score ?? 0)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

export class RetrievalCoordinator {
  private readonly capabilities = new Map<ContextSource, RetrievalCapability>();
  private readonly onDecision?: RetrievalCoordinatorOptions['onDecision'];

  constructor(options: RetrievalCoordinatorOptions = {}) {
    this.onDecision = options.onDecision;
    for (const capability of options.capabilities ?? []) {
      // One capability per source is intentional. A second implementation for
      // the same source would recreate the fan-out this coordinator exists to
      // prevent.
      if (!this.capabilities.has(capability.source)) {
        this.capabilities.set(capability.source, capability);
      }
    }
  }

  async retrieve(
    contextPlan: ContextPlan,
    input: NativelyIntelligenceRequest,
    query: string,
  ): Promise<RetrievalCoordinatorResult> {
    const decisionId = `retrieval:${input.sessionId}:${input.requestId}`;
    const plannedSources = [...contextPlan.requiredSources];
    const executedSources = chooseExecutionSources(contextPlan);
    const skippedSources = plannedSources.filter((source) => !executedSources.includes(source));
    const trace: RetrievalDecisionTrace = {
      decisionId,
      requestId: input.requestId,
      query,
      plannedSources,
      executedSources: [],
      skippedSources,
      callCount: 0,
    };

    if (input.cancellationSignal?.aborted || executedSources.length === 0) {
      this.onDecision?.(trace);
      return { evidence: { items: [], sufficient: false }, trace };
    }

    const items: NativelyEvidenceItem[] = [];
    for (const source of executedSources) {
      if (input.cancellationSignal?.aborted) break;

      const capability = this.capabilities.get(source);
      if (!capability) {
        // Missing capability is not permission to substitute another source.
        // The plan remains authoritative and the absence is observable.
        continue;
      }

      trace.callCount += 1;
      trace.executedSources.push(source);
      const result = await capability.retrieve({
        query,
        source,
        request: input,
        contextPlan,
        signal: input.cancellationSignal,
      });
      items.push(...result.items);
    }

    const evidence = dedupeEvidence(items);
    this.onDecision?.(trace);

    return {
      evidence: {
        items: evidence,
        sufficient: evidence.length > 0,
      },
      trace,
    };
  }
}

/**
 * Small helper for adapting a function-based legacy retrieval implementation
 * without allowing it to choose its own source. The function receives the
 * source already selected by the ContextPlan.
 */
export function createRetrievalCapability(
  source: ContextSource,
  retrieve: (input: RetrievalCapabilityRequest) => Promise<RetrievalCapabilityResult>,
): RetrievalCapability {
  return { source, retrieve };
}
