// electron/intelligence/ConversationMemoryService.ts
//
// Change 3 — compatibility facade over the canonical ConversationState store.
//
// The old implementation owned a second `Map<sessionId, StoredTurn[]>`, which
// meant the app had two conversational histories: this service's Q/A pairs and
// context-intelligence's referent state. That is exactly the split the new
// structured conversation state is meant to remove.
//
// This service keeps its public memory APIs for existing callers, but its source
// of truth is now electron/context-intelligence/question/conversation-state-store.
// Long-term recall remains an optional separate capability and is not part of
// the canonical short-term turn store.

import {
  appendConversationTurn,
  clearConversationState,
  getConversationState,
  getConversationSessionCount,
  getRecentConversationTurns,
  type AppendConversationTurnInput,
} from '../context-intelligence/question/conversation-state-store';
import type { ConversationTurnSource } from '../context-intelligence/question/conversation-state';

export interface ConversationTurn {
  sessionId: string;
  meetingId?: string;
  userMessage: string;
  assistantAnswer: string;
  mode?: string;
  timestamp: number;
  contextSourcesUsed?: string[];
  entities?: string[];
  requestSequence?: number;
  source?: ConversationTurnSource;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface StoredTurn extends ConversationTurn {
  id: string;
  summary: string;
  userTurnId?: string;
  assistantTurnId?: string;
}

/** Minimal long-term recall provider (Hindsight adapter implements this in Phase 16). */
export interface LongTermRecallProvider {
  recall(query: string, scope: { userId: string; sessionId?: string }, timeoutMs: number): Promise<Array<{ text: string; score?: number }>>;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'for', 'with', 'i', 'you', 'we', 'it', 'that', 'this']);

