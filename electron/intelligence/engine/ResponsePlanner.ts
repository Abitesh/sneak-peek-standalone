/**
 * Canonical response-planning stage for Natively Intelligence.
 *
 * Context selection answers: "what information should I use?"
 * Response planning answers: "what should the answer look/sound like?"
 *
 * This module is deterministic and provider-independent. It never retrieves,
 * ranks, or selects evidence.
 */

import type { AnswerPlan, AnswerType } from '../../llm/AnswerPlanner';
import type { TurnUnderstanding } from '../../context-intelligence/question/question-resolver';

export type ResponseKind =
  | 'direct-answer'
  | 'explanation'
  | 'project-grounded'
  | 'first-person-interview'
  | 'coding'
  | 'troubleshooting'
  | 'example'
  | 'summary';

export type ResponseDetailLevel = 'concise' | 'normal' | 'detailed';

export type ResponseFormat =
  | 'prose'
  | 'spoken'
  | 'code'
  | 'bullets'
  | 'structured';

export interface ResponsePlan {
  question: string;
  kind: ResponseKind;
  detailLevel: ResponseDetailLevel;
  format: ResponseFormat;
  spoken: boolean;
  firstPerson: boolean;
  projectGrounded: boolean;
  requestedDurationSeconds?: number;
  answerType?: AnswerType;
  answerStyle?: string;
  maxTokens?: number;
  maxSentences?: number;
  rationale: string[];
}

export interface ResponsePlannerInput {
  question: string;
  answerPlan?: AnswerPlan | null;
  turnUnderstanding?: TurnUnderstanding | null;
}

/** Adapter over the existing AnswerPlanner classification. Kept local so the
 * new engine does not import the legacy planner's runtime dependency graph. */
function responseShapeSeed(answerType?: AnswerType): ResponseKind | undefined {
  if (!answerType) return undefined;
  if (answerType === 'coding_question_answer' || answerType === 'dsa_question_answer') return 'coding';
  if (answerType === 'debugging_question_answer') return 'troubleshooting';
  if (answerType === 'project_answer' || answerType === 'project_followup_answer' || answerType === 'project_about_answer'
    || answerType === 'project_link_answer' || answerType === 'source_code_evidence_answer') return 'project-grounded';
  if (answerType === 'behavioral_interview_answer' || answerType === 'experience_answer' || answerType === 'skill_experience_answer'
    || answerType === 'skills_answer' || answerType === 'profile_fact_answer' || answerType === 'identity_answer'
    || answerType === 'jd_fit_answer' || answerType === 'gap_analysis_answer' || answerType === 'resume_jd_fit_answer'
    || answerType === 'resume_jd_gap_answer' || answerType === 'resume_jd_intro_answer') return 'first-person-interview';
  if (answerType === 'lecture_answer' || answerType === 'document_structure_answer' || answerType === 'document_followup_answer'
    || answerType === 'general_meeting_answer') return 'summary';
  if (answerType === 'technical_concept_answer' || answerType === 'definitional_answer') return 'explanation';
  return 'direct-answer';
}

