// Unified manual-chat answer payload (Change 41).
// Keeps gemini-stream-done's existing finalText / streamId / citationMarkers
// fields and adds the canonical { text, citations, ragUsed?, confidence?, sources? }
// shape without a second citation type.
import type { RagCitationMarker } from './RagCitation';

export interface ChatAnswerContract {
  text: string;
  citations: Record<string, RagCitationMarker>;
  ragUsed: boolean;
  confidence?: number;
  sources?: string[];
}

export function toChatAnswerContract(input: {
  text: string;
  citations?: Record<string, RagCitationMarker> | null;
  ragUsed?: boolean;
  confidence?: number;
  sources?: string[];
}): ChatAnswerContract {
  const citations = input.citations && typeof input.citations === 'object' ? input.citations : {};
  const ragUsed = input.ragUsed ?? Object.keys(citations).length > 0;
  const sources = input.sources ?? [...new Set(
    Object.values(citations)
      .map((entry) => entry?.citation?.documentName)
      .filter((name): name is string => Boolean(name && String(name).trim())),
  )];
  return {
    text: String(input.text ?? ''),
    citations,
    ragUsed,
    ...(typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? { confidence: input.confidence }
      : {}),
    ...(sources.length ? { sources } : {}),
  };
}

export function chatAnswerIpcFields(contract: ChatAnswerContract): ChatAnswerContract & {
  citationMarkers?: Record<string, RagCitationMarker>;
} {
  return {
    text: contract.text,
    citations: contract.citations,
    ragUsed: contract.ragUsed,
    ...(contract.confidence !== undefined ? { confidence: contract.confidence } : {}),
    ...(contract.sources && contract.sources.length ? { sources: contract.sources } : {}),
    ...(Object.keys(contract.citations).length ? { citationMarkers: contract.citations } : {}),
  };
}
