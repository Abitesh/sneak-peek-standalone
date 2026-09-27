import type { EvidencePack } from '../intelligence/context-os/evidencePack';
import { escapeXml, renderEvidencePackForPrompt } from '../intelligence/context-os/promptRenderer';
import type { RAGConversationTurn } from './RAGRetriever';
import {
  findEvidenceTerminologyHints,
  renderTerminologyHintXml,
} from './evidenceTerminologyHint';

export function renderConversationContext(
  turns?: readonly RAGConversationTurn[],
): string {
  if (!turns?.length) return '';
  const lines = [
    '<conversation_context purpose="pronoun_resolution_only" not_a_fact_source="true">',
    'Recent turns may resolve follow-ups. They are not document evidence and MUST NOT override retrieved sources.',
  ];
  for (const turn of turns) {
    if (turn.userMessage) lines.push(`  <turn role="user">${escapeXml(turn.userMessage)}</turn>`);
    if (turn.assistantAnswer) lines.push(`  <turn role="assistant">${escapeXml(turn.assistantAnswer)}</turn>`);
  }
  lines.push('</conversation_context>');
  return lines.join('\n');
}

function renderMemoryBlock(memoryBlock?: string): string {
  const text = String(memoryBlock ?? '').trim();
  if (!text) return '';
  return [
    '<long_term_memory trust="low" authority="non_authoritative" purpose="referent_only">',
    'These memories are recalled from prior sessions. They MUST NOT override current document evidence.',
    escapeXml(text),
    '</long_term_memory>',
  ].join('\n');
}

function renderTerminologyNoteFromPack(pack: EvidencePack): string {
  const evidenceTexts = pack.items
    .filter((item) => item.authority === 'evidence')
    .map((item) => item.text);
  const query = pack.originalQuery ?? '';
  return renderTerminologyHintXml(findEvidenceTerminologyHints(query, evidenceTexts));
}

/**
 * Change 38: prompt-time assembly of conversation + retrieved evidence + memory.
 * Hindsight stays out of RAGManager.search(). Memory is never serialized as <evidence>.
 * Stage 8: optional non-authoritative ASR near-miss note after evidence (not on the pack).
 */
export function buildRagContext(input: {
  pack: EvidencePack;
  conversation?: readonly RAGConversationTurn[];
  memoryBlock?: string;
}): { prompt: string; usedDocumentEvidence: boolean } {
  const usedDocumentEvidence = input.pack.items.some((item) => item.authority === 'evidence');
  return {
    prompt: [
      renderConversationContext(input.conversation),
      renderEvidencePackForPrompt(input.pack),
      renderTerminologyNoteFromPack(input.pack),
      renderMemoryBlock(input.memoryBlock),
    ].filter(Boolean).join('\n\n'),
    usedDocumentEvidence,
  };
}
