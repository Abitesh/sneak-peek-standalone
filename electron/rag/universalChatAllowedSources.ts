/**
 * V3-style authorization allowlist for planner-led chat / WTA retrieval.
 *
 * Pass the result as `allowedSources` only and omit `selectedSources` so
 * RagQueryPlanner picks within the cap (see ipcHandlers createRAGRetrievalPort).
 * Mode-document-grounded / 47ZF paths must NOT use this — they keep
 * selectedSources+allowedSources locked to mode-reference.
 */
import type { RagSourceSelection } from './RagQueryPlanner';

export type UniversalChatAllowlistOptions = {
  /** Default true — authorize active-mode reference retrieval. */
  includeModeReference?: boolean;
  /** Default true when mode-reference is included. */
  includeKnowledge?: boolean;
  /** Default true — planner still gates on hasPersonalFiles at search time. */
  includePersonalFiles?: boolean;
  /** Default false — meeting only when the caller opts in. */
  includeMeeting?: boolean;
};

export function buildUniversalChatAllowedSources(
  options: UniversalChatAllowlistOptions = {},
): RagSourceSelection[] {
  const out: RagSourceSelection[] = [];
  if (options.includeModeReference !== false) {
    out.push('mode-reference');
    if (options.includeKnowledge !== false) out.push('knowledge');
  }
  if (options.includePersonalFiles !== false) out.push('personal-files');
  if (options.includeMeeting === true) out.push('meeting');
  return out;
}
