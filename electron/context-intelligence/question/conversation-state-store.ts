// electron/context-intelligence/question/conversation-state-store.ts
//
// The canonical process-wide home for V3 conversation state.
//
// Change 3: conversation is now structured state, not a giant formatted blob.
// Each session owns an ordered list of atomic turns with role, speaker, text,
// timestamp, stable turn id, finalization state, source and optional metadata.
// The older referent fields in ConversationState remain alongside that history
// for compatibility with the proven follow-up resolver. They are DERIVED state;
// `turns` is the canonical conversational record.
//
// WHY globalThis
// Same rule as the existing V3 state store: esbuild can inline this module per
// entry bundle. A globalThis-backed store keeps co-loaded bundle copies on the
// same state instance.

import type { EvidenceScope } from '../contracts/types';
import {
  advance,
  resolveReference,
  type ConversationState,
  type ConversationTurn,
  type ConversationTurnRole,
  type ConversationTurnSource,
  type ResolvedReference,
  emptyState,
} from './conversation-state';

const STORE_KEY = '__nativelyV3ConversationStateV2__';
const TURN_SEQUENCE_KEY = '__nativelyV3ConversationTurnSequenceV1__';
const MAX_SESSIONS = 32;
export const MAX_TURNS_PER_SESSION = 500;

type Store = Map<string, ConversationState>;

function store(): Store {
  const g = globalThis as unknown as Record<string, unknown>;
  let s = g[STORE_KEY] as Store | undefined;
  if (!s) { s = new Map(); g[STORE_KEY] = s; }
  return s;
}

function nextTurnId(): string {
  const g = globalThis as unknown as Record<string, unknown>;
  const next = typeof g[TURN_SEQUENCE_KEY] === 'number' ? (g[TURN_SEQUENCE_KEY] as number) + 1 : 1;
  g[TURN_SEQUENCE_KEY] = next;
  return `turn_${Date.now()}_${next}`;
}

function cloneMetadata(metadata: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!metadata) return undefined;
  try {
    if (typeof structuredClone === 'function') return structuredClone(metadata);
  } catch { /* fall through to shallow clone */ }
  return { ...metadata };
}

function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return {
    ...turn,
    ...(turn.metadata ? { metadata: cloneMetadata(turn.metadata) } : {}),
  };
}

function cloneState(state: ConversationState): ConversationState {
  return {
    ...state,
    turns: state.turns.map(cloneTurn),
    activeEntities: [...state.activeEntities],
    previousEvidenceIds: [...state.previousEvidenceIds],
    previousSourceIds: [...state.previousSourceIds],
    unresolvedReferences: [...state.unresolvedReferences],
    ...(state.previousDecision ? {
      previousDecision: {
        ...state.previousDecision,
        selectedSources: state.previousDecision.selectedSources.map((s) => ({ ...s })),
        ignoredSources: state.previousDecision.ignoredSources.map((s) => ({ ...s })),
      },
    } : {}),
  };
}

function ensureSessionCapacity(s: Store): void {
  while (s.size > MAX_SESSIONS) {
    const oldest = s.keys().next().value;
    if (oldest === undefined) break;
    s.delete(oldest);
  }
}

function syntheticScope(sessionId: string): EvidenceScope {
  return { userId: 'local', sessionId };
}

function getInternal(sessionId: string): ConversationState | null {
  return store().get(sessionId) ?? null;
}

export function getConversationState(sessionId: string): ConversationState | null {
  const state = getInternal(sessionId);
  return state ? cloneState(state) : null;
}

/** Number of currently retained canonical sessions. */
export function getConversationSessionCount(): number {
  return store().size;
}

export interface AppendConversationTurnInput {
  sessionId: string;
  text: string;
  role: ConversationTurnRole;
  speaker: string;
  timestamp?: number;
  finalized?: boolean;
  source?: ConversationTurnSource;
  requestSequence?: number;
  metadata?: Readonly<Record<string, unknown>>;
  turnId?: string;
  scope?: EvidenceScope;
}

/**
 * Append one atomic turn and make it the current/newest turn.
 *
 * Reads are clone-on-return; callers can never mutate the store by changing a
 * returned object or array. Empty turns are rejected because a blank segment is
 * not useful conversational state.
 */
