// Context OS — structured record of factual evidence actually rendered.
//
// This is produced in the same loop as prompt XML. It is the source-policy
// authority for final validation; string marker checks only verify serialization.
import type { TurnEvidenceKind } from '../../llm/turnSourceDecision';
import type { EvidenceItem, EvidencePack } from './evidencePack';
import type { RagCitation, RagCitationMarker } from '../../rag/RagCitation';
import { citationForEvidenceItem } from '../../rag/RagCitation';
export type RenderedEvidenceFamily =
| 'reference_files'
| 'resume'
| 'projects'
| 'job_description'
| 'transcript'
| 'meeting_rag';
export interface RenderedEvidenceManifest {
packId: string | null;
turnId: string;
evidenceIds: string[];
evidenceKinds: string[];
evidenceFamilies: RenderedEvidenceFamily[];
countsByKind: Record<string, number>;
countsByFamily: Record<RenderedEvidenceFamily, number>;
/** Provenance snapshot for the exact evidence items serialized into the prompt. */
evidenceCitations: Record<string, RagCitation>;
/** Short LLM-facing markers mapped to application-owned canonical citations. */
citationMarkers: Record<string, RagCitationMarker>;
evidenceProvenance: Record<string, {
sourceId: string;
documentId?: string;
documentName?: string;
chunkId?: string;
pageStart?: number;
pageEnd?: number;
section?: string;
heading?: string;
sourceType?: string;
retrievalScore?: number;
rerankScore?: number;
}>;
}
export const RENDERED_EVIDENCE_FAMILIES: RenderedEvidenceFamily[] = [
'reference_files', 'resume', 'projects', 'job_description', 'transcript', 'meeting_rag',
];
export function familyForTurnEvidenceKind(kind: TurnEvidenceKind): RenderedEvidenceFamily {
switch (kind) {
case 'profile_resume': return 'resume';
case 'projects': return 'projects';
case 'profile_jd': return 'job_description';
case 'live_transcript': return 'transcript';
case 'meeting_rag': return 'meeting_rag';
case 'reference_files': return 'reference_files';
}
}
export function familyForRenderedSourceKind(kind: string): RenderedEvidenceFamily | null {
if (kind === 'mode_reference_file' || kind === 'mode_reference_chunk' || kind === 'okf_document_card') return 'reference_files';
if (kind === 'profile_resume') return 'resume';
if (kind === 'profile_project' || kind === 'profile_projects') return 'projects';
if (kind === 'profile_jd') return 'job_description';
if (kind === 'live_transcript') return 'transcript';
if (kind === 'meeting_rag_chunk') return 'meeting_rag';
return null;
}
export function buildRenderedEvidenceManifest(pack: Pick<EvidencePack, 'packId' | 'turnId' | 'items'>): RenderedEvidenceManifest {
const countsByFamily = Object.fromEntries(
RENDERED_EVIDENCE_FAMILIES.map((family) => [family, 0]),
) as Record<RenderedEvidenceFamily, number>;
const countsByKind: Record<string, number> = {};
const evidenceIds: string[] = [];
const evidenceCitations: RenderedEvidenceManifest['evidenceCitations'] = {};
const citationMarkers: RenderedEvidenceManifest['citationMarkers'] = {};
const seenCitationIds = new Set<string>();
const evidenceProvenance: RenderedEvidenceManifest['evidenceProvenance'] = {};
const seenIds = new Set<string>();
for (const item of pack.items) {
if (item.authority !== 'evidence' || seenIds.has(item.evidenceId)) continue;
seenIds.add(item.evidenceId);
evidenceIds.push(item.evidenceId);
const citation = citationForEvidenceItem(item);
const citationId = citation.citationId.trim();
if (citationId && !seenCitationIds.has(citationId)) {
evidenceCitations[citationId] = citation;
const marker = `S${Object.keys(citationMarkers).length + 1}`;
citationMarkers[marker] = {
marker,
evidenceId: item.evidenceId,
citationId,
citation,
};
seenCitationIds.add(citationId);
}
evidenceProvenance[item.evidenceId] = {
sourceId: item.sourceId,
...(item.documentId !== undefined ? { documentId: item.documentId } : {}),
...(item.documentName !== undefined ? { documentName: item.documentName } : {}),
...(item.chunkId !== undefined ? { chunkId: item.chunkId } : {}),
...(item.pageStart !== undefined ? { pageStart: item.pageStart } : {}),
...(item.pageEnd !== undefined ? { pageEnd: item.pageEnd } : {}),
...(item.section !== undefined ? { section: item.section } : {}),
...(item.heading !== undefined ? { heading: item.heading } : {}),
...(item.sourceType !== undefined ? { sourceType: item.sourceType } : {}),
...(item.retrievalScore !== undefined ? { retrievalScore: item.retrievalScore } : {}),
...(item.rerankScore !== undefined ? { rerankScore: item.rerankScore } : {}),
};
countsByKind[item.sourceKind] = (countsByKind[item.sourceKind] ?? 0) + 1;
const family = familyForRenderedSourceKind(item.sourceKind);
if (family) countsByFamily[family] += 1;
}
return {
packId: pack.packId ?? null,
turnId: pack.turnId,
evidenceIds,
evidenceKinds: Object.keys(countsByKind),
evidenceFamilies: RENDERED_EVIDENCE_FAMILIES.filter((family) => countsByFamily[family] > 0),
countsByKind,
countsByFamily,
evidenceCitations,
citationMarkers,
evidenceProvenance,
};
}
export function manifestIncludesSerializedEvidence(
manifest: RenderedEvidenceManifest,
serializedPrompt: string,
): boolean {
return manifest.evidenceIds.every((evidenceId) => serializedPrompt.includes(`id="${evidenceId}"`));
}
