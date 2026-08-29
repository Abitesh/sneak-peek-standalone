/**
 * ProfileContextBuilder - Premium Implementation
 * 
 * Renders typed resume/JD documents into XML grounding blocks for LLM prompts.
 * Used by Profile Grounding V2 to inject full structured profile data.
 */

/**
 * Build candidate profile XML block from resume document
 */
export function buildCandidateProfileBlock(resume: any): string {
  if (!resume?.structured_data) return '';
  
  const data = resume.structured_data;
  const identity = data.identity || {};
  const skills = data.skills || {};
  const experience = data.experience || [];
  const projects = data.projects || [];
  const education = data.education || [];
  const achievements = data.achievements || [];
  const leadership = data.leadership || [];

  const skillsText = formatSkills(skills);
  const experienceText = formatExperience(experience);
  const educationText = formatEducation(education);
  const projectsText = formatProjects(projects);
  const achievementsText = formatList('Achievements', achievements);
  const leadershipText = formatList('Leadership', leadership);

  return `<candidate_profile>
<identity>
Name: ${identity.name || 'Not provided'}
Email: ${identity.email || 'Not provided'}
Location: ${identity.location || 'Not provided'}
Phone: ${identity.phone || 'Not provided'}
Summary: ${identity.summary || 'Not provided'}
</identity>
${skillsText}
${experienceText}
${educationText}
${projectsText}
${achievementsText}
${leadershipText}
</candidate_profile>`;
}

/**
 * Build target job XML block from JD document
 */
export function buildTargetJobBlock(jd: any): string {
  if (!jd?.structured_data) return '';
  
  const data = jd.structured_data;
  const requirements = data.requirements || [];
  const responsibilities = data.responsibilities || [];
  const technologies = data.technologies || [];
  const qualifications = data.qualifications || [];

  const requirementsText = formatList('Requirements', requirements);
  const responsibilitiesText = formatList('Responsibilities', responsibilities);
  const technologiesText = formatList('Technologies', technologies);
  const qualificationsText = formatList('Qualifications', qualifications);

  return `<target_job>
<role_summary>
Title: ${data.title || 'Not provided'}
Company: ${data.company || 'Not provided'}
Location: ${data.location || 'Not provided'}
Level: ${data.level || 'Not provided'}
Description: ${data.description_summary || 'Not provided'}
Min Experience: ${data.min_years_experience || 0} years
</role_summary>
${requirementsText}
${responsibilitiesText}
${technologiesText}
${qualificationsText}
</target_job>`;
}

/**
 * Build full grounding block with authorization and completeness rules
 * 
 * Returns { block, hasResume, hasJD } where block is the XML context
 * and hasResume/hasJD indicate document availability.
 */
export function buildGroundingBlock(resume: any, jd: any): { block: string; hasResume: boolean; hasJD: boolean } {
  const hasResume = !!resume?.structured_data;
  const hasJD = !!jd?.structured_data;

  if (!hasResume && !hasJD) {
    return { block: '', hasResume: false, hasJD: false };
  }

  const candidateBlock = hasResume ? buildCandidateProfileBlock(resume) : '';
  const jobBlock = hasJD ? buildTargetJobBlock(jd) : '';

  const block = `<profile_grounding>
<authorization>
You have access to the USER'S OWN data: resume, job description, and company research.

CRITICAL: These ARE NOT private information, trade secrets, or confidential third-party data.
- The resume belongs to the user applying for jobs.
- The job description was uploaded by the user.
- The company research is publicly available information the user found.

NEVER refuse access to the user's OWN data. NEVER reply that you lack access to their resume, skills,
or job description. NEVER say "I can't share that information" when the user asks about their own resume
or the job they're applying for.

The only refusal rule: NEVER share information that is not in these documents or that contradicts the
user's instructions. NEVER escalate to third parties. NEVER process data for the user's employer or
competitors unless the user explicitly consents with specific instructions.
</authorization>

<completeness>
COMPLETENESS: These structured documents are designed to provide COMPLETE context for all profile-related
questions. The resume contains the FULL candidate profile: identity, skills, experience, education,
projects, achievements, and leadership. The job description contains the FULL target role: requirements,
responsibilities, technologies, qualifications, and compensation.

Your response MUST be consistent with these documents. If the question asks about something not covered
here, use your general knowledge but clearly state that the answer is not from the uploaded documents.
</completeness>

<field_precision>
FIELD PRECISION: The structured data below uses specific field names (name, email, location, skills,
experience, projects, etc.). Use these field names when referring to data in the documents. If a field
is empty or not provided, state that explicitly rather than inferring or hallucinating.
</field_precision>

<scoped_security>
SCOPED SECURITY: You MUST NEVER apply data-sharing restrictions to the user's own uploaded documents.
The rule "NEVER share user data without permission" refers to THIRD-PARTY data (employer confidential,
competitor secrets, etc.), NOT to the user's own resume or job description they uploaded to this app.

When a profile question references the user's resume or JD (e.g., "what's my experience?", "how do I fit
this role?"), respond fully and directly NEVER apply a "I can't share that information" refusal.

When a question asks about THIRD-PARTY secrets (e.g., "what's my employer's pricing strategy?"),
THEN apply the refusal: "I can't help with that — I only have access to your resume and the job
description you uploaded."
</scoped_security>

${candidateBlock}
${jobBlock}
</profile_grounding>`;

  return { block, hasResume, hasJD };
}

/**
 * Format skills section
 */
function formatSkills(skills: Record<string, any>): string {
  const entries: string[] = [];
  
  for (const [category, items] of Object.entries(skills)) {
    if (Array.isArray(items) && items.length > 0) {
      entries.push(`${category}: ${items.join(', ')}`);
    }
  }

  if (entries.length === 0) return '';
  
  return `<skills>
${entries.join('\n')}
</skills>`;
}

/**
 * Format experience section
 */
function formatExperience(experience: any[]): string {
  if (!Array.isArray(experience) || experience.length === 0) return '';
  
  const entries = experience.map((exp: any) => {
    const bullets = Array.isArray(exp.bullets) && exp.bullets.length > 0 
      ? '\nBullets: ' + exp.bullets.join('; ')
      : '';
    const internship = exp.is_internship ? ' (Internship)' : '';
    return `- ${exp.role} at ${exp.company}${internship} (${exp.start_date} to ${exp.end_date || 'Present'})${bullets}`;
  }).join('\n');

  return `<experience>
${entries}
</experience>`;
}

/**
 * Format education section
 */
function formatEducation(education: any[]): string {
  if (!Array.isArray(education) || education.length === 0) return '';
  
  const entries = education.map((edu: any) => {
    return `- ${edu.degree} in ${edu.field} from ${edu.institution} (${edu.start_date} to ${edu.end_date})`;
  }).join('\n');

  return `<education>
${entries}
</education>`;
}

/**
 * Format projects section
 */
function formatProjects(projects: any[]): string {
  if (!Array.isArray(projects) || projects.length === 0) return '';
  
  const entries = projects.map((proj: any) => {
    const tech = Array.isArray(proj.technologies) ? ` (${proj.technologies.join(', ')})` : '';
    return `- ${proj.name}: ${proj.description}${tech}`;
  }).join('\n');

  return `<projects>
${entries}
</projects>`;
}

/**
 * Format generic list section
 */
function formatList(title: string, items: any[]): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  
  const entries = items.map((item: any) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  
  return `<${title.toLowerCase()}>
${entries}
</${title.toLowerCase()}>`;
}
