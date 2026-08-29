/**
 * ContextAssembler - Premium Implementation
 * 
 * Defines types for context assembly and prompt construction for Profile Intelligence.
 * Used by KnowledgeOrchestrator.processQuestion() to return grounded context for LLM calls.
 */

/**
 * Result of processQuestion() - contains grounded context for LLM responses
 * 
 * Used by:
 * - LLMHelper.stream() to inject profile context
 * - IntelligenceEngine for profile grounding
 * - Multiple test suites for validation
 */
export interface PromptAssemblyResult {
  /** True when this is an intro/identity recall question that has a cached response */
  isIntroQuestion?: boolean;
  
  /** Cached identity/intro response if isIntroQuestion is true */
  introResponse?: string;
  
  /** True when response is a bare social greeting ("hi") not a factual answer */
  isBareGreeting?: boolean;
  
  /** True when the result contains factual recall from profile documents */
  factualRecall?: boolean;
  
  /**
   * Structured XML context block containing:
   * - <candidate_profile> with resume data
   * - <target_job> with job description data
   * - <company_research> with company intelligence
   */
  contextBlock?: string;
  
  /**
   * Live negotiation coaching response for compensation/negotiation questions.
   * When present, LLMHelper short-circuits to this instead of LLM call.
   */
  liveNegotiationResponse?: any;
  
  /**
   * Additional metadata and sources (for diagnostics/logging)
   */
  sources?: string[];
  confidence?: number;
  grounding?: {
    resume?: any;
    jd?: any;
    company?: any;
  };
  relevantSections?: string[];
}

export class ContextAssembler {
  /**
   * Assemble context from profile documents for LLM prompting
   */
  static assembleContext(
    resume?: any,
    jd?: any,
    company?: any,
    question?: string
  ): PromptAssemblyResult {
    return {
      text: this.buildContextText(resume, jd, company),
      sources: this.collectSources(resume, jd, company),
      grounding: {
        resume,
        jd,
        company,
      },
      relevantSections: this.extractRelevantSections(resume, jd, question),
    };
  }

  /**
   * Build context text for prompting
   */
  private static buildContextText(resume?: any, jd?: any, company?: any): string {
    const parts: string[] = [];

    if (resume?.structured_data) {
      parts.push(`Resume: ${JSON.stringify(resume.structured_data)}`);
    }

    if (jd?.structured_data) {
      parts.push(`Job Description: ${JSON.stringify(jd.structured_data)}`);
    }

    if (company?.structured_data) {
      parts.push(`Company: ${JSON.stringify(company.structured_data)}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Collect sources for attribution
   */
  private static collectSources(resume?: any, jd?: any, company?: any): string[] {
    const sources: string[] = [];

    if (resume) sources.push('resume');
    if (jd) sources.push('job_description');
    if (company) sources.push('company_data');

    return sources;
  }

  /**
   * Extract relevant sections based on question
   */
  private static extractRelevantSections(
    resume?: any,
    jd?: any,
    question?: string
  ): string[] {
    const sections: string[] = [];

    if (!question) return sections;

    const lowerQuestion = question.toLowerCase();

    // Resume sections
    if (resume?.structured_data) {
      if (lowerQuestion.includes('experience') || lowerQuestion.includes('worked')) {
        sections.push('resume:experience');
      }
      if (lowerQuestion.includes('skill') || lowerQuestion.includes('technology')) {
        sections.push('resume:skills');
      }
      if (lowerQuestion.includes('education') || lowerQuestion.includes('degree')) {
        sections.push('resume:education');
      }
    }

    // JD sections
    if (jd?.structured_data) {
      if (lowerQuestion.includes('responsibility') || lowerQuestion.includes('do')) {
        sections.push('jd:responsibilities');
      }
      if (lowerQuestion.includes('qualif') || lowerQuestion.includes('require')) {
        sections.push('jd:qualifications');
      }
    }

    return sections;
  }
}

export default ContextAssembler;
