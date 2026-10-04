import type {
  IntelligenceIntent,
  IntelligenceResponseType,
  NativelyIntelligenceRequest,
  NativelyIntelligenceResult,
  NativelySelectedContext,
  NativelyRetrievalPlan,
} from './types';

/**
 * Central entry boundary for Natively Intelligence.
 *
 * Change 2 deliberately stops at the contract/decision boundary.  It does not
 * call a provider or RAG implementation yet.  Later changes can replace the
 * small decision methods with the real understand → plan → retrieve → prompt
 * → generate pipeline without changing the request/result contract.
 */
export class NativelyIntelligenceEngine {
  async handle(request: NativelyIntelligenceRequest): Promise<NativelyIntelligenceResult> {
    const traceId = `${request.sessionId}:${request.requestId}`;
    const stages: string[] = [];

    if (request.cancellationSignal?.aborted) {
      stages.push('cancelled');
      return this.cancelledResult(request, traceId, stages);
    }

    stages.push('understand');
    const resolvedQuestion = this.resolveQuestion(request);
    const intent = this.resolveIntent(request, resolvedQuestion);
    const responseType = this.resolveResponseType(request, intent);

    stages.push('plan-context');
    const selectedContext = this.selectContext(request);

    stages.push('plan-retrieval');
    const retrievalPlan = this.planRetrieval(request, resolvedQuestion, intent, selectedContext);

    stages.push('build-evidence');
    stages.push('assemble-prompt');

    return {
      requestId: request.requestId,
      resolvedQuestion,
      intent,
      responseType,
      selectedContext,
      retrievalPlan,
      evidence: { items: [], sufficient: !retrievalPlan.shouldRetrieve },
      prompt: { user: resolvedQuestion },
      providerAttempt: { status: 'not-started' },
      streamLifecycle: { status: 'not-started' },
      diagnostics: {
        traceId,
        stages,
        warnings: [],
      },
      finalAnswer: null,
    };
  }

  private cancelledResult(
    request: NativelyIntelligenceRequest,
    traceId: string,
    stages: string[],
  ): NativelyIntelligenceResult {
    return {
      requestId: request.requestId,
      resolvedQuestion: this.resolveQuestion(request),
      intent: 'ambiguous',
      responseType: request.responseShape?.type ?? 'answer',
      selectedContext: { items: [] },
      retrievalPlan: {
        shouldRetrieve: false,
        mode: 'none',
        query: '',
        sources: [],
        maximumResults: 0,
      },
      evidence: { items: [], sufficient: false },
      prompt: { user: '' },
      providerAttempt: { status: 'cancelled' },
      streamLifecycle: { status: 'cancelled' },
      diagnostics: { traceId, stages, warnings: ['Request was cancelled before intelligence processing began'] },
      finalAnswer: null,
    };
  }

  private resolveQuestion(request: NativelyIntelligenceRequest): string {
    const candidates = [
      request.manualQuestion,
      request.userMessage,
      request.currentTurn.content,
    ];

    return candidates.find((value) => value?.trim())?.trim() ?? '';
  }

  private resolveIntent(
    request: NativelyIntelligenceRequest,
    question: string,
  ): IntelligenceIntent {
    const lower = question.toLowerCase();

    if (request.surface === 'follow-up' || /\b(this|that|it|they|them|above)\b/.test(lower)) {
      return 'follow-up';
    }
    if (request.surface === 'recap') return 'recap';
    if (request.surface === 'clarify') return 'clarification';
    if (request.screenContext && /\b(this|screen|image|shown|displayed)\b/.test(lower)) {
      return 'screen-question';
    }
    if (/\b(code|coding|implement|debug|algorithm|function|class)\b/.test(lower)) {
      return 'coding-task';
    }
    if (request.activeContext?.projectId && /\b(project|repo|repository|implementation)\b/.test(lower)) {
      return 'project-question';
    }
    if (request.transcriptContext && /\b(meeting|said|mentioned|discussed)\b/.test(lower)) {
      return 'meeting-question';
    }
    if (request.manualQuestion || request.activeContext?.profileId) {
      return 'personal-question';
    }
    return 'general-question';
  }

  private resolveResponseType(
    request: NativelyIntelligenceRequest,
    intent: IntelligenceIntent,
  ): IntelligenceResponseType {
    if (request.responseShape?.type) return request.responseShape.type;
    if (intent === 'coding-task') return 'coding-answer';
    if (intent === 'follow-up') return 'answer';
    if (intent === 'recap') return 'recap';
    if (intent === 'clarification') return 'clarification';
    if (request.responseShape?.spoken) return 'spoken-answer';
    return 'answer';
  }

  private selectContext(request: NativelyIntelligenceRequest): NativelySelectedContext {
    const p = request.contextPermissions;
    return {
      items: [
        { kind: 'conversation', selected: p.conversation, reason: p.conversation ? 'Conversation context permitted' : 'Conversation context disabled' },
        { kind: 'transcript', selected: Boolean(p.transcript && request.transcriptContext), reason: request.transcriptContext && p.transcript ? 'Transcript context available and permitted' : 'No permitted transcript context' },
        { kind: 'manual-question', selected: Boolean(request.manualQuestion), reason: request.manualQuestion ? 'Explicit manual question supplied' : 'No separate manual question supplied' },
        { kind: 'screen', selected: Boolean(p.screen && request.screenContext), reason: request.screenContext && p.screen ? 'Screen context available and permitted' : 'No permitted screen context' },
        { kind: 'mode', selected: Boolean(p.mode && request.activeContext?.modeId), reason: request.activeContext?.modeId && p.mode ? 'Active mode available and permitted' : 'No permitted active mode' },
        { kind: 'project', selected: Boolean(p.project && request.activeContext?.projectId), reason: request.activeContext?.projectId && p.project ? 'Active project available and permitted' : 'No permitted active project' },
        { kind: 'profile', selected: Boolean(p.profile && request.activeContext?.profileId), reason: request.activeContext?.profileId && p.profile ? 'Active profile available and permitted' : 'No permitted active profile' },
        { kind: 'files', selected: p.files, reason: p.files ? 'File context permitted' : 'File context disabled' },
        { kind: 'memory', selected: p.memory, reason: p.memory ? 'Memory context permitted' : 'Memory context disabled' },
      ],
    };
  }

  private planRetrieval(
    request: NativelyIntelligenceRequest,
    question: string,
    intent: IntelligenceIntent,
    selectedContext: NativelySelectedContext,
  ): NativelyRetrievalPlan {
    const sourceKinds = selectedContext.items
      .filter((item) => item.selected && item.kind !== 'conversation' && item.kind !== 'manual-question')
      .map((item) => item.kind);

    const intentNeedsContext = new Set<IntelligenceIntent>([
      'personal-question',
      'project-question',
      'document-question',
      'meeting-question',
      'screen-question',
      'follow-up',
    ]).has(intent);
    const shouldRetrieve = intentNeedsContext && sourceKinds.length > 0;

    return {
      shouldRetrieve,
      mode: shouldRetrieve ? 'hybrid' : 'none',
      query: question,
      sources: sourceKinds,
      maximumResults: shouldRetrieve ? 8 : 0,
    };
  }
}
