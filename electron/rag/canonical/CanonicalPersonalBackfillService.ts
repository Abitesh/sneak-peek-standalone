/**
 * Change 25 — Step 3.2
 * Historical Personal legacy-to-canonical backfill coordinator.
 *
 * This service enumerates existing Personal files and delegates each file to
 * the established CanonicalPersonalRagService. It never writes legacy
 * Personal storage and does not own canonical indexing mechanics.
 */
import type { PersonalFileRecord, PersonalKnowledgeManager } from '../../personalKnowledge/PersonalKnowledgeManager';
import type { CanonicalPersonalProjectionResult, CanonicalPersonalRagService } from './CanonicalPersonalRagService';

export interface PersonalBackfillResult extends CanonicalPersonalProjectionResult {}

export interface PersonalBackfillSummary {
  attempted: number;
  completed: number;
  failed: number;
  results: PersonalBackfillResult[];
  errors: Array<{ fileId: string; error: string }>;
}

export class CanonicalPersonalBackfillService {
  constructor(
    private readonly personalKnowledge: Pick<PersonalKnowledgeManager, 'listFiles'>,
    private readonly canonicalPersonal: CanonicalPersonalRagService,
  ) {}

  listFileIds(): string[] {
    return this.personalKnowledge.listFiles().map((file: PersonalFileRecord) => file.id);
  }

  async backfillAll(): Promise<PersonalBackfillSummary> {
    const results: PersonalBackfillResult[] = [];
    const errors: Array<{ fileId: string; error: string }> = [];

    for (const fileId of this.listFileIds()) {
      try {
        results.push(await this.backfillFile(fileId));
      } catch (error) {
        errors.push({ fileId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      attempted: results.length + errors.length,
      completed: results.filter((result) => result.complete).length,
      failed: errors.length + results.filter((result) => !result.complete).length,
      results,
      errors,
    };
  }

  async backfillFile(fileId: string): Promise<PersonalBackfillResult> {
    return this.canonicalPersonal.projectPersonalFile(fileId);
  }
}
