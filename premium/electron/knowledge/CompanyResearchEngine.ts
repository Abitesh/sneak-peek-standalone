/**
 * CompanyResearchEngine - Premium Implementation
 * 
 * Performs company research using search providers to gather intelligence
 * about companies mentioned in job descriptions or interviews.
 */

export interface CompanyResearch {
  companyName: string;
  description?: string;
  industry?: string;
  size?: string;
  founded?: number;
  website?: string;
  culture?: string[];
  technologies?: string[];
  locations?: string[];
  recentNews?: string[];
  glassdoorRating?: number;
  linkedinFollowers?: number;
}

export interface ResearchResult {
  company: string;
  research: CompanyResearch;
  sources?: string[];
  timestamp?: string;
  confidence?: number;
}

/**
 * Search for company information using provided search provider
 */
export async function searchCompanyInfo(
  companyName: string,
  searchProvider: any
): Promise<ResearchResult | null> {
  if (!companyName || !searchProvider || typeof searchProvider.search !== 'function') {
    return null;
  }

  try {
    const query = `${companyName} company culture technology stack`;
    const results = await searchProvider.search(query);

    if (!results || results.length === 0) {
      return null;
    }

    // Extract structured info from search results
    const research: CompanyResearch = {
      companyName,
      description: results[0]?.text?.slice(0, 500),
      industry: extractIndustry(results),
      technologies: extractTechnologies(results),
      locations: extractLocations(results),
    };

    return {
      company: companyName,
      research,
      sources: results.map((r: any) => r.url).filter((u: any) => u),
      timestamp: new Date().toISOString(),
      confidence: 0.7,
    };
  } catch (error: any) {
    console.error('[CompanyResearchEngine] Research failed:', error.message);
    return null;
  }
}

/**
 * Extract industry from search results
 */
function extractIndustry(results: any[]): string | undefined {
  if (!results || results.length === 0) return undefined;

  const text = (results[0]?.text || '').toLowerCase();

  const industries = [
    'technology', 'fintech', 'healthcare', 'retail', 'manufacturing',
    'education', 'consulting', 'media', 'energy', 'telecommunications'
  ];

  for (const industry of industries) {
    if (text.includes(industry)) {
      return industry;
    }
  }

  return undefined;
}

/**
 * Extract technologies from search results
 */
function extractTechnologies(results: any[]): string[] {
  const tech: Set<string> = new Set();

  const techKeywords = [
    'python', 'javascript', 'java', 'go', 'rust', 'c++',
    'react', 'angular', 'vue', 'node.js', 'django', 'flask',
    'kubernetes', 'docker', 'aws', 'gcp', 'azure',
    'postgresql', 'mongodb', 'redis', 'elasticsearch',
    'machine learning', 'ai', 'nlp', 'cv', 'tensorflow', 'pytorch'
  ];

  for (const result of results || []) {
    const text = (result.text || '').toLowerCase();
    for (const keyword of techKeywords) {
      if (text.includes(keyword)) {
        tech.add(keyword);
      }
    }
  }

  return Array.from(tech);
}

/**
 * Extract locations from search results
 */
function extractLocations(results: any[]): string[] {
  const locations: Set<string> = new Set();
  const geoPattern = /(\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,?\s(?:[A-Z]{2}|[A-Z][a-z]{1,})\b)/g;

  for (const result of results || []) {
    const text = result.text || '';
    const matches = text.match(geoPattern);
    if (matches) {
      matches.forEach(m => locations.add(m.trim()));
    }
  }

  return Array.from(locations).slice(0, 5);  // Limit to 5 locations
}

export class CompanyResearchEngine {
  private cache: Map<string, ResearchResult> = new Map();

  /**
   * Research a company with caching
   */
  async research(
    companyName: string,
    searchProvider: any,
    useCache: boolean = true
  ): Promise<ResearchResult | null> {
    if (useCache && this.cache.has(companyName)) {
      return this.cache.get(companyName) || null;
    }

    const result = await searchCompanyInfo(companyName, searchProvider);

    if (result && useCache) {
      this.cache.set(companyName, result);
    }

    return result;
  }

  /**
   * Clear research cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cached research result
   */
  getCached(companyName: string): ResearchResult | undefined {
    return this.cache.get(companyName);
  }
}

export default CompanyResearchEngine;
