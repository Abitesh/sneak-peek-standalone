import { computeTotalExperience } from './PostProcessor';

export const INTRO_PATTERNS = [
  'tell me about yourself',
  'give me a quick introduction',
  'brief introduction',
  'self-introduction',
  'brief self-introduction',
  'introducing yourself',
  'brief intro',
  'self intro',
  'introduce yourself',
  'describe yourself',
  'how would you describe yourself',
  'summarize who you are',
  'tell us a little about yourself',
  'give me your background',
  'who are you as a candidate',
  'walk me through your background',
  'start by giving a brief introduction of yourself',
  'start by giving me a brief self-intro',
  'start us off with a brief self-introduction',
  'give us a quick self-introduction',
  'could you start by giving us a quick self-introduction',
  'could you start by giving a brief introduction of yourself',
  'give us a brief self-introduction',
];

export function generateCandidateIntro(profile: any, question?: string): string {
  const resume = profile?.structured_data ?? profile ?? {};
  const raw = resume;
  const name = raw.identity?.name || raw.name || 'Candidate';
  const first = String(name).split(/\s+/).filter(Boolean)[0] || 'Candidate';
  const role = raw.experience?.[0]?.role || raw.experience?.[0]?.title || raw.role || 'professional';
  const company = raw.experience?.[0]?.company || raw.experience?.[0]?.organization || raw.company || '';
  const skills = Array.isArray(raw.skillsFlat) ? raw.skillsFlat.slice(0, 4) : [];
  const totalExperienceYears = computeTotalExperience(resume);

  const lead = `I'm ${first}, ${company ? `a ${role} at ${company}` : `a ${role}`}.`;
  const skillSentence = skills.length ? ` I work mainly with ${skills.join(', ')}.` : '';
  const yearsLine = totalExperienceYears > 0 ? `\n- Total years of professional experience: ${totalExperienceYears}` : '';

  const text = [
    "OPEN WITH THE CANDIDATE'S NAME — self-introduction; omitting the name is wrong.",
    `Example: "I'm [Name], a Senior Software Engineer at Acme."`,
    `Candidate background:${yearsLine}`,
    'RULES: STATE THE EXACT YEARS OF EXPERIENCE, not a vague phrase like "the last few years".',
    `Answer:${lead}${skillSentence}`,
    `Fallback: I'm ${first}.`,
  ].join('\n');

  if (!question || !String(question).trim()) return text;
  return text;
}

export interface PromptAssemblyResult {
  isIntroQuestion?: boolean;
  introResponse?: string;
  isBareGreeting?: boolean;
  factualRecall?: boolean;
  contextBlock?: string;
  liveNegotiationResponse?: any;
  sources?: string[];
  confidence?: number;
  grounding?: { resume?: any; jd?: any; company?: any };
  relevantSections?: string[];
}

export class ContextAssembler {
  static assembleContext(resume?: any, jd?: any, company?: any, question?: string): PromptAssemblyResult {
    const buildLead = () => {
      const profile = resume?.structured_data ?? resume ?? {};
      const intro = generateCandidateIntro(profile, question);
      return intro;
    };

    return {
      isIntroQuestion: !!question && INTRO_PATTERNS.some((pattern) => String(question).toLowerCase().includes(pattern)),
      introResponse: buildLead(),
      factualRecall: !!resume || !!jd || !!company,
      contextBlock: this.buildContextBlock(resume, jd, company, question),
      sources: this.collectSources(resume, jd, company),
      grounding: { resume, jd, company },
      relevantSections: this.extractRelevantSections(resume, jd, question),
    };
  }

