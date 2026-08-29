// electron/services/__tests__/FileProfileChatPipeline.test.mjs
// Validates the end-to-end FILE → PROFILE INTELLIGENCE → CHAT pipeline
// Hard test-based validation of real data flow through the system

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESUME_FIXTURE = `
NAME: Sarah Chen
EMAIL: sarah.chen@gmail.com
PHONE: +1-555-0100
LOCATION: San Francisco, CA
GITHUB: github.com/sarahchen
LINKEDIN: linkedin.com/in/sarahchen

PROFESSIONAL SUMMARY
Full-stack engineer passionate about building scalable distributed systems and mentoring junior developers. 8 years of experience in fintech and infrastructure.

EXPERIENCE
Stripe - Senior Software Engineer (2021-03 to present)
- Led development of fraud detection pipeline processing 10M+ transactions daily
- Reduced false positive rate from 8% to 2% through ML model optimization
- Mentored team of 4 junior engineers

Notion - Software Engineer (2018-06 to 2021-02)
- Built collaborative commenting and mentions system used by 10M+ users
- Implemented real-time sync for offline-first mobile app
- Designed schema migrations for multi-tenant database

Cruise Automation - Software Engineer (2016-07 to 2018-05)
- Developed telemetry dashboards for autonomous vehicle fleet management
- Created ETL pipeline processing 100GB+ of sensor data daily

SKILLS
Languages: TypeScript, Python, Go, Rust
Frontend: React, Vue.js, GraphQL
Backend: Node.js, Django, FastAPI
Databases: PostgreSQL, MongoDB, Redis
Cloud: AWS (Lambda, S3, RDS), GCP
Tools: Kubernetes, Docker, Git, Terraform

EDUCATION
Stanford University | BS Computer Science | 2012-09 to 2016-06
`;

const JD_FIXTURE = `
Job Title: Senior Backend Engineer
Company: Anthropic
Location: San Francisco, CA
Level: Senior
Employment Type: Full-time

Job Description:
We're looking for a Senior Backend Engineer to join our team building reliable, scalable AI systems. You'll work on core infrastructure that powers our products.

Requirements:
- 5+ years of software engineering experience
- Strong proficiency in Python or Go
- Experience with distributed systems and microservices
- Database design and optimization experience
- Experience with container orchestration (Kubernetes) and cloud platforms
- Strong understanding of networking, concurrency, and system design

Nice to Haves:
- Experience with machine learning infrastructure
- Background in cryptography or security
- Open-source contributions

Responsibilities:
- Design and implement scalable backend services
- Mentor junior engineers and contribute to technical culture
- Participate in architectural decisions
- On-call rotation and incident response

Technologies: Python, Go, Kubernetes, PostgreSQL, Redis, gRPC, Protocol Buffers
`;

