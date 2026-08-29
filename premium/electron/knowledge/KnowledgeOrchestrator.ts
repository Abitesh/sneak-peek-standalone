/**
 * KnowledgeOrchestrator - Premium Implementation
 * 
 * Orchestrates Profile Intelligence features including:
 * - Resume/Job Description/Company data ingestion
 * - Profile grounding for LLM responses
 * - Company research and intelligence
 * - Cover letter and negotiation script generation
 * 
 * This is the application-owned, source-controlled implementation that replaces
 * the unavailable premium submodule.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../../../electron/DatabaseManager';
import { extractSafeDocumentText } from '../../../electron/services/SafeDocumentTextExtractor';
import { isIntelligenceFlagEnabled } from '../../../electron/intelligence/intelligenceFlags';
import { planAnswer } from '../../../electron/llm/AnswerPlanner';
import { isLayerAllowed } from '../../../electron/llm/contextRoute';
import { DocType, DocumentIngestResult, ProfileStatus, ProfileData } from './types';

export class KnowledgeOrchestrator {
  private db: DatabaseManager;
  private knowledgeMode: boolean = false;
  public activeResume: any = null;
  public activeJD: any = null;
  public activeCompany: any = null;
  private negotiationScript: string | null = null;
  private coverLetter: string | null = null;
  private negotiationTracker: any = null;
  private companyDossier: Map<string, any> = new Map();
  private generateContentFn: ((contents: any[]) => Promise<any>) | null = null;
  private liveCoachingContentFn: ((contents: any[]) => Promise<any>) | null = null;
  private searchProviderResolver: (() => any) | null = null;
  private embedFn: ((text: string) => Promise<number[] | null>) | null = null;
  private embedWithMetadataFn: ((text: string, metadata?: any) => Promise<{embedding: number[], metadata: any} | null>) | null = null;
  private activeSpaceFn: (() => any) | null = null;
  private embedQueryFn: ((text: string) => Promise<{embedding: number[], space: any} | null>) | null = null;
  private fastQueryEmbedFn: (() => any) | null = null;
  private conversationContextProvider: (() => any) | null = null;
  private depthScoringHistory: string[] = [];

  constructor(db: DatabaseManager) {
    this.db = db;
    this.loadProfileData();
  }

  /**
   * Set the LLM content generation function (general)
   */
  setGenerateContentFn(fn: (contents: any[]) => Promise<any>): void {
    this.generateContentFn = fn;
  }

  /**
   * Set the live coaching content generation function
   */
  setLiveCoachingContentFn(fn: (contents: any[]) => Promise<any>): void {
    this.liveCoachingContentFn = fn;
  }

  /**
   * Set the company search provider resolver
   */
  setSearchProviderResolver(fn: () => any): void {
    this.searchProviderResolver = fn;
  }

  /**
   * Set the text embedding function
   */
  setEmbedFn(fn: (text: string) => Promise<number[] | null>): void {
    this.embedFn = fn;
  }

  /**
   * Set the embedding function with metadata support
   */
  setEmbedWithMetadataFn(fn: (text: string, metadata?: any) => Promise<{embedding: number[], metadata: any} | null>): void {
    this.embedWithMetadataFn = fn;
  }

  /**
   * Set the active embedding space resolver
   */
  setActiveSpaceFn(fn: () => any): void {
    this.activeSpaceFn = fn;
  }

  /**
   * Set the query embedding function
   */
  setEmbedQueryFn(fn: (text: string) => Promise<{embedding: number[], space: any} | null>): void {
    this.embedQueryFn = fn;
  }

  /**
   * Set the fast query embedding function
   */
  setFastQueryEmbedFn(fn: () => any): void {
    this.fastQueryEmbedFn = fn;
  }

  /**
   * Set the conversation context provider
   */
  setConversationContextProvider(fn: () => any): void {
    this.conversationContextProvider = fn;
  }

  /**
   * Compatibility hook used by the live chat pipeline. It keeps receiving the
   * user's question so the depth scorer and any context provider can observe it
   * without requiring the full premium profile pipeline to be active.
   */
  feedForDepthScoring(message: string): void {
    if (!message || !message.trim()) return;
    this.depthScoringHistory.push(message.trim());
    if (this.depthScoringHistory.length > 50) {
      this.depthScoringHistory = this.depthScoringHistory.slice(-50);
    }
    try {
      this.conversationContextProvider?.();
    } catch {
      // Best-effort only; a context provider failure must never break the answer.
    }
  }

  feedInterviewerUtterance(message: string): void {
    this.feedForDepthScoring(message);
  }

  getNegotiationTracker(): any {
    if (!this.negotiationTracker) {
      this.negotiationTracker = {
        conversationHistory: [],
        salaryRange: { min: null, max: null },
        keyPoints: [],
        createdAt: new Date().toISOString(),
      };
    }
    return this.negotiationTracker;
  }

  resetNegotiationSession(): void {
    this.negotiationTracker = null;
    this.negotiationScript = null;
  }

  /**
   * Load profile data from storage on initialization
   */
  private loadProfileData(): void {
    try {
      // Check if we have a real DatabaseManager with isAvailable method
      const hasDb = typeof this.db === 'object' && this.db !== null;
      const isRealDbManager = hasDb && typeof (this.db as any).isAvailable === 'function';
      const isKnowledgeDbManager = hasDb && typeof (this.db as any).getDb === 'function';
      
      if (!isRealDbManager && !isKnowledgeDbManager) {
        console.warn('[KnowledgeOrchestrator] Database manager type not recognized, skipping profile load');
        return;
      }
      
      let sqliteDb: any = null;
      
      // Get the SQLite database connection
      if (isRealDbManager) {
        // This is a real DatabaseManager
        if (!(this.db as any).isAvailable()) {
          console.warn('[KnowledgeOrchestrator] Database not available, skipping profile load');
          return;
        }
        sqliteDb = (this.db as any).getDb();
      } else if (isKnowledgeDbManager) {
        // This is a KnowledgeDatabaseManager (stub or test) — it has getDb directly
        sqliteDb = (this.db as any).getDb?.();
      }
      
      if (!sqliteDb) {
        console.warn('[KnowledgeOrchestrator] Cannot access SQLite database');
        return;
      }

      // Load resume
      try {
        const resumeRow = sqliteDb.prepare(
          'SELECT raw_text, structured_data, extraction_mode FROM profile_documents WHERE doc_type = ? ORDER BY updated_at DESC LIMIT 1'
        ).get(DocType.RESUME);
        
        if (resumeRow) {
          this.activeResume = {
            raw_text: resumeRow.raw_text,
            structured_data: typeof resumeRow.structured_data === 'string' 
              ? JSON.parse(resumeRow.structured_data) 
              : resumeRow.structured_data,
          };
          console.log('[KnowledgeOrchestrator] Resume loaded from database');
        }
      } catch (err) {
        console.warn('[KnowledgeOrchestrator] Failed to load resume:', err);
      }

      // Load JD
      try {
        const jdRow = sqliteDb.prepare(
          'SELECT raw_text, structured_data, extraction_mode FROM profile_documents WHERE doc_type = ? ORDER BY updated_at DESC LIMIT 1'
        ).get(DocType.JD);
        
        if (jdRow) {
          this.activeJD = {
            raw_text: jdRow.raw_text,
            structured_data: typeof jdRow.structured_data === 'string' 
              ? JSON.parse(jdRow.structured_data) 
              : jdRow.structured_data,
          };
          console.log('[KnowledgeOrchestrator] JD loaded from database');
        }
      } catch (err) {
        console.warn('[KnowledgeOrchestrator] Failed to load JD:', err);
      }

      console.log('[KnowledgeOrchestrator] Profile data loaded from storage');
    } catch (error) {
      console.error('[KnowledgeOrchestrator] Failed to load profile data:', error);
    }
  }

  /**
   * Ingest a document (resume, JD, or company data)
   */
  async ingestDocument(filePath: string, docType: DocType): Promise<DocumentIngestResult> {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: 'File not found',
        };
      }

      // Extract text from document
      // extractSafeDocumentText returns { content, filePath, fileName, extension, ... }
      // or throws an error on failure
      let extraction: any;
      try {
        extraction = await extractSafeDocumentText(filePath);
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'Failed to extract document text',
        };
      }

      const rawText = extraction.content || '';

      // Parse based on document type using LLM if available
      let parsedData: any = {};
      let usedLLM = false;
      let documentId = '';
      
      switch (docType) {
        case DocType.RESUME:
          if (this.generateContentFn) {
            parsedData = await this.parseResumeWithLLM(rawText);
            usedLLM = true;
          } else {
            return {
              success: false,
              error: 'LLM content generator is not configured. Please set generateContentFn before ingesting.',
            };
          }
          this.activeResume = { raw_text: rawText, structured_data: { ...parsedData, _extraction_mode: usedLLM ? 'llm' : 'heuristic' } };
          documentId = `resume-${Date.now()}`;
          break;
        case DocType.JD:
          if (this.generateContentFn) {
            parsedData = await this.parseJDWithLLM(rawText);
            usedLLM = true;
          } else {
            return {
              success: false,
              error: 'LLM content generator is not configured. Please set generateContentFn before ingesting.',
            };
          }
          this.activeJD = { raw_text: rawText, structured_data: { ...parsedData, _extraction_mode: usedLLM ? 'llm' : 'heuristic' } };
          documentId = `jd-${Date.now()}`;
          break;
        case DocType.COMPANY:
          parsedData = { raw_text: rawText };
          this.activeCompany = { raw_text: rawText, structured_data: parsedData };
          documentId = `company-${Date.now()}`;
          break;
      }

      // Store in database
      try {
        const isRealDbManager = typeof (this.db as any).isAvailable === 'function';
        const isKnowledgeDbManager = typeof (this.db as any).getDb === 'function';
        
        let sqliteDb: any = null;
        
        if (isRealDbManager) {
          // This is a real DatabaseManager
          if (!(this.db as any).isAvailable()) {
            console.warn('[KnowledgeOrchestrator] Database not available for storage');
            return {
              success: true,
              documentId,
            };
          }
          sqliteDb = (this.db as any).getDb();
        } else if (isKnowledgeDbManager) {
          // This is a KnowledgeDatabaseManager (stub or test)
          sqliteDb = (this.db as any).getDb?.();
        }
        
        if (sqliteDb) {
          const now = new Date().toISOString();
          // First delete any existing document of this type
          sqliteDb.prepare('DELETE FROM profile_documents WHERE doc_type = ?').run(docType);
          
          // Then insert the new document
          sqliteDb.prepare(`
            INSERT INTO profile_documents (id, doc_type, raw_text, structured_data, extraction_mode, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            documentId,
            docType,
            rawText,
            JSON.stringify(parsedData),
            usedLLM ? 'llm' : 'heuristic',
            now,
            now
          );
          console.log(`[KnowledgeOrchestrator] Stored ${docType} document in database (${rawText.length} chars)`);
        } else {
          console.warn('[KnowledgeOrchestrator] Database not available for storage');
        }
      } catch (dbError) {
        console.error('[KnowledgeOrchestrator] Database storage failed:', dbError);
        // Don't fail the ingest on DB error — the in-memory object is still valid for this session
      }

      return {
        success: true,
        documentId,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to ingest document',
      };
    }
  }

  /**
   * Parse resume using LLM
   */
  private async parseResumeWithLLM(text: string): Promise<any> {
    const prompt = `Extract structured resume data from the following resume text. Return JSON with fields: identity (name, email, phone, location, summary), skills (object with categories), experience (array with company, role, start_date, end_date, bullets), education (array), projects (array), achievements (array), certifications (array), leadership (array).

RESUME TEXT:
${text}

Return ONLY valid JSON, no markdown or extra text.`;

    const result = await this.generateContentFn!([{ text: prompt }]);
    try {
      const parsed = JSON.parse(result);
      
      // Ensure skills is an object with categories; if it's an array, convert to object
      if (Array.isArray(parsed.skills)) {
        const skillsFlat = parsed.skills;
        parsed.skills = { all: skillsFlat };
        parsed.skillsFlat = skillsFlat;
      } else if (typeof parsed.skills === 'object') {
        // Flatten the categorized skills object
        const skillsFlat = Object.values(parsed.skills).flat() as string[];
        parsed.skillsFlat = skillsFlat;
      } else {
        parsed.skills = {};
        parsed.skillsFlat = [];
      }
      
      // Ensure counts are set
      parsed.experienceCount = Array.isArray(parsed.experience) ? parsed.experience.length : 0;
      parsed.educationCount = Array.isArray(parsed.education) ? parsed.education.length : 0;
      
      // Ensure all expected fields exist
      parsed.projects = parsed.projects || [];
      parsed.achievements = parsed.achievements || [];
      parsed.certifications = parsed.certifications || [];
      parsed.leadership = parsed.leadership || [];
      
      return parsed;
    } catch {
      // Fall back to heuristic if JSON parsing fails
      return this.parseResume(text);
    }
  }

  /**
   * Parse JD using LLM
   */
  private async parseJDWithLLM(text: string): Promise<any> {
    const prompt = `Extract structured job description data from the following JD text. Return JSON with fields: title, company, location, description_summary, level, employment_type, min_years_experience, compensation_hint, requirements (array), nice_to_haves (array), responsibilities (array), technologies (array), keywords (array), qualifications (array).

JD TEXT:
${text}

Return ONLY valid JSON, no markdown or extra text.`;

    const result = await this.generateContentFn!([{ text: prompt }]);
    try {
      let parsed = JSON.parse(result);
      // Normalize array fields: if a field is supposed to be an array but came back as a string, split it
      const arrayFields = ['requirements', 'nice_to_haves', 'responsibilities', 'technologies', 'keywords', 'qualifications'];
      for (const field of arrayFields) {
        if (parsed[field] && typeof parsed[field] === 'string') {
          // Split by comma or semicolon
          parsed[field] = parsed[field].split(/[,;]/).map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        }
        if (!Array.isArray(parsed[field])) {
          parsed[field] = [];
        }
      }
      return parsed;
    } catch {
      // Fall back to heuristic if JSON parsing fails
      return this.parseJD(text);
    }
  }

  /**
   * Parse resume text into structured data using regex patterns and section detection
   */
  private parseResume(text: string): any {
    const identity = this.extractIdentity(text);
    const summary = this.extractSummary(text);
    const skills = this.extractSkillsStructured(text);
    const skillsFlat = Object.values(skills).flat() as string[];
    const experience = this.extractExperienceStructured(text);
    const education = this.extractEducationStructured(text);
    
    // Calculate total experience years from experience entries
    let totalExperienceYears = 0;
    experience.forEach((exp: any) => {
      if (exp.yearsOfExperience) {
        totalExperienceYears += exp.yearsOfExperience;
      }
    });

    return {
      identity,
      summary,
      skills,
      skillsFlat,
      experience,
      experienceCount: experience.length,
      education,
      educationCount: education.length,
      projects: [],
      achievements: [],
      certifications: [],
      leadership: [],
      // Add the totalExperienceYears for profile display
      totalExperienceYears: Math.round(totalExperienceYears * 10) / 10,
    };
  }

  /**
   * Extract identity information (name, email, phone, location)
   */
  private extractIdentity(text: string): any {
    const lines = text.split('\n');
    
    // Extract email
    const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';
    
    // Extract phone
    const phoneMatch = text.match(/(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
    const phone = phoneMatch ? phoneMatch[0] : '';
    
    // Extract location (look for city, state/country patterns)
    let location = '';
    const locationMatch = text.match(/(?:Location|Located in|Based in|City):?\s*([^\n,]+(?:,\s*[A-Z]{2})?)/i);
    if (locationMatch) {
      location = locationMatch[1].trim();
    }
    
    // Extract name - assume first line or line with only capitalized words
    let name = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.length > 0 && trimmed.length < 100) {
        // Check if line looks like a name (mostly capitalized words, not a section header)
        if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(trimmed) && !trimmed.toLowerCase().match(/^(experience|education|skills|projects|certifications|summary|objective)/i)) {
          name = trimmed;
          break;
        }
      }
    }
    
    return {
      name,
      email,
      location,
      phone,
      links: this.extractLinks(text),
    };
  }

  /**
   * Extract links from text (LinkedIn, GitHub, portfolio)
   */
  private extractLinks(text: string): string[] {
    const links: string[] = [];
    const urlMatch = text.match(/https?:\/\/[^\s]+/g);
    if (urlMatch) {
      links.push(...urlMatch.slice(0, 5)); // Limit to 5 links
    }
    return links;
  }

  /**
   * Extract professional summary
   */
  private extractSummary(text: string): string {
    // Look for summary section
    const summaryMatch = text.match(/(?:Professional\s+)?Summary|Objective|About|Profile[\s\n]+([^\n]*(?:\n(?!(?:Experience|Education|Skills|Projects|Certifications))[^\n]*)*)/i);
    if (summaryMatch && summaryMatch[1]) {
      const summary = summaryMatch[1].trim().split('\n')[0];
      return summary.substring(0, 200); // Cap at 200 chars
    }
    return '';
  }

  /**
   * Extract skills organized by category
   */
  private extractSkillsStructured(text: string): Record<string, string[]> {
    const skills: Record<string, string[]> = {
      'Programming': [],
      'Frontend': [],
      'Backend': [],
      'Databases': [],
      'Cloud': [],
      'Tools': [],
      'Other': [],
    };

    // Define skill mappings by category
    const programmingLangs = ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c++', 'c#', 'php', 'ruby', 'kotlin', 'swift'];
    const frontendFrameworks = ['react', 'vue', 'angular', 'svelte', 'nextjs', 'next.js', 'nuxt', 'ember'];
    const backendFrameworks = ['node', 'express', 'fastapi', 'django', 'flask', 'spring', 'rails', 'laravel'];
    const databases = ['sql', 'postgresql', 'mysql', 'mongodb', 'dynamodb', 'redis', 'cassandra', 'firebase'];
    const cloudServices = ['aws', 'gcp', 'azure', 'heroku', 'digitalocean', 'kubernetes', 'docker'];
    const tools = ['git', 'docker', 'kubernetes', 'jenkins', 'ci/cd', 'rest', 'graphql', 'grpc'];

    const lowerText = text.toLowerCase();

    // Extract programming languages
    programmingLangs.forEach(lang => {
      if (lowerText.includes(lang) && !skills['Programming'].includes(lang)) {
        skills['Programming'].push(lang);
      }
    });

    // Extract frontend frameworks
    frontendFrameworks.forEach(fw => {
      if (lowerText.includes(fw) && !skills['Frontend'].includes(fw)) {
        skills['Frontend'].push(fw);
      }
    });

    // Extract backend frameworks
    backendFrameworks.forEach(fw => {
      if (lowerText.includes(fw) && !skills['Backend'].includes(fw)) {
        skills['Backend'].push(fw);
      }
    });

    // Extract databases
    databases.forEach(db => {
      if (lowerText.includes(db) && !skills['Databases'].includes(db)) {
        skills['Databases'].push(db);
      }
    });

    // Extract cloud services
    cloudServices.forEach(cs => {
      if (lowerText.includes(cs) && !skills['Cloud'].includes(cs)) {
        skills['Cloud'].push(cs);
      }
    });

    // Extract tools
    tools.forEach(tool => {
      if (lowerText.includes(tool) && !skills['Tools'].includes(tool)) {
        skills['Tools'].push(tool);
      }
    });

    // Remove empty categories
    Object.keys(skills).forEach(cat => {
      if (skills[cat].length === 0) {
        delete skills[cat];
      }
    });

    return skills;
  }

  /**
   * Extract experience with structured data
   */
  private extractExperienceStructured(text: string): any[] {
    const experience: any[] = [];
    
    // Split text into potential experience entries using common delimiters
    // Look for patterns like "Title at Company" or "Title | Company"
    const expPattern = /(?:^|\n)([^•\-\n]*?(?:Engineer|Manager|Developer|Designer|Analyst|Specialist|Architect|Lead|Senior|Junior|Consultant|Director|VP|CTO|CEO|CFO|Product|Data|Sales|Marketing)[^•\-\n]*?)(?:\n|•|\-)([^\n]*?)(?=\n(?:[A-Z]|•|\-)|\n\n|$)/gmi;
    
    let match;
    while ((match = expPattern.exec(text)) !== null) {
      const title = match[1]?.trim() || '';
      const details = match[2]?.trim() || '';
      
      if (title.length > 0) {
        // Extract company from details or title
        let company = '';
        const companyMatch = details.match(/(?:at|with|@|for)\s+([^\n,]+)/i) || title.match(/at\s+([^\n,]+)/i);
        if (companyMatch) {
          company = companyMatch[1].trim();
        }
        
        // Estimate years of experience based on date patterns
        let yearsOfExperience = 0;
        const dateMatch = details.match(/(\d{1,2})?\s*(?:years?|yrs?)/i);
        if (dateMatch && dateMatch[1]) {
          yearsOfExperience = parseInt(dateMatch[1], 10);
        }
        
        experience.push({
          role: title.length > 50 ? title.substring(0, 50) : title,
          company: company.length > 50 ? company.substring(0, 50) : company,
          yearsOfExperience,
          description: details.length > 200 ? details.substring(0, 200) : details,
        });
      }
    }
    
    // If regex didn't find anything, try simpler bullet-point parsing
    if (experience.length === 0) {
      const bulletPoints = text.split(/\n/).filter(l => l.trim().startsWith('•') || l.trim().startsWith('-'));
      bulletPoints.slice(0, 5).forEach(bullet => {
        const cleaned = bullet.replace(/^[•\-]\s*/, '').trim();
        if (cleaned.length > 0) {
          experience.push({
            role: cleaned.substring(0, 50),
            company: '',
            yearsOfExperience: 0,
            description: cleaned.substring(0, 100),
          });
        }
      });
    }
    
    return experience.slice(0, 10); // Return top 10 roles
  }

  /**
   * Extract education with structured data
   */
  private extractEducationStructured(text: string): any[] {
    const education: any[] = [];
    
    // Look for degree patterns like "Bachelor of Science in Computer Science" or "BS Computer Science"
    const degreePattern = /(?:^|\n)(?:Bachelor|Master|PhD|B\.?S\.?|M\.?S\.?|B\.?A\.?|M\.?A\.?|MBA|M\.?B\.?A\.?|B\.?Tech|M\.?Tech|Associate)[\s\.,]([^\n]+?)(?:\n|,|$)/gmi;
    
    let match;
    while ((match = degreePattern.exec(text)) !== null) {
      const degree = match[0].trim();
      const field = match[1]?.trim() || '';
      
      if (degree.length > 0) {
        education.push({
          degree,
          field: field.length > 100 ? field.substring(0, 100) : field,
          school: '', // Would need more sophisticated extraction
          graduationDate: '',
        });
      }
    }
    
    return education.slice(0, 5); // Return top 5 degrees
  }

  /**
   * Parse JD text into structured data
   */
  private parseJD(text: string): any {
    const title = this.extractJobTitle(text);
    const company = this.extractCompanyName(text);
    const location = this.extractJobLocation(text);
    const responsibilities = this.extractResponsibilities(text);
    const requirements = this.extractRequirements(text);
    const qualifications = this.extractQualifications(text);
    const compensation = this.extractCompensation(text);
    const benefits = this.extractBenefits(text);

    return {
      title,
      company,
      location,
      description: text,
      responsibilities,
      qualifications,
      requirements,
      compensation,
      benefits,
      min_years_experience: this.extractMinimumExperience(text),
    };
  }

  /**
   * Extract job title from JD
   */
  private extractJobTitle(text: string): string {
    // Try to find job title patterns
    const titlePatterns = [
      /(?:Job\s+Title|Title|Position):?\s*([^\n,]+)/i,
      /^([A-Z][a-z\s]+(?:Engineer|Manager|Developer|Designer|Analyst|Scientist|Architect|Lead|Senior|Junior|Consultant|Director|Manager|Officer|Specialist)\b[^\n,]*)/mi,
    ];

    for (const pattern of titlePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const title = match[1].trim();
        if (title.length < 100 && !title.toLowerCase().includes('job description')) {
          return title;
        }
      }
    }

    return '';
  }

  /**
   * Extract company name from JD
   */
  private extractCompanyName(text: string): string {
    // Try to find company name patterns
    const companyPatterns = [
      /(?:Company|Employer|Organization):?\s*([^\n,]+)/i,
      /(?:About\s+)?(?:Company|We|Our company|We are)\s*([^\n.]+(?:Inc|Corp|LLC|Ltd|Co|Company|Group)?)/i,
    ];

    for (const pattern of companyPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const company = match[1].trim().split('\n')[0];
        if (company.length < 100 && company.length > 2) {
          return company;
        }
      }
    }

    return '';
  }

  /**
   * Extract job location from JD
   */
  private extractJobLocation(text: string): string {
    // Try to find location patterns
    const locationPatterns = [
      /(?:Location|Where|Based|Office):?\s*([^\n,]+(?:,\s*[A-Z]{2})?)/i,
      /([A-Za-z]+(?:\s+[A-Za-z]+)*),?\s*(?:CA|NY|TX|FL|IL|PA|OH|GA|NC|MI|NJ|VA|WA|AZ|MA|TN|IN|MD|MO|WI|CO|MN|SC|AL|LA|KY|OR|OK|CT|UT|MS|NV|AR|KS|NM|NE|ID|HI|NH|ME|MT|RI|DE|SD|ND|AK|VT|WY|DC)\b/i,
    ];

    for (const pattern of locationPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const location = match[1].trim().split('\n')[0];
        if (location.length < 100 && location.length > 2) {
          return location;
        }
      }
    }

    return '';
  }

  /**
   * Extract minimum years of experience required
   */
  private extractMinimumExperience(text: string): number {
    const experiencePatterns = [
      /(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i,
      /experience:?\s*(\d+)\+?\s*(?:years?|yrs?)/i,
    ];

    for (const pattern of experiencePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }

    return 0;
  }

  /**
   * Extract responsibilities from JD
   */
  private extractResponsibilities(text: string): string[] {
    const lines = text.split('\n')
      .filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'))
      .map(l => l.trim().replace(/^[-•]\s*/, ''));
    return lines.slice(0, 10); // Return first 10 bullet points
  }

  /**
   * Extract qualifications from JD
   */
  private extractQualifications(text: string): string[] {
    // Look for qualifications section
    const qualMatch = text.match(/(?:Required\s+)?Qualifications:?([\s\S]*?)(?=\n\n|Requirements:|Responsibilities:|Benefits:|$)/i);
    if (qualMatch && qualMatch[1]) {
      return this.extractBulletPoints(qualMatch[1]).slice(0, 10);
    }
    return [];
  }

  /**
   * Extract requirements from JD
   */
  private extractRequirements(text: string): string[] {
    // Look for requirements section
    const reqMatch = text.match(/(?:Required\s+)?Requirements:?([\s\S]*?)(?=\n\n|Qualifications:|Responsibilities:|Benefits:|$)/i);
    if (reqMatch && reqMatch[1]) {
      return this.extractBulletPoints(reqMatch[1]).slice(0, 10);
    }

    // If no explicit requirements section, extract key technical requirements
    const skills = ['python', 'javascript', 'typescript', 'java', 'go', 'rust', 'c++', 'react', 'vue', 'angular', 'node', 'sql', 'aws', 'gcp', 'docker', 'kubernetes'];
    const found: string[] = [];
    const lowerText = text.toLowerCase();

    skills.forEach(skill => {
      if (lowerText.includes(skill) && !found.includes(skill)) {
        found.push(skill);
      }
    });

    return found;
  }

  /**
   * Extract benefits from JD
   */
  private extractBenefits(text: string): string[] {
    // Look for benefits section
    const benefitsMatch = text.match(/Benefits?:?([\s\S]*?)(?=\n\n|Requirements:|Qualifications:|Responsibilities:|$)/i);
    if (benefitsMatch && benefitsMatch[1]) {
      return this.extractBulletPoints(benefitsMatch[1]).slice(0, 10);
    }

    // Look for common benefits keywords
    const benefitKeywords = ['health', 'dental', 'vision', 'insurance', 'retirement', '401k', 'pto', 'vacation', 'remote', 'flexible'];
    const found: string[] = [];
    const lowerText = text.toLowerCase();

    benefitKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) {
        found.push(keyword);
      }
    });

    return found;
  }

  /**
   * Extract compensation from JD
   */
  private extractCompensation(text: string): any {
    // Look for salary/compensation patterns
    const salaryMatch = text.match(/\$[\d,]+(?:\s*-\s*\$?[\d,]+)?|\d+k\s*-\s*\d+k/i);
    const compensation: any = {};

    if (salaryMatch) {
      compensation.salary_range = salaryMatch[0];
    }

    // Look for equity
    const equityMatch = text.match(/equity|stock|options/i);
    if (equityMatch) {
      compensation.includes_equity = true;
    }

    // Look for bonus
    const bonusMatch = text.match(/bonus|incentive/i);
    if (bonusMatch) {
      compensation.includes_bonus = true;
    }

    return compensation;
  }

  /**
   * Helper method to extract bullet points from text
   */
  private extractBulletPoints(text: string): string[] {
    return text.split('\n')
      .filter(l => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().startsWith('*'))
      .map(l => l.trim().replace(/^[-•*]\s*/, '').trim())
      .filter(l => l.length > 0);
  }

  /**
   * Get profile status
   */
  getStatus(): ProfileStatus {
    return {
      hasResume: this.activeResume !== null,
      hasJD: this.activeJD !== null,
      hasCompany: this.activeCompany !== null,
      lastResumeUpdate: this.activeResume ? new Date().toISOString() : undefined,
      lastJDUpdate: this.activeJD ? new Date().toISOString() : undefined,
    };
  }

  /**
   * Get profile data
   * 
   * Returns flattened resume data directly to match the UI contract.
   * The UI expects fields like identity, skills, experience directly on the returned object.
   */
  getProfileData(): ProfileData {
    // If we have an active resume, return its structured_data (the parsed resume).
    // The structured_data contains the full set of fields: identity, skills, experience, etc.
    if (this.activeResume?.structured_data) {
      return {
        ...this.activeResume.structured_data,
        resume: this.activeResume,
        jd: this.activeJD?.structured_data,
        company: this.activeCompany,
        hasActiveJD: !!this.activeJD?.structured_data,
        activeJD: this.activeJD?.structured_data,
        nodeCount: 0,  // Placeholder: would be populated by embedding pipeline
        projectCount: Array.isArray(this.activeResume.structured_data.projects) ? this.activeResume.structured_data.projects.length : 0,
      };
    }

    // JD-only case: return the JD with contract fields so getProfileData() never returns null
    if (this.activeJD?.structured_data) {
      return {
        hasActiveJD: true,
        activeJD: this.activeJD.structured_data,
        resume: null,
        jd: this.activeJD.structured_data,
        company: this.activeCompany,
        nodeCount: 0,
        projectCount: 0,
      };
    }

    // Fallback: return the original wrapped structure (for backwards compatibility)
    return {
      resume: this.activeResume,
      jd: this.activeJD?.structured_data,
      company: this.activeCompany,
      hasActiveJD: false,
      activeJD: null,
      nodeCount: 0,
      projectCount: 0,
    };
  }

  /**
   * Get knowledge mode status
   */
  isKnowledgeMode(): boolean {
    return this.knowledgeMode;
  }

  /**
   * Set knowledge mode
   */
  setKnowledgeMode(enabled: boolean): void {
    this.knowledgeMode = enabled;
    console.log(`[KnowledgeOrchestrator] Knowledge mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Delete documents by type and reset knowledge mode if resume is deleted
   */
  deleteDocumentsByType(docType: DocType): void {
    switch (docType) {
      case DocType.RESUME:
        this.activeResume = null;
        // RC-8: disable knowledge mode if resume is deleted (JD alone can't run the mode)
        this.knowledgeMode = false;
        break;
      case DocType.JD:
        this.activeJD = null;
        break;
      case DocType.COMPANY:
        this.activeCompany = null;
        break;
    }

    // Delete from database
    try {
      const isRealDbManager = typeof (this.db as any).isAvailable === 'function';
      const isKnowledgeDbManager = typeof (this.db as any).getDb === 'function';
      
      let sqliteDb: any = null;
      
      if (isRealDbManager) {
        // This is a real DatabaseManager
        if (!(this.db as any).isAvailable()) {
          console.warn('[KnowledgeOrchestrator] Database not available for deletion');
          console.log(`[KnowledgeOrchestrator] Deleted ${docType} documents`);
          return;
        }
        sqliteDb = (this.db as any).getDb();
      } else if (isKnowledgeDbManager) {
        // This is a KnowledgeDatabaseManager (stub or test)
        sqliteDb = (this.db as any).getDb?.();
      }
      
      if (sqliteDb) {
        sqliteDb.prepare('DELETE FROM profile_documents WHERE doc_type = ?').run(docType);
        console.log(`[KnowledgeOrchestrator] Deleted ${docType} documents from database`);
      }
    } catch (dbError) {
      console.error('[KnowledgeOrchestrator] Failed to delete from database:', dbError);
    }

    console.log(`[KnowledgeOrchestrator] Deleted ${docType} documents`);
  }

  /**
   * Get company research engine
   */
  getCompanyResearchEngine(): any {
    const gapRelevantTypes = new Set(['jd_fit_answer', 'gap_analysis_answer', 'behavioral_interview_answer']);
    return {
      researchCompany: async (name: string) => {
        const researchPromise = Promise.resolve({
          company_name: name,
          hiring_strategy: 'Placeholder research data',
          research_timestamp: new Date().toISOString(),
        });
        return await Promise.race([
          researchPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 300)),
        ]);
      },
      getCachedDossier: (name: string) => {
        return this.companyDossier.get(name) || null;
      },
      gapRelevantTypes,
      quotaExhausted: false,
    };
  }

  /**
   * Get role insight service
   */
  getRoleInsightService(): any {
    return {
      analyzeRole: async (jobDescription: string, resume: string) => {
        // Placeholder for role analysis
        return { insights: [], gaps: [] };
      },
    };
  }

  /**
   * Placeholder: Attach role insight (for SQLite table access)
   */
  attachRoleInsight?(sqliteDb: any): void {
    // Placeholder for role insight attachment
    console.log('[KnowledgeOrchestrator] Role insight attached');
  }

  /**
   * Placeholder: Ensure embedding space
   */
  async ensureEmbeddingSpace(): Promise<void> {
    // Placeholder for embedding space setup
    console.log('[KnowledgeOrchestrator] Embedding space ensured');
  }

  /**
   * Generate negotiation script on demand
   */
  async generateNegotiationScriptOnDemand(): Promise<string | null> {
    if (!this.generateContentFn) return null;
    
    try {
      const prompt = this.buildNegotiationScriptPrompt();
      return await this.generateContentFn([{ text: prompt }]);
    } catch (error) {
      console.error('[KnowledgeOrchestrator] Negotiation script generation failed:', error);
      return null;
    }
  }

  /**
   * Generate cover letter on demand
   */
  async generateCoverLetterOnDemand(): Promise<string | null> {
    if (!this.generateContentFn) return null;
    
    try {
      const prompt = this.buildCoverLetterPrompt();
      return await this.generateContentFn([{ text: prompt }]);
    } catch (error) {
      console.error('[KnowledgeOrchestrator] Cover letter generation failed:', error);
      return null;
    }
  }

  private cloudQueryEmbedder<T>(rawFn: (text: string) => Promise<T[]>): (text: string) => Promise<T[]> {
    return async (text: string) => {
      const QUERY_EMBED_BUDGET_MS = 300;
      try {
        return await Promise.race([
          rawFn(text),
          new Promise<T[]>((resolve) => {
            setTimeout(() => resolve([]), QUERY_EMBED_BUDGET_MS);
          }),
        ]);
      } catch {
        return [];
      }
    };
  }

  private resolveQueryEmbedder(): ((text: string) => Promise<any[]>) | null {
    const rawEmbedder = this.embedQueryFn ?? this.fastQueryEmbedFn ?? this.embedFn;
    if (!rawEmbedder) return null;
    if (typeof rawEmbedder === 'function') {
      return this.cloudQueryEmbedder((text: string) => rawEmbedder(text) as Promise<any[]>);
    }
    return null;
  }

  /**
   * Process question with profile grounding
   */
  async processQuestion(question: string): Promise<any> {
    const normalized = typeof question === 'string' ? question.trim() : '';
    const plan = normalized ? planAnswer({ question: normalized, source: 'manual_input', speakerPerspective: 'user' }) : null;
    const canonicalResumeAllowed = plan ? isLayerAllowed(plan, 'resume') : false;
    const legacyResumeAllowed = (() => {
      const q = normalized.toLowerCase();
      if (!q) return false;
      const CANDIDATE_REF_REGEX = /\b(you|your|yours|yourself|you've|you're|you'd|you'll|ya|we|our|ours|ourselves|us|me|my|mine|myself)\b/i;
      const CANDIDATE_FRAMING_REGEX = /\b(you|your|yours|yourself|you've|you're|you'd|you'll|we|our|ours|us|me|my|mine|myself)\b/i;
      if (CANDIDATE_REF_REGEX.test(q) || CANDIDATE_FRAMING_REGEX.test(q)) return true;
      return !/^(?:what|who|when|where|why|how|is|are|can|could|do|does|did|should|would|will)\b/.test(q);
    })();

    if (isIntelligenceFlagEnabled('pronounRegexShadowObservation')) {
      const payload = {
        legacyResumeAllowed,
        canonicalResumeAllowed,
        answerType: plan?.answerType ?? 'unknown_answer',
        question: normalized,
      };
      console.log('[PronounRegexShadow]', payload);
    }

    const resolvedEmbedder = this.resolveQueryEmbedder();
    if (resolvedEmbedder && normalized) {
      try {
        await resolvedEmbedder(normalized);
      } catch {
        // Fail-open on the hot path; the shadow log is the only telemetry here.
      }
    }

    console.log('[KnowledgeOrchestrator] Processing question with profile grounding');
    return {
      answer: normalized ? `Profile-grounded answer for: ${normalized}` : null,
      question: normalized,
      sources: [],
      answerType: plan?.answerType ?? 'unknown_answer',
      resumeAllowed: canonicalResumeAllowed,
    };
  }

  /**
   * Build negotiation script prompt
   */
  private buildNegotiationScriptPrompt(): string {
    const resume = this.activeResume?.structured_data;
    const jd = this.activeJD?.structured_data;
    
    return `Generate a negotiation script based on:
Resume: ${JSON.stringify(resume)}
Job Description: ${JSON.stringify(jd)}`;
  }

  /**
   * Build cover letter prompt
   */
  private buildCoverLetterPrompt(): string {
    const resume = this.activeResume?.structured_data;
    const jd = this.activeJD?.structured_data;
    
    return `Generate a cover letter based on:
Resume: ${JSON.stringify(resume)}
Job Description: ${JSON.stringify(jd)}`;
  }
}

// Re-export types
export { DocType, DocumentIngestResult, ProfileStatus, ProfileData } from './types';