  static buildContextBlock(resume?: any, jd?: any, company?: any, question?: string): string {
    const profile = resume?.structured_data ?? resume ?? {};
    const lines: string[] = [];
    const leadership = Array.isArray(profile.leadership) ? profile.leadership : [];
    const experience = Array.isArray(profile.experience) ? profile.experience : [];
    const achievements = Array.isArray(profile.achievements) ? profile.achievements : [];
    const projects = Array.isArray(profile.projects) ? profile.projects : [];
    const education = Array.isArray(profile.education) ? profile.education : [];
    const certifications = Array.isArray(profile.certifications) ? profile.certifications : [];
    const q = String(question || '').toLowerCase();

    const skills = Array.isArray(profile.skillsFlat) ? profile.skillsFlat : [];
    const flatSkills = (Array.isArray(profile.skills) ? profile.skills : []).flatMap((entry: any) => Array.isArray(entry) ? entry : [entry]);
    const allSkills = [...new Set([...skills, ...flatSkills].filter(Boolean))];

    const shouldIncludeLeadership =
      leadership.length > 0 && (
        /\b(leadership|led|managed|role at|organization|org|team|committee|president|head|coordinator)\b/.test(q) ||
        leadership.some((item: any) => {
          const org = String(item?.organization || item?.company || '').toLowerCase();
          return org && q.includes(org);
        })
      );

    const shouldIncludeExperience = /\b(experience|work history|worked|career|role|company|projects|skills|background)\b/.test(q);
    const shouldIncludeProjects = /\b(project|projects|built|ship|shipped|portfolio|work on|created)\b/.test(q);
    const shouldIncludeEducation = /\b(education|degree|school|college|university|graduated|study)\b/.test(q);
    const shouldIncludeAchievements = /\b(achievement|awards|honors|recognition|patent|certif|credential)\b/.test(q);
    const shouldIncludeSkills = /\b(skill|skills|stack|technology|tech|tools|languages|frameworks|programming)\b/.test(q);

    if (profile.identity?.name || profile.name) {
      lines.push(`<candidate_identity>\nName: ${profile.identity?.name || profile.name}\n</candidate_identity>`);
    }

    if (shouldIncludeLeadership || (leadership.length > 0 && q && !shouldIncludeExperience && !shouldIncludeProjects && !shouldIncludeEducation && !shouldIncludeSkills && !shouldIncludeAchievements)) {
      lines.push('<candidate_leadership>');
      for (const item of leadership) {
        const role = item?.role || item?.title || 'Leadership';
        const org = item?.organization || item?.company || 'Organization';
        const desc = item?.description || item?.summary || '';
        lines.push(`${role} at ${org}${desc ? ` — ${desc}` : ''}`);
      }
      lines.push('</candidate_leadership>');
    }

    if (shouldIncludeExperience && experience.length > 0) {
      lines.push('<candidate_experience>');
      for (const item of experience.slice(0, 3)) {
        const role = item?.role || item?.title || 'Role';
        const companyName = item?.company || item?.organization || 'Company';
        lines.push(`${role} at ${companyName}`);
      }
      lines.push('</candidate_experience>');
    }

    if (shouldIncludeProjects && projects.length > 0) {
      lines.push('<candidate_projects>');
      for (const item of projects.slice(0, 3)) {
        const name = item?.name || item?.title || 'Project';
        const desc = item?.description || item?.summary || '';
        lines.push(`${name}${desc ? `: ${desc}` : ''}`);
      }
      lines.push('</candidate_projects>');
    }

    if (shouldIncludeEducation && education.length > 0) {
      lines.push('<candidate_education>');
      for (const item of education.slice(0, 3)) {
        const degree = item?.degree || item?.program || 'Degree';
        const institution = item?.institution || item?.school || 'School';
        lines.push(`${degree} at ${institution}`);
      }
      lines.push('</candidate_education>');
    }

    if (shouldIncludeAchievements && achievements.length > 0) {
      lines.push('<candidate_achievements>');
      for (const item of achievements.slice(0, 3)) {
        lines.push(item?.title || item?.description || 'Achievement');
      }
      lines.push('</candidate_achievements>');
    }

    if (shouldIncludeSkills && allSkills.length > 0) {
      lines.push('<candidate_skills>');
      for (const skill of allSkills.slice(0, 6)) {
        lines.push(String(skill));
      }
      lines.push('</candidate_skills>');
    }

    if (shouldIncludeAchievements && certifications.length > 0) {
      lines.push('<candidate_certifications>');
      for (const item of certifications.slice(0, 3)) {
        lines.push(item?.name || item?.title || 'Certification');
      }
      lines.push('</candidate_certifications>');
    }

    if (jd?.structured_data) {
      lines.push(`<target_job>\n${JSON.stringify(jd.structured_data)}\n</target_job>`);
    }

    if (company?.structured_data) {
      lines.push(`<company_research>\n${JSON.stringify(company.structured_data)}\n</company_research>`);
    }

    return lines.join('\n');
  }

  private static collectSources(resume?: any, jd?: any, company?: any): string[] {
    const sources: string[] = [];
    if (resume) sources.push('resume');
    if (jd) sources.push('job_description');
    if (company) sources.push('company_data');
    return sources;
  }

  private static extractRelevantSections(resume?: any, jd?: any, question?: string): string[] {
    const sections: string[] = [];
    const lowerQuestion = String(question || '').toLowerCase();
    if (!lowerQuestion) return sections;

    if (resume?.structured_data) {
      if (lowerQuestion.includes('experience') || lowerQuestion.includes('worked')) sections.push('resume:experience');
      if (lowerQuestion.includes('skill') || lowerQuestion.includes('technology')) sections.push('resume:skills');
      if (lowerQuestion.includes('education') || lowerQuestion.includes('degree')) sections.push('resume:education');
    }
    if (jd?.structured_data) {
      if (lowerQuestion.includes('responsibility') || lowerQuestion.includes('do')) sections.push('jd:responsibilities');
      if (lowerQuestion.includes('qualif') || lowerQuestion.includes('require')) sections.push('jd:qualifications');
    }
    return sections;
  }
}

export default ContextAssembler;
