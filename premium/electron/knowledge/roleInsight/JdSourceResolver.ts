/**
 * JdSourceResolver - Premium Implementation
 * 
 * Resolves job descriptions from URLs using a company search provider
 * (e.g., Tavily Search API). Fetches and extracts job posting content.
 */

export interface ResolvedJD {
  text: string;
  source?: string;
  timestamp?: string;
}

/**
 * Resolve a job description from a URL
 * 
 * @param url - The job posting URL
 * @param searchProvider - A search provider with extractUrl capability
 * @param context - Additional context (unused in basic implementation)
 * @returns Resolved JD text or null if unable to fetch
 */
export async function resolveFromUrl(
  url: string,
  searchProvider: any,
  context: string
): Promise<ResolvedJD | null> {
  if (!url || !searchProvider || typeof searchProvider.extractUrl !== 'function') {
    return null;
  }

  try {
    // Use the search provider to extract content from the URL
    const extracted = await searchProvider.extractUrl(url);
    
    if (!extracted || !extracted.content) {
      return null;
    }

    return {
      text: extracted.content,
      source: url,
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error('[JdSourceResolver] Failed to resolve JD from URL:', error);
    return null;
  }
}

export class JdSourceResolver {
  /**
   * Resolve job description from various sources
   */
  static async resolve(source: string, provider: any): Promise<ResolvedJD | null> {
    // If source is a URL, resolve from URL
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return resolveFromUrl(source, provider, '');
    }

    // Otherwise treat as raw text
    return {
      text: source,
      timestamp: new Date().toISOString(),
    };
  }
}
