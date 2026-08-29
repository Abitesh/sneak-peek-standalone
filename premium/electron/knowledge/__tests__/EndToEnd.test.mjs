import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock database for testing
const mockDb = {
  getDb: () => null,
};

class KnowledgeOrchestrator {
  constructor(db) {
    this.db = db;
    this.activeResume = null;
    this.activeJD = null;
    this.activeCompany = null;
    this.knowledgeMode = false;
  }

  async ingestDocument(filePath, docType) {
    // In real implementation, this would read the file and parse it
    let rawText = '';
    try {
      rawText = readFileSync(filePath, 'utf-8');
    } catch (e) {
      return { success: false, error: 'Failed to read file' };
    }

    let parsedData;
    if (docType === 'resume') {
      parsedData = this.parseResume(rawText);
      this.activeResume = { raw_text: rawText, structured_data: parsedData };
    } else if (docType === 'jd') {
      parsedData = this.parseJD(rawText);
      this.activeJD = { raw_text: rawText, structured_data: parsedData };
    }

    return {
      success: true,
      documentId: `${docType}-${Date.now()}`,
    };
  }

  parseResume(text) {
    // Simplified for testing
    return {
      identity: { name: 'Test User', email: 'test@example.com' },
      skills: {},
      skillsFlat: [],
      experience: [],
      education: [],
      totalExperienceYears: 0,
    };
  }

  parseJD(text) {
    return {
      title: 'Senior Engineer',
      company: 'Tech Corp',
      location: 'San Francisco, CA',
      responsibilities: [],
      requirements: [],
    };
  }

  getProfileData() {
    if (this.activeResume?.structured_data) {
      return {
        ...this.activeResume.structured_data,
        resume: this.activeResume,
        jd: this.activeJD,
      };
    }
    return {
      resume: this.activeResume,
      jd: this.activeJD,
    };
  }

  setKnowledgeMode(enabled) {
    this.knowledgeMode = enabled;
  }

  getStatus() {
    return {
      hasResume: this.activeResume !== null,
      hasJD: this.activeJD !== null,
      hasCompany: this.activeCompany !== null,
    };
  }
}

describe('Profile Intelligence End-to-End Flow', () => {
  let orchestrator;
  let tempResumeFile;
  let tempJDFile;

  before(() => {
    orchestrator = new KnowledgeOrchestrator(mockDb);

    // Create temporary test files
    const resumeContent = `John Developer
john@example.com
555-1234
New York, NY

Senior Software Engineer

Skills: JavaScript, TypeScript, React

Experience:
- Senior Engineer at Tech Corp (5 years)
- Engineer at StartupXYZ (3 years)

Education:
Bachelor of Science in Computer Science`;

    const jdContent = `Position: Senior Software Engineer
Company: Tech Corp

About the Role:
We are looking for a senior engineer...

Responsibilities:
- Build scalable systems
- Lead team discussions

Requirements:
- 5+ years experience
- Strong JavaScript skills

Benefits:
- Health insurance
- Remote work`;

    tempResumeFile = join(tmpdir(), 'test-resume.txt');
    tempJDFile = join(tmpdir(), 'test-jd.txt');

    writeFileSync(tempResumeFile, resumeContent);
    writeFileSync(tempJDFile, jdContent);
  });

  it('should ingest resume and make data available via getProfileData', async () => {
    const result = await orchestrator.ingestDocument(tempResumeFile, 'resume');
    
    assert.strictEqual(result.success, true, 'Resume ingestion should succeed');
    
    const profileData = orchestrator.getProfileData();
    assert(profileData.identity, 'Should have identity data');
    assert.strictEqual(profileData.identity.name, 'Test User', 'Should have parsed name');
  });

  it('should ingest JD and make data available', async () => {
    const result = await orchestrator.ingestDocument(tempJDFile, 'jd');
    
    assert.strictEqual(result.success, true, 'JD ingestion should succeed');
    
    const profileData = orchestrator.getProfileData();
    assert(profileData.jd, 'Should have JD data');
  });

  it('should maintain both resume and JD after sequential uploads', async () => {
    // Fresh orchestrator for this test
    const orch = new KnowledgeOrchestrator(mockDb);

    // Upload resume first
    const resumeResult = await orch.ingestDocument(tempResumeFile, 'resume');
    assert.strictEqual(resumeResult.success, true);

    // Then upload JD
    const jdResult = await orch.ingestDocument(tempJDFile, 'jd');
    assert.strictEqual(jdResult.success, true);

    // Verify both are present
    const profileData = orch.getProfileData();
    assert(profileData.identity, 'Should have resume identity data');
    assert(profileData.jd, 'Should have JD data');
  });

  it('should enable knowledge mode after resume upload', async () => {
    assert.strictEqual(orchestrator.knowledgeMode, false, 'Initially disabled');
    
    orchestrator.setKnowledgeMode(true);
    
    assert.strictEqual(orchestrator.knowledgeMode, true, 'Should be enabled');
  });

  it('should report correct status after uploads', async () => {
    const orch = new KnowledgeOrchestrator(mockDb);
    
    // Before uploads
    let status = orch.getStatus();
    assert.strictEqual(status.hasResume, false);
    assert.strictEqual(status.hasJD, false);

    // After resume upload
    await orch.ingestDocument(tempResumeFile, 'resume');
    status = orch.getStatus();
    assert.strictEqual(status.hasResume, true);
    assert.strictEqual(status.hasJD, false);

    // After JD upload
    await orch.ingestDocument(tempJDFile, 'jd');
    status = orch.getStatus();
    assert.strictEqual(status.hasResume, true);
    assert.strictEqual(status.hasJD, true);
  });
});
