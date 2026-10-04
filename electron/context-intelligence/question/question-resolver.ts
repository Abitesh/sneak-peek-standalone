// electron/context-intelligence/question/question-resolver.ts
//
// Resolve ONE question from messy live input (§12.1).
//
// WHY THIS IS SEPARATE FROM CLASSIFICATION
// The transcript-driven surfaces (assist, clarify, brainstorm) do not receive a
// question at all — they receive a rolling window of speech. Before any of the
// decision layer applies, something must decide WHAT was asked. Doing that
// inside the classifier would mean re-deriving it per surface, which is how the
// codebase ended up with several surfaces each interpreting the turn differently.
//
// Real input carries: partial STT, repeated fragments, speaker overlap, filler,
// abandoned half-questions, background speech, and the assistant's OWN previous
// output echoed back.
//
// PRIORITY (§12.2), and it is not negotiable:
//   1. explicit manual question
//   2. user-selected transcript segment
//   3. the latest stable interviewer question
//   4. a follow-up resolved against conversation state
//
// Manual input wins outright. A transcript extractor that can override what the
// user literally typed is a bug, not a feature.

export type QuestionSource = 'manual' | 'selection' | 'transcript' | 'follow-up' | 'none';

export interface TranscriptTurn {
  role: 'user' | 'interviewer' | 'assistant';
  text: string;
  timestamp: number;
}

export interface ResolveInput {
  manualQuestion?: string;
  selectedText?: string;
  transcript?: TranscriptTurn[];
  /** Window considered "current". Older turns are context, not the question. */
  windowMs?: number;
  now?: number;
}

export interface ResolvedQuestion {
  originalInput: string;
  resolvedQuestion: string;
  source: QuestionSource;
  confidence: number;
  isFollowUp: boolean;
  activeEntities: string[];
  requiresClarification: boolean;
  clarificationReason?: string;
}

const FILLER = /\b(um+|uh+|er+|ah+|like|you know|i mean|sort of|kind of|basically|actually|so yeah|right)\b/gi;

/** Collapse the repeated fragments STT produces mid-utterance:
 *  "why did you why did you choose" -> "why did you choose". */
function dedupeStutter(text: string): string {
  let out = text;
  for (let n = 4; n >= 2; n--) {
    const re = new RegExp(`\\b((?:\\w+\\s+){${n - 1}}\\w+)\\s+\\1\\b`, 'gi');
    let prev: string;
    do { prev = out; out = out.replace(re, '$1'); } while (out !== prev);
  }
  return out.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
}

export function cleanUtterance(text: string): string {
  return dedupeStutter(String(text))
    .replace(FILLER, ' ')
    // Removing a filler word strips the word but leaves its punctuation behind:
    // "so um, like, why…" becomes "so ,, why…". Collapse the orphans, or the
    // question reaches the model visibly mangled.
    .replace(/\s+([,.?!])/g, '$1')
    .replace(/([,;:])(\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUESTION_CUE = /\b(what|how|why|where|when|which|who|can you|could you|would you|do you|did you|have you|tell me|explain|describe|walk me through|talk me through|give me)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.endsWith('?') || QUESTION_CUE.test(t);
}

/** An abandoned question trails off without ever asking anything. */
function isAbandoned(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[-—]$|\.\.\.$/.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length < 3 && !t.endsWith('?');
}

const PRONOUN_ONLY = /^(why|how|and|but|really|ok(ay)?|go on|what about (it|that|this))\b[\s?.!]*$/i;

function entitiesOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]{2,})\b/g)) out.add(m[1]);
  return [...out].slice(0, 8);
}

/**
 * Resolve the question ONCE.
 *
 * Assistant turns are never treated as the question. The model's own previous
 * output echoed back into the transcript is exactly how a fabrication becomes
 * self-reinforcing — it must not be able to re-enter as the thing being asked.
 */
