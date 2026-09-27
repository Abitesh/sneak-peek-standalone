// electron/rag/evidenceTerminologyHint.ts
//
// Stage 8: lightweight post-retrieval ASR near-miss hint for prompt construction.
// When a query token (e.g. "DVMS") is one edit from a strong evidence token
// ("DBMS"), emit a non-authoritative note. Never rewrite displayed transcripts.
// Never store this policy on EvidencePack.

import { levenshtein1 } from '../services/modes/retrievalTextMatch';
import { escapeXml } from '../intelligence/context-os/promptRenderer';

export type TerminologyHint = {
  heard: string;
  evidenceTerm: string;
};

const MIN_TOKEN_LEN = 4;
const DEFAULT_MAX_HINTS = 3;

/** Tiny English/filler skip list — not a domain dictionary. */
const SKIP = new Set([
  'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'which',
  'your', 'about', 'into', 'than', 'then', 'them', 'they', 'were', 'been',
  'being', 'would', 'could', 'should', 'there', 'their', 'these',
  'those', 'some', 'such', 'only', 'also', 'just', 'like', 'make', 'made',
  'does', 'did', 'doing', 'will', 'shall', 'over', 'under', 'after', 'before',
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9]{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    out.push(m[0]);
  }
  return out;
}

function evidenceTokenSet(evidenceTexts: readonly string[]): {
  lowerExact: Set<string>;
  /** Prefer the first casing seen in evidence for display. */
  displayByLower: Map<string, string>;
} {
  const lowerExact = new Set<string>();
  const displayByLower = new Map<string, string>();
  for (const text of evidenceTexts) {
    for (const tok of tokenize(text)) {
      const lower = tok.toLowerCase();
      if (SKIP.has(lower)) continue;
      lowerExact.add(lower);
      if (!displayByLower.has(lower)) displayByLower.set(lower, tok);
    }
  }
  return { lowerExact, displayByLower };
}

/**
 * Find query tokens that are one-edit near-misses of tokens present in retrieved
 * evidence, when the query token itself is absent from evidence.
 */
export function findEvidenceTerminologyHints(
  query: string,
  evidenceTexts: readonly string[],
  options: { maxHints?: number } = {},
): TerminologyHint[] {
  const maxHints = options.maxHints ?? DEFAULT_MAX_HINTS;
  if (!query?.trim() || !evidenceTexts?.length || maxHints <= 0) return [];

  const { lowerExact, displayByLower } = evidenceTokenSet(evidenceTexts);
  if (lowerExact.size === 0) return [];

  const evidenceLowers = [...lowerExact];
  const hints: TerminologyHint[] = [];
  const usedHeard = new Set<string>();
  const usedEvidence = new Set<string>();

  for (const heard of tokenize(query)) {
    if (hints.length >= maxHints) break;
    const heardLower = heard.toLowerCase();
    if (heardLower.length < MIN_TOKEN_LEN || SKIP.has(heardLower)) continue;
    if (lowerExact.has(heardLower)) continue; // exact — no recovery needed
    if (usedHeard.has(heardLower)) continue;

    let best: string | undefined;
    for (const evidenceLower of evidenceLowers) {
      if (evidenceLower.length < MIN_TOKEN_LEN) continue;
      if (!levenshtein1(heardLower, evidenceLower)) continue;
      // Prefer same-length acronym-style near-misses (DVMS↔DBMS) over longer stems.
      if (
        !best
        || Math.abs(evidenceLower.length - heardLower.length)
          < Math.abs(best.length - heardLower.length)
      ) {
        best = evidenceLower;
      }
    }
    if (!best || usedEvidence.has(best)) continue;
    usedHeard.add(heardLower);
    usedEvidence.add(best);
    hints.push({
      heard,
      evidenceTerm: displayByLower.get(best) ?? best,
    });
  }
  return hints;
}

export function renderTerminologyHintXml(hints: readonly TerminologyHint[]): string {
  if (!hints.length) return '';
  const lines = [
    '<terminology_note authority="non_authoritative" purpose="asr_near_miss_hint">',
    'Speech/ASR may have mistyped terms in the question. Retrieved evidence strongly matches the following; prefer evidence terminology when answering. Do NOT rewrite or correct the displayed user transcript.',
  ];
  for (const h of hints) {
    lines.push(
      `  <hint heard="${escapeXml(h.heard)}" evidence_term="${escapeXml(h.evidenceTerm)}" />`,
    );
  }
  lines.push('</terminology_note>');
  return lines.join('\n');
}

/** Markdown form for the V3 prompt-composer user section. */
export function renderTerminologyHintMarkdown(hints: readonly TerminologyHint[]): string {
  if (!hints.length) return '';
  const bullets = hints
    .map((h) => `- heard "${h.heard}" ≈ evidence "${h.evidenceTerm}"`)
    .join('\n');
  return [
    '# Terminology note (non-authoritative ASR near-miss hint)',
    'Speech recognition may have mistyped terms in the question. Prefer evidence terminology when answering. Do NOT rewrite the displayed user transcript.',
    bullets,
  ].join('\n');
}