function explicitDurationSeconds(question: string): number | undefined {
  const q = question.toLowerCase();
  const match = q.match(/\b(?:in|within|for|give me|make it|answer in)?\s*(?:about\s+|roughly\s+|a\s+)?(\d+(?:\.\d+)?)\s*[- ]?\s*(seconds?|secs?|minutes?|mins?)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return /minute|min\b/i.test(match[2]) ? Math.round(value * 60) : Math.round(value);
}

function isExampleRequest(question: string): boolean {
  return /\b(give|show|provide|share|walk me through)\s+(?:me\s+)?(?:an?|some)\s+example\b|\bfor example\b|\bexample of\b/i.test(question);
}

function isSummaryRequest(question: string): boolean {
  return /\b(summar(?:y|ize|ise)|tl;?dr|key takeaways|in short|brief recap|recap)\b/i.test(question);
}

function isSpokenRequest(question: string): boolean {
  return /\b(say|spoken|speak|out loud|aloud|interview answer|answer aloud|what should i answer|what should i say|how should i answer|how should i respond)\b/i.test(question);
}

function detailFromStyle(style?: string, duration?: number): ResponseDetailLevel {
  if (style === 'detailed' || style === 'exam' || style === 'notes' || style === 'approach_first') return 'detailed';
  if (style === 'one_liner' || style === 'short' || style === 'code_only') return 'concise';
  if (duration !== undefined) {
    if (duration <= 20) return 'concise';
    if (duration >= 90) return 'detailed';
  }
  return 'normal';
}

function maxSentencesFor(detail: ResponseDetailLevel, spoken: boolean, kind: ResponseKind): number | undefined {
  if (kind === 'coding') return undefined;
  if (detail === 'concise') return spoken ? 3 : 4;
  if (detail === 'detailed') return spoken ? 8 : 12;
  return spoken ? 5 : 8;
}

function maxTokensFor(detail: ResponseDetailLevel, kind: ResponseKind, duration?: number): number {
  if (kind === 'coding') return 1400;
  if (duration !== undefined) return Math.min(1800, Math.max(160, Math.round(duration * 3.0)));
  if (detail === 'concise') return 350;
  if (detail === 'detailed') return 1100;
  return 650;
}

/**
 * Decide answer shape independently from context selection.
 */
export function planResponse(input: ResponsePlannerInput): ResponsePlan {
  const question = (input.question || '').trim();
  const plan = input.answerPlan ?? null;
  const understanding = input.turnUnderstanding ?? null;
  const duration = understanding?.requestedDuration ?? explicitDurationSeconds(question);
  // The canonical turn-understanding stage already classifies concise/detailed
  // response shape. Preserve that decision here unless an explicit legacy
  // AnswerPlan style overrides it. Without this bridge, phrases such as
  // "in detail" and "one sentence" were visible to the resolver but were
  // silently dropped before prompt assembly.
  const understandingStyle = understanding?.responseShape === 'detailed'
    ? 'detailed'
    : understanding?.responseShape === 'concise'
      ? 'short'
      : understanding?.responseShape === 'code'
        ? 'code_only'
        : undefined;
  const style = plan?.answerStyle ?? understandingStyle;

  const answerSeed = plan?.responseShapeSeed ?? responseShapeSeed(plan?.answerType);
  const projectGrounded = Boolean(answerSeed === 'project-grounded' || understanding?.intent === 'project-question');
  const troubleshooting = Boolean(
    answerSeed === 'troubleshooting'
    || (understanding?.intent === 'screen-question' && /\b(error|bug|issue|exception|fail|failed|crash|problem)\b/i.test(question)),
  );
  const coding = Boolean(answerSeed === 'coding' || understanding?.intent === 'coding-request');

  const explicitExample = isExampleRequest(question);
  const explicitSummary = isSummaryRequest(question);
  const firstPerson = Boolean(
    plan?.voicePerspective === 'first_person_candidate'
    || (projectGrounded && /\b(tell me about|walk me through|describe)\b/i.test(question))
    || (projectGrounded && plan?.answerType === 'project_about_answer'),
  );
  const spoken = Boolean(
    plan?.voicePerspective === 'first_person_candidate'
    || plan?.source === 'what_to_answer'
    || plan?.source === 'transcript'
    || isSpokenRequest(question)
    || firstPerson,
  );

  let kind: ResponseKind = 'direct-answer';
  const rationale: string[] = [];

  if (coding) {
    kind = 'coding';
    rationale.push('coding request');
  } else if (troubleshooting) {
    kind = 'troubleshooting';
    rationale.push('debugging/troubleshooting signal');
  } else if (explicitSummary || answerSeed === 'summary') {
    kind = 'summary';
    rationale.push('summary signal');
  } else if (explicitExample) {
    kind = 'example';
    rationale.push('explicit example request');
  } else if (firstPerson) {
    kind = 'first-person-interview';
    rationale.push('candidate interview voice');
  } else if (projectGrounded) {
    kind = 'project-grounded';
    rationale.push('project-grounded answer type');
  } else if (
    plan?.answerType === 'technical_concept_answer'
    || plan?.answerType === 'definitional_answer'
    || understanding?.intent === 'general-question'
  ) {
    kind = 'explanation';
    rationale.push('technical/concept explanation');
  } else {
    rationale.push('direct answer fallback');
  }

  const detailLevel = detailFromStyle(style, duration);
  const format: ResponseFormat = coding
    ? 'code'
    : style === 'bullets' || style === 'notes'
      ? 'bullets'
      : style === 'exam' || style === 'detailed'
        ? 'structured'
        : spoken
          ? 'spoken'
          : 'prose';

  if (duration !== undefined) rationale.push(`requested duration: ${duration}s`);
  if (spoken) rationale.push('spoken delivery');
  if (firstPerson) rationale.push('first-person delivery');

  return {
    question,
    kind,
    detailLevel,
    format,
    spoken,
    firstPerson,
    projectGrounded,
    requestedDurationSeconds: duration,
    answerType: plan?.answerType,
    answerStyle: style,
    maxTokens: maxTokensFor(detailLevel, kind, duration),
    maxSentences: maxSentencesFor(detailLevel, spoken, kind),
    rationale,
  };
}

export function formatResponsePlanForPrompt(plan: ResponsePlan): string {
  const lines = [
    '<response_plan>',
    `  <kind>${plan.kind}</kind>`,
    `  <detail_level>${plan.detailLevel}</detail_level>`,
    `  <format>${plan.format}</format>`,
    `  <spoken>${plan.spoken}</spoken>`,
    `  <first_person>${plan.firstPerson}</first_person>`,
    `  <project_grounded>${plan.projectGrounded}</project_grounded>`,
  ];
  if (plan.requestedDurationSeconds !== undefined) {
    lines.push(`  <requested_duration_seconds>${plan.requestedDurationSeconds}</requested_duration_seconds>`);
    lines.push(`  <duration_is_user_requested>true</duration_is_user_requested>`);
  }
  if (plan.maxTokens !== undefined) lines.push(`  <max_tokens>${plan.maxTokens}</max_tokens>`);
  if (plan.maxSentences !== undefined) lines.push(`  <max_sentences>${plan.maxSentences}</max_sentences>`);
  lines.push('  <instruction>Answer the resolved question using the selected context. Do not change context selection based on this plan.</instruction>');
  lines.push('</response_plan>');
  return lines.join('\n');
}