export function appendConversationTurn(input: AppendConversationTurnInput): ConversationTurn {
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('Conversation turn text cannot be empty');

  const s = store();
  const existing = s.get(input.sessionId);
  const base = existing ?? emptyState(input.scope ?? syntheticScope(input.sessionId));
  const turn: ConversationTurn = {
    id: input.turnId?.trim() || nextTurnId(),
    role: input.role,
    speaker: String(input.speaker ?? input.role),
    text,
    timestamp: typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
    finalized: input.finalized !== false,
    source: input.source ?? 'unknown',
    ...(typeof input.requestSequence === 'number' && Number.isFinite(input.requestSequence)
      ? { requestSequence: input.requestSequence }
      : {}),
    ...(input.metadata ? { metadata: cloneMetadata(input.metadata) } : {}),
  };

  const turns = [...base.turns, turn].slice(-MAX_TURNS_PER_SESSION);
  const next: ConversationState = {
    ...base,
    turns,
    currentTurnId: turn.id,
    ...(typeof turn.requestSequence === 'number' ? { currentRequestSequence: turn.requestSequence } : {}),
    updatedAt: Math.max(base.updatedAt || 0, turn.timestamp),
  };
  s.delete(input.sessionId);
  s.set(input.sessionId, next);
  ensureSessionCapacity(s);
  return cloneTurn(turn);
}

export interface UpdateConversationTurnInput {
  sessionId: string;
  turnId: string;
  text?: string;
  speaker?: string;
  timestamp?: number;
  finalized?: boolean;
  source?: ConversationTurnSource;
  requestSequence?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Update one existing turn without changing its stable id. */
export function updateConversationTurn(input: UpdateConversationTurnInput): ConversationTurn | null {
  const s = store();
  const state = s.get(input.sessionId);
  if (!state) return null;
  const index = state.turns.findIndex((turn) => turn.id === input.turnId);
  if (index < 0) return null;

  const current = state.turns[index];
  const nextTurn: ConversationTurn = {
    ...current,
    ...(input.text !== undefined ? { text: String(input.text).trim() } : {}),
    ...(input.speaker !== undefined ? { speaker: String(input.speaker) } : {}),
    ...(input.timestamp !== undefined && Number.isFinite(input.timestamp) ? { timestamp: input.timestamp } : {}),
    ...(input.finalized !== undefined ? { finalized: input.finalized } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.requestSequence !== undefined && Number.isFinite(input.requestSequence)
      ? { requestSequence: input.requestSequence }
      : {}),
    ...(input.metadata !== undefined ? { metadata: cloneMetadata(input.metadata) } : {}),
  } as ConversationTurn;
  if (!nextTurn.text) return null;

  const turns = state.turns.map((turn, i) => i === index ? nextTurn : turn);
  const nextState: ConversationState = {
    ...state,
    turns,
    ...(state.currentTurnId === input.turnId ? { currentRequestSequence: nextTurn.requestSequence } : {}),
    updatedAt: Math.max(state.updatedAt || 0, nextTurn.timestamp),
  };
  s.set(input.sessionId, nextState);
  return cloneTurn(nextTurn);
}

export function getConversationTurn(sessionId: string, turnId: string): ConversationTurn | null {
  const state = getInternal(sessionId);
  const turn = state?.turns.find((candidate) => candidate.id === turnId);
  return turn ? cloneTurn(turn) : null;
}

/** Recent ordered turns, newest last. */
export function getRecentConversationTurns(sessionId: string, limit = 10): ConversationTurn[] {
  const state = getInternal(sessionId);
  if (!state) return [];
  const n = Math.max(0, Math.floor(limit));
  return state.turns.slice(-n).map(cloneTurn);
}

export interface ConversationWindowOptions {
  /** Time window measured backwards from the newest stored turn. */
  seconds?: number;
  /** Include interim/non-finalized transcript segments when true. */
  includeNonFinalized?: boolean;
  /** Optional maximum number of turns after time/finalization filtering. */
  limit?: number;
}

/**
 * Retrieve a time-bounded conversation window without mutating state.
 * The cutoff is relative to the newest stored turn, matching the useful part
 * of NexQ's sliding transcript buffer while retaining finalized/interim state.
 */
export function getConversationWindow(sessionId: string, options: ConversationWindowOptions = {}): ConversationTurn[] {
  const state = getInternal(sessionId);
  if (!state || state.turns.length === 0) return [];

  const includeNonFinalized = options.includeNonFinalized !== false;
  const seconds = typeof options.seconds === 'number' && Number.isFinite(options.seconds)
    ? Math.max(0, options.seconds)
    : undefined;
  const newestTimestamp = state.turns[state.turns.length - 1].timestamp;
  const cutoff = seconds === undefined ? Number.NEGATIVE_INFINITY : newestTimestamp - (seconds * 1000);

  let turns = state.turns.filter((turn) =>
    (includeNonFinalized || turn.finalized) && turn.timestamp >= cutoff,
  );
  if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
    turns = turns.slice(-Math.max(0, Math.floor(options.limit)));
  }
  return turns.map(cloneTurn);
}

