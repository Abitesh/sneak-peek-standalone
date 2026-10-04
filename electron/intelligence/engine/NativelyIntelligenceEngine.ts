import type {
  IntelligenceIntent,
  IntelligenceResponseType,
  NativelyIntelligenceRequest,
  NativelyIntelligenceResult,
  NativelySelectedContext,
  NativelyRetrievalPlan,
} from './types';
import { getRecentConversationContext } from './TranscriptContext';
import type { ConversationTurn } from '../../context-intelligence/question/conversation-state';
import { getConversationState } from '../../context-intelligence/question/conversation-state-store';
import { understandTurn } from '../../context-intelligence/question/question-resolver';
import { planContext } from './ContextPlanner';
import type { ContextSource } from './ContextTypes';
import { RetrievalCoordinator } from './RetrievalCoordinator';
import { buildEvidencePackFromNativelyEvidence } from '../context-os/evidencePack';

/**
 * Central entry boundary for Natively Intelligence.
 *
 * Change 2 deliberately stops at the contract/decision boundary.  It does not
 * call a provider or RAG implementation yet.  Later changes can replace the
 * small decision methods with the real understand → plan → retrieve → prompt
 * → generate pipeline without changing the request/result contract.
 */
export class NativelyIntelligenceEngine {
  private readonly retrievalCoordinator: RetrievalCoordinator;

  constructor(retrievalCoordinator?: RetrievalCoordinator) {
    this.retrievalCoordinator = retrievalCoordinator ?? new RetrievalCoordinator();
  }

