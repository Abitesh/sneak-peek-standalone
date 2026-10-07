import type { NativelyIntelligenceRequest } from './types';
import type { TurnUnderstanding } from '../../context-intelligence/question/question-resolver';
import type { ContextAvailability, ContextPlan, ContextRequirement, ContextSource, ContextSourceDecision } from './ContextTypes';

const SOURCES: ContextSource[] = [
  'recent_conversation',
  'longer_conversation',
  'meeting_transcript',
  'personal_knowledge',
  'project_knowledge',
  'my_files',
  'mode_documents',
  'rag',
  'screen',
  'profile',
  'structured_knowledge',
];

const PRIVATE_SOURCES = new Set<ContextSource>([
  'personal_knowledge',
  'project_knowledge',
  'my_files',
  'mode_documents',
  'profile',
  'structured_knowledge',
]);

export interface ContextPlannerInput {
  request: NativelyIntelligenceRequest;
  understanding: TurnUnderstanding;
  availability?: Partial<ContextAvailability>;
}

function available(request: NativelyIntelligenceRequest, source: ContextSource, a: Partial<ContextAvailability>): boolean {
  switch (source) {
    case 'recent_conversation':
      return Boolean(request.contextPermissions.conversation && (a.recentConversation ?? true));
    case 'longer_conversation':
      return Boolean(request.contextPermissions.conversation && (a.longerConversation ?? false));
    case 'meeting_transcript':
      return Boolean(request.contextPermissions.transcript && (a.meetingTranscript ?? request.transcriptContext?.source === 'meeting'));
    case 'personal_knowledge':
      return Boolean(request.contextPermissions.memory && (a.personalKnowledge ?? true));
    case 'project_knowledge':
      return Boolean(request.contextPermissions.project && request.activeContext?.projectId && (a.projectKnowledge ?? true));
    case 'my_files':
      return Boolean(request.contextPermissions.files && (a.myFiles ?? Boolean(request.activeContext?.projectId || request.manualQuestion)));
    case 'mode_documents':
      return Boolean(request.contextPermissions.mode && request.activeContext?.modeId && (a.modeDocuments ?? true));
    case 'rag':
      return Boolean(a.rag ?? true);
    case 'screen':
      return Boolean(request.contextPermissions.screen && request.screenContext && (a.screen ?? true));
    case 'profile':
      return Boolean(request.contextPermissions.profile && request.activeContext?.profileId && (a.profile ?? true));
    case 'structured_knowledge':
      return Boolean(request.contextPermissions.memory && (a.structuredKnowledge ?? true));
    case 'none':
      return true;
  }
}

function permissionAllows(request: NativelyIntelligenceRequest, source: ContextSource): boolean {
  switch (source) {
    case 'recent_conversation':
    case 'longer_conversation':
      return request.contextPermissions.conversation;
    case 'meeting_transcript':
      return request.contextPermissions.transcript;
    case 'personal_knowledge':
    case 'structured_knowledge':
      return request.contextPermissions.memory;
    case 'project_knowledge':
      return request.contextPermissions.project;
    case 'my_files':
      return request.contextPermissions.files;
    case 'mode_documents':
      return request.contextPermissions.mode;
    case 'screen':
      return request.contextPermissions.screen;
    case 'profile':
      return request.contextPermissions.profile;
    case 'rag':
      return true;
    case 'none':
      return true;
  }
}

function sourceReason(source: ContextSource, requirement: ContextRequirement, understanding: TurnUnderstanding): string {
  if (requirement === 'forbidden') {
    return 'Private or unrelated context is blocked for this turn';
  }
  if (requirement === 'required') {
    switch (source) {
      case 'recent_conversation': return understanding.followUp ? 'The turn refers to previous conversation context' : 'Recent conversation is needed to preserve answer continuity';
      case 'project_knowledge': return 'The question asks about the user\'s project or implementation';
      case 'personal_knowledge': return 'The question asks for user-specific knowledge or experience';
      case 'profile': return 'The question asks about the user/profile';
      case 'meeting_transcript': return 'The question depends on meeting/interview speech';
      case 'my_files': return 'The question explicitly depends on attached/user files';
      case 'mode_documents': return 'The active mode documents are the relevant source';
      case 'rag': return 'Retrieval is required to locate the authoritative supporting evidence';
      case 'screen': return 'The answer depends on the current screen/screenshot';
      case 'longer_conversation': return 'The immediate window is insufficient; broader conversation is required';
      case 'structured_knowledge': return 'Structured user knowledge is required for the answer';
      default: return 'Required by the turn understanding';
    }
  }
  if (requirement === 'optional') return 'Useful only if downstream evidence is needed';
  return 'Not necessary for the understood turn';
}

/**
 * Canonical context planner.
 *
 * This is deliberately deterministic and fail-closed for private sources:
 * a general question starts with private context forbidden, and a source is
 * opened only when the turn understanding explicitly requires that category.
 */
