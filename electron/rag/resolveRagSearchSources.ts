import type { RagQueryPlan, RagSourceSelection } from './RagQueryPlanner';
import type { RagSourceType } from './storage/RagStorageTypes';

const DOCUMENT_FAMILIES = new Set<RagSourceSelection>([
  'mode-reference',
  'personal-files',
  'meeting',
  'knowledge',
]);

export interface RagSearchSourceOptions {
  selectedSources?: readonly RagSourceSelection[];
  allowedSources?: readonly RagSourceSelection[];
  source?: RagSourceType | 'all';
  forceDocumentGrounding?: boolean;
}

function unique(sources: readonly RagSourceSelection[]): RagSourceSelection[] {
  return [...new Set(sources)];
}

function exactSources(selected?: readonly RagSourceSelection[]): RagSourceSelection[] | null {
  if (!Array.isArray(selected) || selected.length === 0) return null;
  return unique(selected);
}

function fromLegacySource(source: RagSourceType | 'all'): RagSourceSelection[] {
  if (source === 'meeting') return ['meeting'];
  if (source === 'mode') return ['mode-reference'];
  if (source === 'personal') return ['personal-files'];
  return ['meeting', 'mode-reference', 'knowledge', 'personal-files'];
}

function capAllowed(
  sources: readonly RagSourceSelection[],
  allowed?: readonly RagSourceSelection[],
): RagSourceSelection[] {
  if (!Array.isArray(allowed)) return [...sources];
  const allow = new Set(allowed);
  return sources.filter((source) => source === 'conversation' || allow.has(source));
}

function hasDocumentFamily(sources: readonly RagSourceSelection[]): boolean {
  return sources.some((source) => DOCUMENT_FAMILIES.has(source));
}

/**
 * Change 29/31 follow-up: `selectedSources` is an exact retrieval request.
 * `allowedSources` is an authorization cap and must not replace the planner.
 */
export function resolveRagSearchSources(
  plan: Pick<RagQueryPlan, 'sources' | 'needsDocumentEvidence'>,
  options: RagSearchSourceOptions = {},
): { skip: boolean; sources: RagSourceSelection[] } {
  const exact = exactSources(options.selectedSources);
  const force = options.forceDocumentGrounding === true;
  if (!plan.needsDocumentEvidence && !force && !exact && !options.source) {
    return { skip: true, sources: [] };
  }

  let sources = exact
    ?? (options.source ? fromLegacySource(options.source) : unique(plan.sources));
  sources = capAllowed(sources, options.allowedSources);

  if (force && !hasDocumentFamily(sources) && Array.isArray(options.allowedSources)) {
    sources = unique(options.allowedSources);
  }

  return { skip: false, sources };
}