  async handle(request: NativelyIntelligenceRequest): Promise<NativelyIntelligenceResult> {
    const traceId = `${request.sessionId}:${request.requestId}`;
    const stages: string[] = [];

    if (request.cancellationSignal?.aborted) {
      stages.push('cancelled');
      return this.cancelledResult(request, traceId, stages);
    }

    stages.push('understand');
    const resolvedQuestion = this.resolveQuestion(request);
    const turnUnderstanding = understandTurn({
      manualQuestion: request.manualQuestion ?? request.userMessage,
      selectedText: request.manualQuestion,
      sessionId: request.sessionId,
      conversationState: getConversationState(request.sessionId),
      hasScreenContext: Boolean(request.screenContext),
      transcript: request.transcriptContext?.turns?.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'interviewer',
        text: turn.content,
        timestamp: turn.createdAt ?? Date.now(),
      })),
    });
    const intent = this.mapIntent(turnUnderstanding.intent);
    const responseType = this.resolveResponseType(request, intent);

    stages.push('plan-context');
    const conversationContext = getRecentConversationContext({
      sessionId: request.sessionId,
      currentTurn: this.toConversationTurn(request.currentTurn),
      currentQuestion: request.userMessage,
    });
    const contextPlan = planContext({
      request,
      understanding: turnUnderstanding,
      availability: {
        recentConversation: conversationContext.immediatePreviousTurns.length > 0 || Boolean(conversationContext.currentTurnIncluded),
        longerConversation: Boolean(conversationContext.olderConversationTurnsAvailable),
        meetingTranscript: request.transcriptContext?.source === 'meeting',
        screen: Boolean(request.screenContext),
      },
    });
    const selectedContext = this.projectSelectedContext(request, contextPlan);

    stages.push('plan-retrieval');
    const retrievalPlan = this.planRetrieval(resolvedQuestion, contextPlan);

    stages.push('retrieve');
    const retrievalResult = await this.retrievalCoordinator.retrieve(
      contextPlan,
      request,
      resolvedQuestion,
    );

    stages.push('build-evidence');
    const evidencePack = buildEvidencePackFromNativelyEvidence({
      turnId: request.currentTurn.id || request.requestId,
      query: turnUnderstanding.question || resolvedQuestion,
      contextPlan,
      evidence: retrievalResult.evidence,
    });
    stages.push('assemble-prompt');

    return {
      requestId: request.requestId,
      resolvedQuestion: turnUnderstanding.question || resolvedQuestion,
      turnUnderstanding,
      intent,
      responseType,
      selectedContext,
      contextPlan,
      conversationContext,
      retrievalPlan,
      evidence: retrievalResult.evidence,
      evidencePack,
      prompt: { user: resolvedQuestion },
      providerAttempt: { status: 'not-started' },
      streamLifecycle: { status: 'not-started' },
      diagnostics: {
        traceId,
        stages,
        warnings: retrievalResult.trace.callCount === 0 && contextPlan.retrievalRequired
          ? ['Retrieval was planned but no matching retrieval capability was registered']
          : [],
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
      turnUnderstanding: understandTurn({
        manualQuestion: request.manualQuestion ?? request.userMessage,
        sessionId: request.sessionId,
        conversationState: getConversationState(request.sessionId),
        hasScreenContext: Boolean(request.screenContext),
      }),
      intent: 'ambiguous',
      responseType: request.responseShape?.type ?? 'answer',
      selectedContext: { items: [] },
      contextPlan: planContext({
        request,
        understanding: understandTurn({
          manualQuestion: request.manualQuestion ?? request.userMessage,
          sessionId: request.sessionId,
          conversationState: getConversationState(request.sessionId),
          hasScreenContext: Boolean(request.screenContext),
        }),
      }),
      conversationContext: getRecentConversationContext({
        sessionId: request.sessionId,
        currentTurn: this.toConversationTurn(request.currentTurn),
        currentQuestion: request.userMessage,
      }),
      retrievalPlan: {
        shouldRetrieve: false,
        mode: 'none',
        query: '',
        sources: [],
        maximumResults: 0,
      },
      evidence: { items: [], sufficient: false },
      evidencePack: buildEvidencePackFromNativelyEvidence({
        turnId: request.currentTurn.id || request.requestId,
        query: request.userMessage,
        contextPlan: planContext({
          request,
          understanding: understandTurn({
            manualQuestion: request.manualQuestion ?? request.userMessage,
            sessionId: request.sessionId,
            conversationState: getConversationState(request.sessionId),
            hasScreenContext: Boolean(request.screenContext),
          }),
        }),
        evidence: { items: [], sufficient: false },
        answerPolicy: 'ask_clarification',
      }),
      prompt: { user: '' },
      providerAttempt: { status: 'cancelled' },
      streamLifecycle: { status: 'cancelled' },
      diagnostics: { traceId, stages, warnings: ['Request was cancelled before intelligence processing began'] },
      finalAnswer: null,
    };
  }


  private toConversationTurn(turn: NativelyIntelligenceRequest['currentTurn']): ConversationTurn {
    return {
      id: turn.id,
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      speaker: turn.role,
      text: turn.content,
      timestamp: turn.createdAt ?? Date.now(),
      finalized: true,
      source: 'manual-chat',
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

  private mapIntent(intent: import('../../context-intelligence/question/question-resolver').TurnIntent): IntelligenceIntent {
    switch (intent) {
      case 'coding-request': return 'coding-task';
      case 'project-question': return 'project-question';
      case 'personal-question': return 'personal-question';
      case 'document-question': return 'document-question';
      case 'meeting-question': return 'meeting-question';
      case 'screen-question': return 'screen-question';
      case 'follow-up': return 'follow-up';
      case 'system-design': return 'system-design';
      case 'clarification': return 'clarification';
      case 'ambiguous': return 'ambiguous';
      default: return 'general-question';
    }
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

  private projectSelectedContext(
    request: NativelyIntelligenceRequest,
    plan: import('./ContextTypes').ContextPlan,
  ): NativelySelectedContext {
    const selected = new Set(plan.requiredSources);
    const optional = new Set(plan.optionalSources);
    const isSelected = (source: import('./ContextTypes').ContextSource) => selected.has(source) || optional.has(source);

    return {
      items: [
        { kind: 'conversation', selected: isSelected('recent_conversation') || isSelected('longer_conversation'), reason: plan.sources.find((s) => s.source === 'recent_conversation')?.reason ?? 'Not selected by context planner' },
        { kind: 'transcript', selected: isSelected('meeting_transcript'), reason: plan.sources.find((s) => s.source === 'meeting_transcript')?.reason ?? 'Not selected by context planner' },
        { kind: 'manual-question', selected: Boolean(request.manualQuestion), reason: request.manualQuestion ? 'Explicit manual question supplied' : 'No separate manual question supplied' },
        { kind: 'screen', selected: isSelected('screen'), reason: plan.sources.find((s) => s.source === 'screen')?.reason ?? 'Not selected by context planner' },
        { kind: 'mode', selected: isSelected('mode_documents'), reason: plan.sources.find((s) => s.source === 'mode_documents')?.reason ?? 'Not selected by context planner' },
        { kind: 'project', selected: isSelected('project_knowledge'), reason: plan.sources.find((s) => s.source === 'project_knowledge')?.reason ?? 'Not selected by context planner' },
        { kind: 'profile', selected: isSelected('profile'), reason: plan.sources.find((s) => s.source === 'profile')?.reason ?? 'Not selected by context planner' },
        { kind: 'files', selected: isSelected('my_files'), reason: plan.sources.find((s) => s.source === 'my_files')?.reason ?? 'Not selected by context planner' },
        { kind: 'memory', selected: isSelected('personal_knowledge') || isSelected('structured_knowledge'), reason: plan.sources.find((s) => s.source === 'personal_knowledge')?.reason ?? 'Not selected by context planner' },
      ],
    };
  }

  private planRetrieval(
    question: string,
    plan: import('./ContextTypes').ContextPlan,
  ): NativelyRetrievalPlan {
    const shouldRetrieve = plan.retrievalRequired;
    const sources: ContextSource[] = plan.requiredSources.filter((source) => source === 'rag');

    return {
      shouldRetrieve,
      mode: shouldRetrieve ? 'hybrid' : 'none',
      query: shouldRetrieve ? question : '',
      sources,
      maximumResults: shouldRetrieve ? 8 : 0,
    };
  }
}