export function planContext(input: ContextPlannerInput): ContextPlan {
  const { request, understanding } = input;
  const a = input.availability ?? {};
  const required = new Set<ContextSource>();
  const optional = new Set<ContextSource>();
  const forbidden = new Set<ContextSource>();
  const rationale: string[] = [];

  // Start fail-closed. A general question must never inherit private sources
  // merely because the renderer says those sources are permitted.
  for (const source of PRIVATE_SOURCES) forbidden.add(source);

  const require = (source: ContextSource) => {
    forbidden.delete(source);
    optional.delete(source);
    required.add(source);
  };
  const maybe = (source: ContextSource) => {
    if (!required.has(source) && !forbidden.has(source)) optional.add(source);
  };

  const personalPrompt = /^(?:tell me about yourself|tell me about me|introduce yourself|introduce me)\b/i.test(understanding.question.trim());
  const conversationRecall = /\b(?:what did i say earlier|what did i say before|what did you say earlier|what did you say before|what did i mention earlier|what did i mention before|earlier conversation|previous conversation)\b/i.test(understanding.question);
  const meetingSurface = request.surface === 'meeting-overlay' || request.transcriptContext?.source === 'meeting';
  const meetingReference = /\b(?:in the meeting|during the meeting|on the call|interview|interviewer|they|he|she|we|said|mentioned|discussed|decided|agreed|asked|told|according to)\b/i.test(understanding.question);
  const meetingScopedTurn = Boolean(
    meetingSurface
    && request.contextPermissions.transcript
    && request.transcriptContext?.source === 'meeting'
    && (meetingReference || understanding.followUp || understanding.requiresMeetingContext),
  );

  switch (personalPrompt ? 'personal-question' : conversationRecall ? 'follow-up' : meetingScopedTurn ? 'meeting-question' : understanding.intent) {
    case 'project-question':
    case 'system-design':
      require('recent_conversation');
      require('project_knowledge');
      require('rag');
      rationale.push('Project/implementation intent requires project-specific evidence rather than generic knowledge.');
      break;
    case 'personal-question':
      require('recent_conversation');
      require('personal_knowledge');
      require('profile');
      rationale.push('Personal intent requires user-specific profile/knowledge.');
      break;
    case 'document-question':
      require('my_files');
      require('rag');
      // If a mode document is the explicit active source, allow it as the
      // canonical document layer too; otherwise it stays blocked.
      if (request.activeContext?.modeId) maybe('mode_documents');
      rationale.push('Document intent requires the relevant user/mode document and retrieval evidence.');
      break;
    case 'meeting-question':
      require('meeting_transcript');
      maybe('recent_conversation');
      rationale.push('Meeting intent requires transcript evidence.');
      break;
    case 'screen-question':
      require('screen');
      maybe('recent_conversation');
      rationale.push('Screen intent requires the captured screen/screenshot context.');
      break;
    case 'follow-up':
    case 'refinement':
      require('recent_conversation');
      // A follow-up may need the previous turn's source category, but this
      // planner does not guess at unrelated private stores. Change 7 can
      // propagate the prior ContextPlan explicitly.
      rationale.push('Follow-up/refinement requires recent conversation continuity.');
      break;
    case 'clarification':
      maybe('recent_conversation');
      rationale.push('Clarification can usually be answered from the current turn and immediate context.');
      break;
    case 'coding-request':
      // Code is not automatically project-specific. The Change 5 understanding
      // stage must classify project references before private project context is opened.
      rationale.push('Coding intent alone does not authorize project or private-file retrieval.');
      break;
    case 'general-question':
    case 'conversational-response':
    case 'ambiguous':
      rationale.push('No user-specific context is necessary from the current turn understanding.');
      break;
    default:
      rationale.push('No additional private context was justified by the current turn understanding.');
      break;
  }

  // Explicit screen/document/meeting signals can override a coarse intent only
  // when the corresponding source is actually present and permitted.
  if (understanding.requiresScreenContext && request.screenContext) require('screen');
  if (understanding.requiresMeetingContext && request.transcriptContext) require('meeting_transcript');
  if (understanding.requiresDocumentContext) require('my_files');
  if (understanding.requiresProjectContext) {
    require('project_knowledge');
    require('rag');
  }
  if (understanding.requiresPersonalContext) {
    require('personal_knowledge');
    require('profile');
  }

  // Availability/permissions never turn a forbidden source into an allowed
  // one. They only annotate required/optional sources as unavailable for the
  // downstream adapter. The plan itself remains the intelligence decision.
  const decisions: ContextSourceDecision[] = SOURCES.map((source) => {
    let requirement: ContextRequirement;
    if (required.has(source)) requirement = 'required';
    else if (optional.has(source)) requirement = 'optional';
    else if (forbidden.has(source)) requirement = 'forbidden';
    else requirement = 'not_required';

    const reason = sourceReason(source, requirement, understanding);
    return { source, requirement, reason };
  });

  // `none` is represented by an empty required/optional set. It is not a real
  // retrieval source and therefore never enters a retrieval query.
  const requiredSources = [...required].filter((source) => source !== 'none');
  const optionalSources = [...optional].filter((source) => source !== 'none');
  const forbiddenSources = [...forbidden].filter((source) => source !== 'none');
  const notRequiredSources = decisions
    .filter((d) => d.requirement === 'not_required')
    .map((d) => d.source);

  const retrievalSources = [...requiredSources, ...optionalSources].filter((source) => source === 'rag');
  const retrievalRequired = required.has('rag');

  // Required source availability is exposed as a rationale warning, but never
  // silently replaced with another private source. The retrieval adapter can
  // decide how to report missing evidence later.
  for (const source of requiredSources) {
    if (!available(request, source, a)) {
      rationale.push(`Required source "${source}" is not currently available; do not substitute unrelated private context.`);
    }
  }

  return {
    sources: decisions,
    requiredSources,
    optionalSources,
    forbiddenSources,
    notRequiredSources,
    needsContext: requiredSources.length > 0 || optionalSources.length > 0,
    generalKnowledgeAllowed: !requiredSources.some((source) => PRIVATE_SOURCES.has(source)) || understanding.intent === 'general-question',
    retrievalRequired,
    retrievalSources,
    rationale,
  };
}