function entitiesOf(text: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of (text || '').match(/\b[A-Z][a-zA-Z0-9+.&-]{2,}\b|\b[a-z]+(?:\+\+|#)\b/g) || []) {
    const k = tok.toLowerCase();
    if (STOP.has(k) || seen.has(k)) continue;
    seen.add(k); out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

function summarize(userMessage: string, assistantAnswer: string): string {
  const q = (userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const a = (assistantAnswer || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `Q: ${q}${a ? ` | A: ${a}` : ''}`;
}

function memoryRecords(sessionId: string): StoredTurn[] {
  const state = getConversationState(sessionId);
  if (!state) return [];

  const groups = new Map<string, { user?: ReturnType<typeof getRecentConversationTurns>[number]; assistant?: ReturnType<typeof getRecentConversationTurns>[number] }>();
  for (const turn of state.turns) {
    const md = turn.metadata as Record<string, unknown> | undefined;
    if (!md?.conversationMemoryRecord || typeof md.memoryRecordId !== 'string') continue;
    const id = md.memoryRecordId;
    const group = groups.get(id) ?? {};
    if (turn.role === 'user') group.user = turn;
    if (turn.role === 'assistant') group.assistant = turn;
    groups.set(id, group);
  }

  const out: StoredTurn[] = [];
  for (const [id, group] of groups) {
    if (!group.user || !group.assistant) continue;
    const metadata = (group.user.metadata ?? {}) as Record<string, unknown>;
    out.push({
      id,
      sessionId,
      meetingId: typeof metadata.meetingId === 'string' ? metadata.meetingId : undefined,
      userMessage: group.user.text,
      assistantAnswer: group.assistant.text,
      mode: typeof metadata.mode === 'string' ? metadata.mode : undefined,
      timestamp: group.user.timestamp,
      contextSourcesUsed: Array.isArray(metadata.contextSourcesUsed)
        ? metadata.contextSourcesUsed.filter((x): x is string => typeof x === 'string')
        : undefined,
      entities: Array.isArray(metadata.entities)
        ? metadata.entities.filter((x): x is string => typeof x === 'string')
        : entitiesOf(`${group.user.text} ${group.assistant.text}`),
      requestSequence: group.user.requestSequence ?? group.assistant.requestSequence,
      source: group.user.source,
      metadata,
      summary: summarize(group.user.text, group.assistant.text),
      userTurnId: group.user.id,
      assistantTurnId: group.assistant.id,
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function appendMemoryTurn(input: AppendConversationTurnInput): ReturnType<typeof appendConversationTurn> {
  return appendConversationTurn(input);
}

/**
 * Conversation memory facade. Same-session reads are local + synchronous.
 * Cross-session recall is async via an optional long-term provider (default
 * disabled). No long-term provider is ever required for an answer.
 */
export class ConversationMemoryService {
  private static shared: ConversationMemoryService | null = null;

  constructor(private longTerm?: LongTermRecallProvider | null) {
    // Register the application's first constructed memory facade so existing
    // callers continue to share one service object. The actual turn state is
    // global canonical ConversationState, not service-owned memory.
    if (!ConversationMemoryService.shared) ConversationMemoryService.shared = this;
  }

  static getShared(): ConversationMemoryService | null {
    return ConversationMemoryService.shared;
  }

  /** Record a delivered Q/A pair into the canonical structured turn store. */
  record(turn: ConversationTurn): StoredTurn {
    const timestamp = Number.isFinite(turn.timestamp) ? turn.timestamp : Date.now();
    const existing = getRecentConversationTurns(turn.sessionId, 4);

    // V3 already records the user turn before generation and the assistant turn
    // through recordAnswerSummary(). Do not create a second pair when the legacy
    // compatibility sink sees that same completed answer afterward.
    const lastUser = [...existing].reverse().find((t) => t.role === 'user');
    const lastAssistant = [...existing].reverse().find((t) => t.role === 'assistant');
    if (lastUser?.text === String(turn.userMessage ?? '').trim() && lastAssistant?.text === String(turn.assistantAnswer ?? '').trim()) {
      return {
        id: lastUser.id,
        sessionId: turn.sessionId,
        meetingId: turn.meetingId,
        userMessage: lastUser.text,
        assistantAnswer: lastAssistant.text,
        mode: turn.mode,
        timestamp: lastUser.timestamp,
        contextSourcesUsed: turn.contextSourcesUsed,
        entities: turn.entities ?? entitiesOf(`${lastUser.text} ${lastAssistant.text}`),
        requestSequence: lastUser.requestSequence ?? lastAssistant.requestSequence,
        source: lastUser.source,
        metadata: lastUser.metadata,
        summary: summarize(lastUser.text, lastAssistant.text),
        userTurnId: lastUser.id,
        assistantTurnId: lastAssistant.id,
      };
    }

    const memoryRecordId = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entities = turn.entities ?? entitiesOf(`${turn.userMessage} ${turn.assistantAnswer}`);
    const metadata: Record<string, unknown> = {
      ...(turn.metadata ?? {}),
      conversationMemoryRecord: true,
      memoryRecordId,
      ...(turn.meetingId ? { meetingId: turn.meetingId } : {}),
      ...(turn.mode ? { mode: turn.mode } : {}),
      ...(turn.contextSourcesUsed ? { contextSourcesUsed: [...turn.contextSourcesUsed] } : {}),
      entities,
    };

    let userTurn: ReturnType<typeof appendMemoryTurn>;
    try {
      userTurn = appendMemoryTurn({
        sessionId: turn.sessionId,
        text: String(turn.userMessage ?? '').trim() || '[empty user turn]',
        role: 'user',
        speaker: 'user',
        timestamp,
        finalized: true,
        source: turn.source ?? 'conversation-memory',
        requestSequence: turn.requestSequence,
        metadata,
      });
      const assistantTurn = appendMemoryTurn({
        sessionId: turn.sessionId,
        text: String(turn.assistantAnswer ?? '').trim() || '[empty assistant answer]',
        role: 'assistant',
        speaker: 'assistant',
        timestamp: timestamp + 1,
        finalized: true,
        source: 'assistant',
        requestSequence: turn.requestSequence ?? userTurn.requestSequence,
        metadata: { conversationMemoryRecord: true, memoryRecordId },
      });

      return {
        ...turn,
        timestamp,
        id: userTurn.id,
        summary: summarize(turn.userMessage, turn.assistantAnswer),
        entities,
        requestSequence: turn.requestSequence ?? userTurn.requestSequence,
        userTurnId: userTurn.id,
        assistantTurnId: assistantTurn.id,
        source: userTurn.source,
        metadata,
      };
    } catch {
      // Preserve the old service contract: memory failures never break an answer.
      return {
        ...turn,
        timestamp,
        id: `memory_failed_${Date.now()}`,
        summary: summarize(turn.userMessage, turn.assistantAnswer),
        entities,
      };
    }
  }

  /** Short-term: the last N canonical memory records of the current session. */
  getRecentTurns(sessionId: string, n = 10): StoredTurn[] {
    return memoryRecords(sessionId).slice(-Math.max(0, n));
  }

  /** Session-level extractive rolling summary (no LLM). */
  getSessionSummary(sessionId: string, maxTurns = 12): string {
    return memoryRecords(sessionId).slice(-maxTurns).map((t) => t.summary).join('\n');
  }

  /** The last assistant answer in the session (for "what was your previous suggestion?"). */
  getLastAssistantAnswer(sessionId: string): string | null {
    const arr = memoryRecords(sessionId);
    return arr.length ? arr[arr.length - 1].assistantAnswer : null;
  }

  /** Return the most recent coding memory record. */
  getLastCodingTurn(sessionId: string): StoredTurn | null {
    const arr = memoryRecords(sessionId);
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i].assistantAnswer || '';
      if (/```[\s\S]*```/.test(a) || (arr[i].contextSourcesUsed || []).includes('coding')) return arr[i];
    }
    return null;
  }

  /** SAME-SESSION follow-up: local canonical memory first. */
  resolveSameSession(sessionId: string, followUp: string): StoredTurn | null {
    try {
      const arr = memoryRecords(sessionId);
      if (arr.length === 0) return null;
      const ents = new Set(entitiesOf(followUp).map((e) => e.toLowerCase()));
      const matched = followUp.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      const terms = new Set(matched.filter((t) => t.length > 2 && !STOP.has(t)));
      let best: StoredTurn | null = null;
      let bestScore = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        const t = arr[i];
        const hay = `${t.userMessage} ${t.assistantAnswer}`.toLowerCase();
        let score = 0;
        for (const e of ents) if (hay.includes(e)) score += 2;
        for (const term of terms) if (hay.includes(term)) score += 1;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      const fu = (followUp || '').trim();
      const RECENCY_FALLBACK_RE = /\b(that|it|this|those|and|also|what about|continue|carry on|keep going|go on|previous|earlier|last|why|how|so|then|more|expand|elaborate|deeper|detail|tell me more|go deeper|explain)\b/i;
      if (!best && fu.split(/\s+/).length <= 6 && RECENCY_FALLBACK_RE.test(fu)) return arr[arr.length - 1];
      return best;
    } catch { return null; }
  }

  /** CROSS-SESSION follow-up: optional long-term provider with strict timeout. */
  async recallCrossSession(
    query: string,
    scope: { userId: string; sessionId?: string },
    timeoutMs = 800,
  ): Promise<Array<{ text: string; score?: number }>> {
    if (!this.longTerm) return [];
    try {
      const result = await Promise.race([
        this.longTerm.recall(query, scope, timeoutMs),
        new Promise<Array<{ text: string; score?: number }>>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  /** Clear one canonical conversation session. */
  clearSession(sessionId: string): void {
    try { clearConversationState(sessionId); } catch { /* ignore */ }
  }

  /** Clear EVERY canonical conversation session. */
  clearAllSessions(): void {
    try { clearConversationState(); } catch { /* ignore */ }
  }

  get sessionCount(): number {
    return getConversationSessionCount();
  }
}
