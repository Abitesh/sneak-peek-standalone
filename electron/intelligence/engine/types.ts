/**
 * Central, provider-independent contracts for the Natively Intelligence Engine.
 *
 * This module intentionally contains data contracts only.  It does not import
 * RAG, Context OS, provider, renderer, or Electron implementation types.
 * Those systems can be adapted to these contracts in later changes without
 * making the engine boundary depend on any one implementation.
 */

import type { RecentConversationContext } from './TranscriptContext';
import type { TurnUnderstanding } from '../../context-intelligence/question/question-resolver';
import type { ContextPlan, ContextSource } from './ContextTypes';
import type { EvidencePack } from '../context-os/evidencePack';

export type IntelligenceSurface =
  | 'manual-chat'
  | 'what-to-answer'
  | 'meeting-overlay'
  | 'follow-up'
  | 'recap'
  | 'clarify'
  | 'assist'
  | 'screenshot'
  | 'developer-test';

export type IntelligenceIntent =
  | 'general-question'
  | 'personal-question'
  | 'project-question'
  | 'document-question'
  | 'meeting-question'
  | 'screen-question'
  | 'coding-task'
  | 'system-design'
  | 'follow-up'
  | 'recap'
  | 'clarification'
  | 'ambiguous';

export type IntelligenceResponseType =
  | 'answer'
  | 'spoken-answer'
  | 'coding-answer'
  | 'follow-up-questions'
  | 'recap'
  | 'clarification'
  | 'silent';

export type IntelligenceContextKind =
  | 'conversation'
  | 'transcript'
  | 'manual-question'
  | 'screen'
  | 'mode'
  | 'project'
  | 'profile'
  | 'files'
  | 'memory';

export interface NativelyConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt?: number;
}

export interface NativelyTranscriptContext {
  text: string;
  turns?: NativelyConversationTurn[];
  startedAt?: number;
  endedAt?: number;
  source?: 'live' | 'meeting' | 'imported';
}

export interface NativelyScreenContext {
  text?: string;
  imageId?: string;
  capturedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface NativelyActiveContext {
  modeId?: string;
  modeName?: string;
  projectId?: string;
  projectName?: string;
  profileId?: string;
  profileName?: string;
}

export interface NativelyResponseShapeRequest {
  type?: IntelligenceResponseType;
  maxTokens?: number;
  maxSentences?: number;
  durationSeconds?: number;
  spoken?: boolean;
  concise?: boolean;
  detailed?: boolean;
}

export interface NativelyProviderPreferences {
  preferredProvider?: string;
  preferredModel?: string;
  allowedProviders?: string[];
  allowFallback?: boolean;
  maxAttempts?: number;
}

export interface NativelyContextPermissions {
  conversation: boolean;
  transcript: boolean;
  screen: boolean;
  mode: boolean;
  project: boolean;
  profile: boolean;
  files: boolean;
  memory: boolean;
  generalKnowledge: boolean;
}

export interface NativelyIntelligenceRequest {
  requestId: string;
  sessionId: string;
  surface: IntelligenceSurface;
  userMessage: string;
  currentTurn: NativelyConversationTurn;
  recentConversation: NativelyConversationTurn[];
  transcriptContext?: NativelyTranscriptContext;
  manualQuestion?: string;
  screenContext?: NativelyScreenContext;
  activeContext?: NativelyActiveContext;
  cancellationSignal?: AbortSignal;
  responseShape?: NativelyResponseShapeRequest;
  providerPreferences?: NativelyProviderPreferences;
  contextPermissions: NativelyContextPermissions;
}

export interface NativelySelectedContextItem {
  kind: IntelligenceContextKind;
  selected: boolean;
  reason: string;
  reference?: string;
}

export interface NativelySelectedContext {
  items: NativelySelectedContextItem[];
}

export type NativelyRetrievalMode = 'none' | 'keyword' | 'semantic' | 'hybrid';

export interface NativelyRetrievalPlan {
  shouldRetrieve: boolean;
  mode: NativelyRetrievalMode;
  query: string;
  sources: ContextSource[];
  maximumResults: number;
}

export interface NativelyEvidenceItem {
  id: string;
  source: ContextSource;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface NativelyEvidence {
  items: NativelyEvidenceItem[];
  sufficient: boolean;
}

export interface NativelyPrompt {
  system?: string;
  user: string;
  context?: string;
  /** Exact provider-facing prompt produced by PromptAssembler. */
  finalPrompt: string;
  /** Evidence identities rendered into finalPrompt, in render order. */
  includedEvidenceIds?: string[];
  /** Prompt sections rendered into finalPrompt. */
  includedSections?: string[];
}

export type NativelyProviderAttemptStatus =
  | 'not-started'
  | 'started'
  | 'streaming'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface NativelyProviderAttempt {
  provider?: string;
  model?: string;
  status: NativelyProviderAttemptStatus;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export type NativelyStreamLifecycleStatus =
  | 'not-started'
  | 'ready'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NativelyStreamLifecycle {
  status: NativelyStreamLifecycleStatus;
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
  tokenCount?: number;
}

export interface NativelyDiagnostics {
  traceId: string;
  stages: string[];
  warnings: string[];
}

export interface NativelyFinalAnswer {
  text: string;
  completed: boolean;
}

export interface NativelyIntelligenceResult {
  requestId: string;
  resolvedQuestion: string;
  /** Canonical Change 5 understanding result used by downstream planning. */
  turnUnderstanding: TurnUnderstanding;
  intent: IntelligenceIntent;
  responseType: IntelligenceResponseType;
  selectedContext: NativelySelectedContext;
  /** Canonical Change 6 decision: what context is actually necessary. */
  contextPlan: ContextPlan;
  /** Bounded recent conversation; retrieval and long-term memory are separate layers. */
  conversationContext: RecentConversationContext;
  retrievalPlan: NativelyRetrievalPlan;
  evidence: NativelyEvidence;
  /** Canonical Change 8 evidence boundary consumed by prompt assembly. */
  evidencePack: EvidencePack;
  prompt: NativelyPrompt;
  providerAttempt: NativelyProviderAttempt;
  streamLifecycle: NativelyStreamLifecycle;
  diagnostics: NativelyDiagnostics;
  finalAnswer: NativelyFinalAnswer | null;
}
