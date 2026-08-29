/**
 * DocumentChunker - Premium Implementation
 * 
 * Chunks long documents (resume, JD, company research) into smaller semantic units
 * for efficient embedding and retrieval.
 */

export interface Chunk {
  id: string;
  content: string;
  startOffset: number;
  endOffset: number;
  order: number;
  category?: string;
}

/**
 * Calculate duration in months between two date strings
 * Handles various date formats: YYYY-MM, YYYY, "Present", etc.
 */
export function calculateDurationMonths(startDate: string | Date, endDate: string | Date): number {
  if (!startDate) return 0;

  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? 
    (endDate.toLowerCase() === 'present' ? new Date() : new Date(endDate)) : 
    endDate;

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return 0;
  }

  const months = (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth());

  return Math.max(0, months);
}

/**
 * Split text into chunks (simplified semantic chunking)
 * In production, this would use more sophisticated sentence/paragraph boundaries
 */
export function chunkText(text: string, targetChunkSize: number = 500, overlapSize: number = 100): Chunk[] {
  if (!text || text.length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  let currentChunk = '';
  let startOffset = 0;
  let order = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    const potential = currentChunk + sentence;

    if (potential.length > targetChunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        id: `chunk_${order}`,
        content: currentChunk.trim(),
        startOffset,
        endOffset: startOffset + currentChunk.length,
        order,
      });

      // Start new chunk with overlap
      startOffset = startOffset + currentChunk.length - overlapSize;
      currentChunk = currentChunk.slice(-overlapSize) + sentence;
      order++;
    } else {
      currentChunk += sentence;
    }
  }

  // Save final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: `chunk_${order}`,
      content: currentChunk.trim(),
      startOffset,
      endOffset: startOffset + currentChunk.length,
      order,
    });
  }

  return chunks;
}

/**
 * Extract structured fields from resume/JD text
 */
export function extractStructuredFields(text: string, docType: 'resume' | 'jd' = 'resume'): Record<string, string[]> {
  const fields: Record<string, string[]> = {};

  if (!text) return fields;

  const lowerText = text.toLowerCase();

  // Experience/Responsibilities section
  const expMatch = text.match(/(?:experience|employment|work history)([\s\S]*?)(?:education|skills|projects|$)/i);
  if (expMatch) {
    fields['experience'] = [expMatch[1].trim()];
  }

  // Education/Requirements section
  const eduMatch = text.match(/(?:education|degree|qualifications|requirements)([\s\S]*?)(?:skills|experience|projects|$)/i);
  if (eduMatch) {
    fields['education'] = [eduMatch[1].trim()];
  }

  // Skills section
  const skillMatch = text.match(/(?:skills|technical skills|competencies)([\s\S]*?)(?:experience|education|projects|$)/i);
  if (skillMatch) {
    const skillText = skillMatch[1];
    fields['skills'] = skillText.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0);
  }

  // Projects section
  const projMatch = text.match(/(?:projects|portfolio|notable work)([\s\S]*?)(?:skills|experience|$)/i);
  if (projMatch) {
    fields['projects'] = [projMatch[1].trim()];
  }

  return fields;
}

export class DocumentChunker {
  /**
   * Chunk a document and extract structured fields
   */
  static processDocument(
    text: string,
    docType: 'resume' | 'jd' = 'resume',
    chunkSize: number = 500
  ): { chunks: Chunk[]; fields: Record<string, string[]> } {
    return {
      chunks: chunkText(text, chunkSize),
      fields: extractStructuredFields(text, docType),
    };
  }

  /**
   * Calculate experience duration (used for resume parsing)
   */
  static calculateDurationMonths = calculateDurationMonths;
}

export default DocumentChunker;
