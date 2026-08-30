// electron/llm/contextEngine.ts
//
// Single decision point for which OPTIONAL context layers ride a chat turn
// (Problems 8, 9, 17, 31). System persona + user message are always the
// caller's concern; this module only decides whether history/transcript/file
// chunks/resume-JD/screen belong on top of them, and hands the surviving
// layers to fitPromptToBudget (./promptBudget.ts) for the final size guard.
//
// Deliberately does NOT do retrieval, chunking, or filesystem access — callers
// (ModeHybridRetriever, PersonalKnowledgeManager, the manual-chat V3 bridge,
// etc.) already own that. Blindly inserting a full file here would defeat the
// whole point of top-K retrieval, so this module only ever gates or trims text
// it is handed.

export type ContextLayerId = 'history' | 'transcript' | 'fileChunks' | 'resumeJd' | 'screen' | (string & {});

export interface ContextLayerInput {
  id: ContextLayerId;
  text: string;
  /** Lower = higher priority (kept longer under budget pressure). */
  priority: number;
}

// Bare greetings and acks carry nothing for retrieval/history to ground.
const GREETING_RE = /^(hi|hello|hey|yo|sup|hiya|howdy|thanks|thank you|ok|okay|cool|nice|great)[\s!.,]*$/i;

/**
 * Trivial-query gate: a bare greeting, or any short (<20 char) statement with
 * no question mark, gets system+user only. Attaching history/file/screen
 * layers to "hi" is pure token waste — the literal "10k tokens for hi" defect
 * this sprint exists to close.
 */
export function isTrivialQuery(query: string | null | undefined): boolean {
  const q = (query ?? '').trim();
  if (!q) return true;
  if (GREETING_RE.test(q)) return true;
  return q.length < 20 && !q.includes('?');
}

/**
 * Manual-chat must NOT treat the last N seconds of Listen/meeting STT as
 * "conversation so far" by default. That made ordinary typed questions answer
 * from unrelated interview chatter whenever audio was recently active — the
 * intermittent "random answer" defect. Continuity for follow-ups belongs to
 * conversation-state-store (engine-bridge). Attach live transcript only when a
 * meeting is active AND the question clearly refers to that live conversation.
 */
const LIVE_TRANSCRIPT_REFERENT_RE =
  /\b(they|he|she|interviewer|just (said|asked)|what did (they|he|she|the interviewer)|repeat (that|the question)|said just now|asked me|that question|the (last|previous) question|transcript)\b/i;

export function shouldAttachLiveTranscriptToManualChat(opts: {
  query: string | null | undefined;
  meetingActive: boolean;
}): boolean {
  if (!opts.meetingActive) return false;
  if (isTrivialQuery(opts.query)) return false;
  return LIVE_TRANSCRIPT_REFERENT_RE.test((opts.query ?? '').trim());
}

export interface AssembleContextInput {
  query: string;
  /** Candidate optional layers, highest priority first. Caller has already retrieved/chunked their content. */
  layers?: ContextLayerInput[];
}

export interface AssembledContext {
  trivial: boolean;
  /** Layers that survive the trivial-query gate and have non-empty text — still subject to fitPromptToBudget. */
  layers: ContextLayerInput[];
}

export function assembleContext(input: AssembleContextInput): AssembledContext {
  const trivial = isTrivialQuery(input.query);
  const layers = trivial ? [] : (input.layers ?? []).filter((l) => Boolean(l.text?.trim()));
  return { trivial, layers };
}

/**
 * Format merged screen text (vision extraction + supplementary OCR, see
 * ScreenOcrBridge) as a 'screen' context layer. Pure filtering — empty after
 * trim yields no layer, matching every other optional layer's non-empty rule.
 *
 * Unlike history/file layers, a screenshot is never subject to the
 * trivial-query gate: pressing Screen then Answer is explicit user intent,
 * so callers attach this layer directly rather than routing it through
 * `assembleContext()`'s greeting/short-query filter.
 */
export function buildScreenLayer(text: string | null | undefined, priority = 5): ContextLayerInput | null {
  const trimmed = (text ?? '').trim();
  return trimmed ? { id: 'screen', text: trimmed, priority } : null;
}
