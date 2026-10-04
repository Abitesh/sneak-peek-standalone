import type { ConversationTurn } from '../../context-intelligence/question/conversation-state';
import {
  getConversationState,
  getCurrentConversationTurn,
  getConversationWindow,
} from '../../context-intelligence/question/conversation-state-store';

/**
 * Bounded conversational context for one intelligence request.
 *
 * This is deliberately NOT retrieval context. It only describes the small
 * amount of conversational state that should accompany the current turn.
 * Older conversation remains available in the canonical store and can be
 * retrieved separately when a later context-planning step decides it is useful.
 */
export interface RecentConversationContextRequest {
  sessionId: string;
  /** Explicit current turn wins over the store when the caller already has it. */
  currentTurn?: ConversationTurn;
  /** Optional current question used only as a fallback current-turn text. */
  currentQuestion?: string;
  /** Maximum immediate previous turns to expose. Default: 2. */
  immediatePreviousTurns?: number;
  /** Maximum recent turns to expose, including the current turn. Default: 12. */
  recentTurnLimit?: number;
  /** Recent time window in seconds. Default: 180. */
  recentWindowSeconds?: number;
  /** Interim transcript turns are useful for live question detection. Default: true. */
  includeNonFinalized?: boolean;
}

export interface RecentConversationContext {
  /** The turn currently being answered. Never dropped when it exists. */
  currentTurn: ConversationTurn | null;
  /** The immediately preceding turns, newest first. */
  immediatePreviousTurns: ConversationTurn[];
  /** Bounded recent conversation, ordered oldest → newest. */
  recentTranscriptWindow: ConversationTurn[];
  /** Number of older canonical turns excluded from this bounded context. */
  olderConversationTurnsAvailable: number;
  /** True when the current turn is represented in the returned window. */
  currentTurnIncluded: boolean;
  /** Explicit boundary: retrieval/long-term knowledge is not part of this layer. */
  longTermKnowledgeIncluded: false;
}

const DEFAULT_IMMEDIATE_PREVIOUS_TURNS = 2;
const DEFAULT_RECENT_TURN_LIMIT = 12;
const DEFAULT_RECENT_WINDOW_SECONDS = 180;

function clampCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value as number));
}

function uniqueById(turns: ConversationTurn[]): ConversationTurn[] {
  const seen = new Set<string>();
  const out: ConversationTurn[] = [];
  for (const turn of turns) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    out.push(turn);
  }
  return out;
}

/**
 * Return the bounded conversational context for one intelligence request.
 *
 * Ordering is intentionally stable: immediatePreviousTurns is newest-first,
 * while recentTranscriptWindow is chronological. The current turn is always
 * selected separately and is forced into the window when a caller supplies a
 * current turn that has not been committed to the canonical store yet.
 */
export function getRecentConversationContext(
  request: RecentConversationContextRequest,
): RecentConversationContext {
  const recentLimit = clampCount(request.recentTurnLimit, DEFAULT_RECENT_TURN_LIMIT);
  const previousLimit = clampCount(
    request.immediatePreviousTurns,
    DEFAULT_IMMEDIATE_PREVIOUS_TURNS,
  );
  const windowSeconds = Number.isFinite(request.recentWindowSeconds)
    ? Math.max(0, request.recentWindowSeconds as number)
    : DEFAULT_RECENT_WINDOW_SECONDS;
  const includeNonFinalized = request.includeNonFinalized !== false;

  const state = getConversationState(request.sessionId);
  const storedCurrent = getCurrentConversationTurn(request.sessionId);
  const currentTurn = request.currentTurn ?? storedCurrent ?? (
    request.currentQuestion?.trim()
      ? {
          id: `request-current:${request.sessionId}`,
          role: 'user' as const,
          speaker: 'user',
          text: request.currentQuestion.trim(),
          timestamp: Date.now(),
          finalized: true,
          source: 'manual' as const,
        }
      : null
  );

  let recent = getConversationWindow(request.sessionId, {
    seconds: windowSeconds,
    limit: recentLimit,
    includeNonFinalized,
  });

  // A live/interim current turn may not have reached the canonical store yet.
  // It must never disappear merely because the store is one event behind.
  if (currentTurn && !recent.some((turn) => turn.id === currentTurn.id)) {
    recent = [...recent, currentTurn];
  }

  recent = uniqueById(recent).sort((a, b) => a.timestamp - b.timestamp);

  // Enforce the hard turn bound while never losing an explicitly supplied
  // current turn when the window has room for at least one turn.
  if (recentLimit === 0) {
    recent = [];
  } else if (recent.length > recentLimit) {
    const withoutCurrent = currentTurn
      ? recent.filter((turn) => turn.id !== currentTurn.id)
      : recent;
    recent = withoutCurrent.slice(-(recentLimit - (currentTurn && recent.some((turn) => turn.id === currentTurn.id) ? 1 : 0)));
    if (currentTurn) {
      recent.push(currentTurn);
      recent = uniqueById(recent).sort((a, b) => a.timestamp - b.timestamp).slice(-recentLimit);
      if (!recent.some((turn) => turn.id === currentTurn.id)) {
        recent = [...recent.slice(1), currentTurn];
      }
    }
  }

  const currentIndex = currentTurn
    ? recent.findIndex((turn) => turn.id === currentTurn.id)
    : -1;
  const prior = currentIndex >= 0
    ? recent.slice(0, currentIndex)
    : recent.filter((turn) => turn.id !== currentTurn?.id);
  const immediatePreviousTurns = prior.slice(-previousLimit).reverse();

  const totalCanonicalTurns = state?.turns.length ?? 0;
  const recentIds = new Set(recent.map((turn) => turn.id));
  const olderConversationTurnsAvailable = Math.max(
    0,
    totalCanonicalTurns - recent.filter((turn) => state?.turns.some((candidate) => candidate.id === turn.id)).length,
  );

  return {
    currentTurn,
    immediatePreviousTurns,
    recentTranscriptWindow: recent,
    olderConversationTurnsAvailable,
    currentTurnIncluded: currentTurn ? recentIds.has(currentTurn.id) : false,
    longTermKnowledgeIncluded: false,
  };
}