export function resolveQuestion(input: ResolveInput): ResolvedQuestion {
  const empty: ResolvedQuestion = {
    originalInput: '', resolvedQuestion: '', source: 'none', confidence: 0,
    isFollowUp: false, activeEntities: [], requiresClarification: true,
    clarificationReason: 'no question could be resolved from the input',
  };

  // 1 — manual input wins outright, and is NOT cleaned: the user typed exactly
  // what they meant, and "filler removal" on deliberate text is corruption.
  const manual = input.manualQuestion?.trim();
  if (manual) {
    return {
      originalInput: manual, resolvedQuestion: manual, source: 'manual', confidence: 1,
      isFollowUp: PRONOUN_ONLY.test(manual), activeEntities: entitiesOf(manual),
      requiresClarification: false,
    };
  }

  // 2 — an explicit selection is a deliberate act too.
  const selected = input.selectedText?.trim();
  if (selected) {
    const cleaned = cleanUtterance(selected);
    return {
      originalInput: selected, resolvedQuestion: cleaned || selected, source: 'selection',
      confidence: 0.95, isFollowUp: PRONOUN_ONLY.test(cleaned),
      activeEntities: entitiesOf(cleaned), requiresClarification: false,
    };
  }

  // 3 — the latest stable interviewer question inside the window.
  const turns = input.transcript ?? [];
  if (!turns.length) return empty;

  const now = input.now ?? Math.max(...turns.map((t) => t.timestamp));
  const windowMs = input.windowMs ?? 60_000;

  const candidates = turns
    .filter((t) => t.role === 'interviewer')          // never the assistant, never the user
    .filter((t) => now - t.timestamp <= windowMs)
    .reverse();                                       // most recent first

  for (const turn of candidates) {
    const cleaned = cleanUtterance(turn.text);
    if (!cleaned || isAbandoned(cleaned)) continue;
    if (!looksLikeQuestion(cleaned)) continue;

    const followUp = PRONOUN_ONLY.test(cleaned);
    return {
      originalInput: turn.text,
      resolvedQuestion: cleaned,
      source: followUp ? 'follow-up' : 'transcript',
      // A follow-up carries no subject of its own, so confidence is lower and
      // the caller is expected to resolve it against conversation state.
      confidence: followUp ? 0.55 : 0.8,
      isFollowUp: followUp,
      activeEntities: entitiesOf(cleaned),
      requiresClarification: followUp,
      ...(followUp ? { clarificationReason: 'follow-up has no subject of its own' } : {}),
    };
  }

  return {
    ...empty,
    originalInput: turns[turns.length - 1]?.text ?? '',
    clarificationReason: 'no stable interviewer question in the current window',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Change 5 — canonical turn understanding
//
// Question marks are deliberately only one signal.  Understanding combines
// the existing question resolver, the proven deterministic turn classifier,
// conversation continuity, and small semantic shape signals.  This keeps the
// expensive/retrieval stages downstream of one explicit interpretation.

import type { ModePolicy } from '../policies/mode-policy-registry';
import { classifyTurn, type Classification } from './turn-classifier';
import { extractEntities, extractTopicPhrase, resolveReference, type ConversationState, type ResolvedReference } from './conversation-state';

export type TurnIntent =
  | 'general-question'
  | 'personal-question'
  | 'project-question'
  | 'document-question'
  | 'meeting-question'
  | 'screen-question'
  | 'coding-request'
  | 'system-design'
  | 'follow-up'
  | 'refinement'
  | 'conversational-response'
  | 'clarification'
  | 'ambiguous';

export type ResponseShape = 'concise' | 'normal' | 'detailed' | 'code' | 'clarification';

export interface TurnUnderstanding {
  question: string;
  intent: TurnIntent;
  isQuestion: boolean;
  followUp: boolean;
  refersToPreviousContext: boolean;
  confidence: number;
  subject?: string;
  entities: string[];
  requestedDuration?: number;
  responseShape: ResponseShape;
  requiresPersonalContext: boolean;
  requiresProjectContext: boolean;
  requiresDocumentContext: boolean;
  requiresMeetingContext: boolean;
  requiresScreenContext: boolean;
  requiresRetrieval: boolean;
  classification?: Classification;
  source: QuestionSource;
}

export interface UnderstandTurnInput extends ResolveInput {
  sessionId?: string;
  conversationState?: ConversationState | null;
  policy?: ModePolicy;
  hasScreenContext?: boolean;
  hasAttachedDocuments?: boolean;
  attachedFileNames?: readonly string[];
}

const SEMANTIC_QUESTION_CUE = /^(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|have|has|is|are|will|tell me|explain|describe|walk me through|give me|show me)\b/i;
const FOLLOW_UP_CUE = /^(?:(?:and|but|so|then)\s+(?:why|how|what about|what if)|can you explain (?:that|this)|explain (?:that|this)(?: again)?|tell me more|go on|really|okay|ok)\b/i;
const DEICTIC_CUE = /\b(?:this|that|it|they|them|above|earlier|previous(?:ly)?|what you said|what i said|the above)\b/i;
const REFINEMENT_CUE = /^(?:make|keep|write|say|explain|expand|shorten|simplify|rewrite|give)\s+(?:it|that|this|the answer|the explanation)\b|^(?:make it|keep it|explain that again|say that again|shorter|longer|more detailed|less detailed|simpler)\b/i;
const CODING_CUE = /\b(?:give me code|write code|code for|implement|implementation|function|class|algorithm|leetcode|debug|fix (?:this|the) (?:code|bug|error)|program|snippet|sql query)\b/i;
const PROJECT_CUE = /\b(?:my project|our project|the project|project|repo(?:sitory)?|linkship|sneak[- ]?peek|natively|tech stack|architecture|what did i use|why did i use|what did we use|how did i implement|how did i build|what did i build|what did i develop)\b/i;
const PERSONAL_CUE = /\b(?:my resume|my cv|about me|about myself|tell me about myself|my experience|my skills|my background|my education|my internship|my job|what do i have|what did i do|do i have|did i use)\b/i;
const DOCUMENT_CUE = /\b(?:document|documents|file|files|pdf|attachment|attached|resume|cv|paper|report|what does .* say|according to)\b/i;
const MEETING_CUE = /\b(?:meeting|transcript|interview|interviewer|what did .* say|what was .* mentioned|discussed|said earlier)\b/i;
const SCREEN_CUE = /\b(?:this error|this screen|this screenshot|shown|displayed|on screen|what is this|what am i looking at)\b/i;
const STATEMENT_RESPONSE_CUE = /^(?:i\s+(?:don't|do not|didn't|did not|can't|cannot|am confused|understand|don't understand)|that (?:doesn't|does not|didn't|did not) make sense|i'm confused|i am confused|i need help)\b/i;
const DURATION_CUE = /\b(?:in|within|for)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/i;

function durationSeconds(text: string): number | undefined {
  const m = text.match(DURATION_CUE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return /minute|min\b/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
}

function responseShapeOf(text: string, coding: boolean): ResponseShape {
  if (coding || /\bcode\b/i.test(text)) return 'code';
  if (REFINEMENT_CUE.test(text) && /\b(?:longer|detailed|expand|more)\b/i.test(text)) return 'detailed';
  if (/\b(?:shorter|concise|brief|one sentence|quickly)\b/i.test(text)) return 'concise';
  if (/\b(?:longer|detailed|deep|in detail|expand)\b/i.test(text)) return 'detailed';
  return 'normal';
}

function heuristicIntent(text: string, input: UnderstandTurnInput, classification?: Classification): TurnIntent {
  const q = text.trim();
  const lower = q.toLowerCase();
  const types = new Set(classification?.questionTypes ?? []);
  if (types.has('FOLLOW_UP')) return 'follow-up';
  if (types.has('CODING_TASK')) return 'coding-request';
  if (types.has('SYSTEM_DESIGN')) return 'system-design';
  if ([...types].some((t) => t === 'DOCUMENT_FACT' || t === 'DOCUMENT_EXPLANATION')) return 'document-question';
  if (types.has('SCREEN_SPECIFIC')) return 'screen-question';
  if (types.has('MEETING_FACT')) return 'meeting-question';
  if ([...types].some((t) => t === 'PERSONAL_EXPERIENCE' || t === 'PERSONAL_PROJECT' || t === 'PERSONAL_SKILL' || t === 'JOB_REQUIREMENT' || t === 'ROLE_ALIGNMENT')) {
    return PROJECT_CUE.test(q) || /\b(?:project|repo|postgresql|redis|django|python|github)\b/i.test(q) ? 'project-question' : 'personal-question';
  }
  if (FOLLOW_UP_CUE.test(q)) return 'follow-up';
  if (REFINEMENT_CUE.test(q)) return 'refinement';
  if (CODING_CUE.test(q)) return 'coding-request';
  if (SCREEN_CUE.test(q) && input.hasScreenContext) return 'screen-question';
  if (DOCUMENT_CUE.test(q)) return 'document-question';
  if (MEETING_CUE.test(q)) return 'meeting-question';
  if (PROJECT_CUE.test(q)) return 'project-question';
  if (PERSONAL_CUE.test(q)) return 'personal-question';
  if (STATEMENT_RESPONSE_CUE.test(q)) return 'conversational-response';
  if (SEMANTIC_QUESTION_CUE.test(q) || q.endsWith('?')) return 'general-question';
  if (DEICTIC_CUE.test(q)) return 'follow-up';
  return 'conversational-response';
}

/**
 * Canonical understanding stage. Existing resolver/classifier behavior remains
 * available and is composed here rather than deleted or duplicated downstream.
 */
export function understandTurn(input: UnderstandTurnInput): TurnUnderstanding {
  const resolved = resolveQuestion(input);
  const question = resolved.resolvedQuestion || input.manualQuestion?.trim() || input.selectedText?.trim() || '';
  const state = input.conversationState;
  const reference = state ? resolveReference(question, state) : { resolved: question, usedState: false } as ResolvedReference;
  const normalizedQuestion = reference.resolved || question;
  const followUp = Boolean(resolved.isFollowUp || reference.usedState || FOLLOW_UP_CUE.test(normalizedQuestion) || DEICTIC_CUE.test(normalizedQuestion));

  let classification: Classification | undefined;
  if (input.policy) {
    classification = classifyTurn({
      resolvedQuestion: normalizedQuestion,
      policy: input.policy,
      isFollowUp: followUp,
      hasScreenContext: input.hasScreenContext,
      hasAttachedDocuments: input.hasAttachedDocuments,
      attachedFileNames: input.attachedFileNames,
    });
  }

  const intent = heuristicIntent(normalizedQuestion, input, classification);
  const isQuestion = Boolean(
    normalizedQuestion.endsWith('?')
    || SEMANTIC_QUESTION_CUE.test(normalizedQuestion)
    || followUp
    || intent === 'refinement'
    || intent === 'coding-request'
    || intent === 'system-design',
  );
  const entities = [...new Set([
    ...resolved.activeEntities,
    ...extractEntities(normalizedQuestion),
  ])].slice(0, 8);
  const subject = extractTopicPhrase(normalizedQuestion) ?? entities[0];
  const coding = intent === 'coding-request' || intent === 'system-design';
  const requiresPersonalContext = intent === 'personal-question';
  const requiresProjectContext = intent === 'project-question';
  const requiresDocumentContext = intent === 'document-question';
  const requiresMeetingContext = intent === 'meeting-question';
  const requiresScreenContext = intent === 'screen-question';
  const requiresRetrieval = Boolean(
    classification?.shouldRetrieve
      ?? (requiresPersonalContext
        || requiresProjectContext
        || requiresDocumentContext
        || requiresMeetingContext
        || requiresScreenContext
        || followUp),
  );

  const confidenceBase = resolved.confidence || 0.4;
  const confidence = Math.min(1, Math.max(0, confidenceBase + (reference.usedState ? 0.05 : 0)));

  return {
    question: normalizedQuestion,
    intent,
    isQuestion,
    followUp,
    refersToPreviousContext: Boolean(reference.usedState || DEICTIC_CUE.test(normalizedQuestion) || resolved.isFollowUp),
    confidence,
    ...(subject ? { subject } : {}),
    entities,
    ...(durationSeconds(normalizedQuestion) !== undefined ? { requestedDuration: durationSeconds(normalizedQuestion) } : {}),
    responseShape: responseShapeOf(normalizedQuestion, coding),
    requiresPersonalContext,
    requiresProjectContext,
    requiresDocumentContext,
    requiresMeetingContext,
    requiresScreenContext,
    requiresRetrieval,
    ...(classification ? { classification } : {}),
    source: resolved.source,
  };
}
