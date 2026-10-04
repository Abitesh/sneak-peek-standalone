/**
 * Canonical context-planning contracts for Natively Intelligence.
 *
 * The planner answers one question only:
 *   "What context is necessary to answer this turn correctly?"
 *
 * It does not retrieve, rank, embed, read files, inspect the screen, or call an
 * LLM.  Those are downstream capabilities.  This keeps context selection a
 * small, deterministic intelligence decision instead of a prompt-stuffing
 * operation.
 */

export type ContextSource =
  | 'none'
  | 'recent_conversation'
  | 'longer_conversation'
  | 'meeting_transcript'
  | 'personal_knowledge'
  | 'project_knowledge'
  | 'my_files'
  | 'mode_documents'
  | 'rag'
  | 'screen'
  | 'profile'
  | 'structured_knowledge';

export type ContextRequirement = 'required' | 'optional' | 'not_required' | 'forbidden';

export interface ContextSourceDecision {
  source: ContextSource;
  requirement: ContextRequirement;
  reason: string;
}

export interface ContextPlan {
  /** Exhaustive source-by-source decision. */
  sources: ContextSourceDecision[];
  requiredSources: ContextSource[];
  optionalSources: ContextSource[];
  forbiddenSources: ContextSource[];
  notRequiredSources: ContextSource[];
  /** Empty required/optional sources means no external context is needed. */
  needsContext: boolean;
  /** General model knowledge is allowed when the answer does not need private/user context. */
  generalKnowledgeAllowed: boolean;
  /** Retrieval is a downstream tool decision derived from the context plan. */
  retrievalRequired: boolean;
  retrievalSources: ContextSource[];
  /** Human-readable planning rationale, safe for diagnostics; contains no source content. */
  rationale: string[];
}

export interface ContextAvailability {
  recentConversation: boolean;
  longerConversation?: boolean;
  meetingTranscript?: boolean;
  personalKnowledge?: boolean;
  projectKnowledge?: boolean;
  myFiles?: boolean;
  modeDocuments?: boolean;
  rag?: boolean;
  screen?: boolean;
  profile?: boolean;
  structuredKnowledge?: boolean;
}