function makeTempFile(content, ext = '.txt') {
    const tmp = path.join(__dirname, `__fixture_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmp, content, 'utf-8');
    return tmp;
}

// Dynamic imports
const { KnowledgeDatabaseManager } = await import(
    pathToFileURL(path.resolve(__dirname, '../../../dist-electron/premium/electron/knowledge/KnowledgeDatabaseManager.js')).href
);
const { KnowledgeOrchestrator } = await import(
    pathToFileURL(path.resolve(__dirname, '../../../dist-electron/premium/electron/knowledge/KnowledgeOrchestrator.js')).href
);
const { DocType } = await import(
    pathToFileURL(path.resolve(__dirname, '../../../dist-electron/premium/electron/knowledge/types.js')).href
);
const { buildGroundingBlock } = await import(
    pathToFileURL(path.resolve(__dirname, '../../../dist-electron/premium/electron/knowledge/ProfileContextBuilder.js')).href
);
const Database = (await import('better-sqlite3')).default;

// Mock LLM content generator
const MOCK_GENERATE_CONTENT_REALISTIC = async (contents) => {
    const prompt = contents[0]?.text || '';
    
    // Resume parsing
    if (prompt.includes('RESUME TEXT') || prompt.toLowerCase().includes('resume')) {
        return JSON.stringify({
            identity: {
                name: 'Sarah Chen',
                email: 'sarah.chen@gmail.com',
                phone: '+1-555-0100',
                location: 'San Francisco, CA',
                linkedin: 'linkedin.com/in/sarahchen',
                github: 'github.com/sarahchen',
                summary: 'Full-stack engineer passionate about building scalable systems and mentoring junior developers'
            },
            skills: {
                languages: ['TypeScript', 'Python', 'Go', 'Rust'],
                frontend: ['React', 'Vue.js', 'GraphQL'],
                backend: ['Node.js', 'Django', 'FastAPI'],
                databases: ['PostgreSQL', 'MongoDB', 'Redis'],
                cloud: ['AWS (Lambda, S3, RDS)', 'GCP'],
                tools: ['Kubernetes', 'Docker', 'Git', 'Terraform']
            },
            experience: [
                {
                    company: 'Stripe',
                    role: 'Senior Software Engineer',
                    start_date: '2021-03',
                    end_date: null,
                    bullets: [
                        'Led development of fraud detection pipeline processing 10M+ transactions daily',
                        'Reduced false positive rate from 8% to 2% through ML model optimization',
                        'Mentored team of 4 junior engineers'
                    ]
                },
                {
                    company: 'Notion',
                    role: 'Software Engineer',
                    start_date: '2018-06',
                    end_date: '2021-02',
                    bullets: [
                        'Built collaborative commenting and mentions system used by 10M+ users',
                        'Implemented real-time sync for offline-first mobile app',
                        'Designed schema migrations for multi-tenant database'
                    ]
                },
                {
                    company: 'Cruise Automation',
                    role: 'Software Engineer',
                    start_date: '2016-07',
                    end_date: '2018-05',
                    bullets: [
                        'Developed telemetry dashboards for autonomous vehicle fleet management',
                        'Created ETL pipeline processing 100GB+ of sensor data daily'
                    ]
                }
            ],
            education: [
                {
                    institution: 'Stanford University',
                    degree: 'BS',
                    field: 'Computer Science',
                    start_date: '2012-09',
                    end_date: '2016-06',
                    gpa: ''
                }
            ],
            projects: [],
            achievements: [],
            certifications: [],
            leadership: []
        });
    }
    
    // JD parsing
    return JSON.stringify({
        title: 'Senior Backend Engineer',
        company: 'Anthropic',
        location: 'San Francisco, CA',
        description_summary: 'We are looking for a Senior Backend Engineer to join our team building reliable, scalable AI systems.',
        level: 'senior',
        employment_type: 'full_time',
        min_years_experience: 5,
        compensation_hint: '',
        requirements: [
            '5+ years of software engineering experience',
            'Strong proficiency in Python or Go',
            'Experience with distributed systems and microservices',
            'Database design and optimization experience',
            'Experience with container orchestration (Kubernetes) and cloud platforms',
            'Strong understanding of networking, concurrency, and system design'
        ],
        nice_to_haves: [
            'Experience with machine learning infrastructure',
            'Background in cryptography or security',
            'Open-source contributions'
        ],
        responsibilities: [
            'Design and implement scalable backend services',
            'Mentor junior engineers and contribute to technical culture',
            'Participate in architectural decisions',
            'On-call rotation and incident response'
        ],
        technologies: ['Python', 'Go', 'Kubernetes', 'PostgreSQL', 'Redis', 'gRPC', 'Protocol Buffers'],
        keywords: ['distributed systems', 'backend', 'infrastructure', 'AI systems', 'mentoring'],
        qualifications: ['5+ years backend engineering', 'Python or Go proficiency', 'system design knowledge']
    });
};

const MOCK_EMBED_FN = async () => Array(128).fill(0).map((_, i) => (i % 7) * 0.01);

// ===========================================================================
// TEST SUITE: FILE → PROFILE INTELLIGENCE → CHAT PIPELINE
// ===========================================================================
describe('FILE + PROFILE INTELLIGENCE + JD + CHAT USING FILE CONTENT', () => {
    let db, orchestrator, tmpResume, tmpJd;

    beforeEach(() => {
        db = new KnowledgeDatabaseManager(new Database(':memory:'));
        db.initializeSchema();
        orchestrator = new KnowledgeOrchestrator(db);
        orchestrator.setGenerateContentFn(MOCK_GENERATE_CONTENT_REALISTIC);
        orchestrator.setEmbedFn(MOCK_EMBED_FN);
        tmpResume = makeTempFile(RESUME_FIXTURE, '.txt');
        tmpJd = makeTempFile(JD_FIXTURE, '.txt');
    });

    afterEach(() => {
        try { fs.unlinkSync(tmpResume); } catch {}
        try { fs.unlinkSync(tmpJd); } catch {}
        try { db.close?.(); } catch {}
    });

    test('STEP 1: Resume file is ingested and structured data extracted', async () => {
        const result = await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        assert.equal(result.success, true, `Resume ingest failed: ${result.error}`);
        
        const profile = orchestrator.getProfileData();
        assert.ok(profile, 'Profile data must exist after resume ingest');
        assert.equal(profile.identity.name, 'Sarah Chen', 'Identity name must match LLM extraction');
        assert.equal(profile.identity.email, 'sarah.chen@gmail.com', 'Identity email must match LLM extraction');
        assert.ok(Array.isArray(profile.experience), 'Experience must be an array');
        assert.ok(profile.experience.length >= 2, 'Should extract multiple experience entries');
        assert.ok(profile.skillsFlat && profile.skillsFlat.length > 0, 'Skills must be extracted');
    });

    test('STEP 2: JD file is ingested and job requirements extracted', async () => {
        const result = await orchestrator.ingestDocument(tmpJd, DocType.JD);
        assert.equal(result.success, true, `JD ingest failed: ${result.error}`);
        
        const profile = orchestrator.getProfileData();
        assert.ok(profile, 'Profile data must exist after JD ingest');
        assert.equal(profile.hasActiveJD, true, 'Profile should indicate active JD');
        assert.equal(profile.activeJD.title, 'Senior Backend Engineer', 'JD title must match');
        assert.equal(profile.activeJD.company, 'Anthropic', 'JD company must match');
        assert.ok(Array.isArray(profile.activeJD.technologies), 'JD technologies must be an array');
        assert.ok(profile.activeJD.technologies.includes('Python'), 'JD technologies must include Python');
        assert.ok(profile.activeJD.technologies.includes('Kubernetes'), 'JD technologies must include Kubernetes');
    });

    test('STEP 3: Resume + JD both available simultaneously for chat context', async () => {
        // Ingest both
        const resumeResult = await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        assert.equal(resumeResult.success, true);
        
        const jdResult = await orchestrator.ingestDocument(tmpJd, DocType.JD);
        assert.equal(jdResult.success, true);
        
        // Get combined profile
        const profile = orchestrator.getProfileData();
        assert.ok(profile.resume, 'Resume data must be accessible');
        assert.ok(profile.hasActiveJD, 'JD must be marked as active');
        assert.ok(profile.activeJD, 'Active JD data must be accessible');
        
        // Both candidate and target job data available
        assert.equal(profile.identity.name, 'Sarah Chen');
        assert.equal(profile.activeJD.title, 'Senior Backend Engineer');
    });

    test('STEP 4: Knowledge mode enables when profile is uploaded', async () => {
        // Initially mode is OFF
        assert.equal(orchestrator.isKnowledgeMode(), false, 'Knowledge mode must be OFF initially');
        
        // Upload resume
        const result = await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        assert.equal(result.success, true);
        
        // Mode can be enabled
        orchestrator.setKnowledgeMode(true);
        assert.equal(orchestrator.isKnowledgeMode(), true, 'Knowledge mode must be enabled after ingest');
    });

    test('STEP 5: Profile context is renderable as grounding block for LLM', async () => {
        // Ingest resume and JD
        await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        await orchestrator.ingestDocument(tmpJd, DocType.JD);
        
        // Get profile data
        const profile = orchestrator.getProfileData();
        assert.ok(profile.resume, 'Resume must be available for rendering');
        assert.ok(profile.activeJD, 'JD must be available for rendering');
        
        // Build grounding block for chat injection
        // Note: buildGroundingBlock expects resume with structured_data, and jd as structured_data
        const resumeForRendering = profile.resume ? { structured_data: profile.resume.structured_data || profile.resume } : null;
        // activeJD is already the structured data (returned from getProfileData)
        const jdForRendering = profile.activeJD ? { structured_data: profile.activeJD } : null;
        
        const groundingResult = buildGroundingBlock(resumeForRendering, jdForRendering);
        assert.ok(groundingResult, 'Grounding block must be creatable');
        assert.ok(groundingResult.block && groundingResult.block.length > 0, 'Grounding block content must exist');
        assert.ok(groundingResult.hasResume === true, 'Grounding must indicate resume presence');
        assert.ok(groundingResult.hasJD === true, 'Grounding must indicate JD presence');
        
        // Block should be XML with candidate and target job sections
        assert.ok(groundingResult.block.includes('<profile_grounding>'), 'Block must have grounding wrapper');
        assert.ok(groundingResult.block.includes('<candidate_profile>'), 'Block must have candidate profile section');
        assert.ok(groundingResult.block.includes('<target_job>'), 'Block must have target job section');
    });

    test('STEP 6: Privacy scoping ensures user data is properly marked', async () => {
        await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        await orchestrator.ingestDocument(tmpJd, DocType.JD);
        
        const profile = orchestrator.getProfileData();
        const resumeForRendering = profile.resume ? { structured_data: profile.resume.structured_data || profile.resume } : null;
        const jdForRendering = profile.activeJD ? { structured_data: profile.activeJD } : null;
        const groundingResult = buildGroundingBlock(resumeForRendering, jdForRendering);
        
        // Should include authorization/scoping rules
        assert.ok(groundingResult.block.includes('<authorization>'), 'Block must include authorization rules');
        assert.ok(groundingResult.block.includes('<scoped_security>'), 'Block must include scoping security');
    });

    test('STEP 7: JD-only sessions work (no resume needed for job matching)', async () => {
        // Upload only JD
        const result = await orchestrator.ingestDocument(tmpJd, DocType.JD);
        assert.equal(result.success, true);
        
        const profile = orchestrator.getProfileData();
        assert.equal(profile.resume, null, 'Resume should be null when only JD uploaded');
        assert.ok(profile.hasActiveJD, 'JD should be active');
        assert.ok(profile.activeJD.technologies.includes('Python'), 'JD data must be accessible');
        
        // Grounding block still works without resume
        const jdForRendering = profile.activeJD ? { structured_data: profile.activeJD } : null;
        const groundingResult = buildGroundingBlock(null, jdForRendering);
        assert.ok(groundingResult, 'Grounding must be creatable with JD only');
        assert.ok(groundingResult.hasResume === false, 'Should indicate no resume');
        assert.ok(groundingResult.hasJD === true, 'Should indicate JD present');
    });

    test('STEP 8: Chat can access profile data for LLM context injection', async () => {
        await orchestrator.ingestDocument(tmpResume, DocType.RESUME);
        await orchestrator.ingestDocument(tmpJd, DocType.JD);
        orchestrator.setKnowledgeMode(true);
        
        // Get profile for chat context
        const profile = orchestrator.getProfileData();
        assert.ok(orchestrator.isKnowledgeMode(), 'Knowledge mode must be enabled');
        
        // Profile has all necessary fields for chat context
        assert.ok(profile.identity, 'Identity available for context');
        assert.ok(profile.skills, 'Skills available for context');
        assert.ok(profile.experience, 'Experience available for context');
        assert.ok(profile.activeJD, 'Target job available for context');
        
        // Skills extracted correctly (can be used in chat)
        const skillsArray = profile.skillsFlat || [];
        assert.ok(skillsArray.includes('Python'), 'Skills array includes Python');
        assert.ok(skillsArray.includes('Kubernetes'), 'Skills array includes Kubernetes');
        
        // Experience is detailed (can be used in chat for match scoring)
        assert.ok(profile.experience[0].bullets, 'Experience entries have bullet details');
        assert.ok(profile.experience[0].bullets.length > 0, 'Bullets are populated');
    });

    test('STEP 9: Full pipeline end-to-end', async () => {
        // Upload files (simulating user action)
        assert.equal((await orchestrator.ingestDocument(tmpResume, DocType.RESUME)).success, true);
        assert.equal((await orchestrator.ingestDocument(tmpJd, DocType.JD)).success, true);
        
        // Enable knowledge mode (simulating user toggle)
        orchestrator.setKnowledgeMode(true);
        
        // Verify all data flows through for chat
        const profile = orchestrator.getProfileData();
        assert.ok(orchestrator.isKnowledgeMode(), 'Mode is ON');
        assert.ok(profile.identity.name === 'Sarah Chen', 'Resume identity extracted');
        assert.ok(profile.activeJD.title === 'Senior Backend Engineer', 'JD title extracted');
        assert.ok(profile.experience.length > 0, 'Experience available');
        assert.ok(profile.skillsFlat.length > 0, 'Skills available');
        
        // Context block is renderable for chat prompt injection
        const resumeForRendering = profile.resume ? { structured_data: profile.resume.structured_data || profile.resume } : null;
        const jdForRendering = profile.activeJD ? { structured_data: profile.activeJD } : null;
        const groundingResult = buildGroundingBlock(resumeForRendering, jdForRendering);
        assert.ok(groundingResult.block.length > 0, 'Context block has content for chat');
    });
});
