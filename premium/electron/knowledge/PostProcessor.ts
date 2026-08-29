export function computeTotalExperience(resume: any): number {
  const experience = Array.isArray(resume?.experience) ? resume.experience : [];
  if (!experience.length) return 0;

  const now = new Date();
  let totalMonths = 0;

  for (const entry of experience) {
    const start = entry?.start_date ? new Date(String(entry.start_date)) : null;
    const endRaw = entry?.end_date ?? null;
    const end = endRaw ? new Date(String(endRaw)) : now;

    if (start && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      totalMonths += Math.max(months, 0);
    }
  }

  const years = totalMonths / 12;
  return Number.isFinite(years) ? Number(Math.round(years * 10) / 10) : 0;
}

export default { computeTotalExperience };