/** The newest/current turn, if a session has one. */
export function getCurrentConversationTurn(sessionId: string): ConversationTurn | null {
  const state = getInternal(sessionId);
  if (!state?.currentTurnId) return null;
  const turn = state.turns.find((candidate) => candidate.id === state.currentTurnId);
  return turn ? cloneTurn(turn) : null;
}

/** All turns belonging to one request sequence, newest last. */
export function getConversationTurnsByRequestSequence(sessionId: string, requestSequence: number): ConversationTurn[] {
  const state = getInternal(sessionId);
  if (!state) return [];
  return state.turns
    .filter((turn) => turn.requestSequence === requestSequence)
    .map(cloneTurn);
}

export interface AdvanceTurnInput {
  sessionId: string;
  scope: EvidenceScope;
  question: string;
  evidenceIds?: string[];
  sourceIds?: string[];
  decision?: import('../contracts/types').PriorTurnDecision;
  requestSequence?: number;
  turnId?: string;
  timestamp?: number;
  finalized?: boolean;
  speaker?: string;
  source?: ConversationTurnSource;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Advance after a decided turn and append its user/interviewer turn. */
export function advanceConversationState(input: AdvanceTurnInput): ConversationState {
  const s = store();
  const previous = s.get(input.sessionId) ?? null;
  let next = advance(previous, {
    scope: input.scope,
    question: input.question,
    evidenceIds: input.evidenceIds,
    sourceIds: input.sourceIds,
    decision: input.decision,
    at: input.timestamp ?? Date.now(),
  });

  s.set(input.sessionId, next);

  if (String(input.question ?? '').trim()) {
    appendConversationTurn({
      sessionId: input.sessionId,
      text: input.question,
      role: input.source === 'transcript' || input.source === 'live-transcript' || input.speaker === 'interviewer'
        ? 'interviewer'
        : 'user',
      speaker: input.speaker ?? (input.source === 'transcript' || input.source === 'live-transcript' ? 'interviewer' : 'user'),
      timestamp: input.timestamp ?? Date.now(),
      finalized: input.finalized !== false,
      source: input.source ?? 'manual',
      requestSequence: input.requestSequence,
      metadata: input.metadata,
      turnId: input.turnId,
      scope: input.scope,
    });
    next = s.get(input.sessionId)!;
  } else {
    // No conversational text was appended, but the derived state still belongs
    // to this request/scope.
    if (typeof input.requestSequence === 'number') {
      next = { ...next, currentRequestSequence: input.requestSequence };
      s.set(input.sessionId, next);
    }
  }

  ensureSessionCapacity(s);
  return cloneState(s.get(input.sessionId)!);
}

/**
 * Attach the completed assistant answer to the same request as the current turn.
 * The answer is a real structured turn; previousAnswerSummary remains a bounded
 * referent field for the existing resolver and is never treated as evidence.
 */
export function recordAnswerSummary(sessionId: string, answerText: string): void {
  const s = store();
  const cur = s.get(sessionId);
  if (!cur) return;
  const text = String(answerText ?? '').trim();
  if (!text) return;

  const summary = text.slice(0, 280);
  const next = {
    ...cur,
    previousAnswerSummary: summary || undefined,
  };
  s.set(sessionId, next);

  appendConversationTurn({
    sessionId,
    text,
    role: 'assistant',
    speaker: 'assistant',
    timestamp: Date.now(),
    finalized: true,
    source: 'assistant',
    requestSequence: cur.currentRequestSequence,
    metadata: { conversationStateAnswer: true },
    scope: syntheticScope(sessionId),
  });
}

/** Resolve a question against the session's state. Pure pass-through when no state. */
export function resolveAgainstSession(sessionId: string, question: string): ResolvedReference {
  return resolveReference(question, getInternal(sessionId));
}

/** Mode switches and session resets must not carry referents or turns across. */
export function clearConversationState(sessionId?: string): void {
  if (sessionId === undefined) store().clear();
  else store().delete(sessionId);
}
