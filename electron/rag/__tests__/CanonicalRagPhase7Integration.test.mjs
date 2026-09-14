import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { RAGManager } from '../../../dist-electron/electron/rag/RAGManager.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalRagComparisonService } from '../../../dist-electron/electron/rag/canonical/CanonicalRagComparisonService.js';
import Database from 'better-sqlite3';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';

const originalFlag = process.env.NATIVELY_CANONICAL_RAG_COMPARISON;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.NATIVELY_CANONICAL_RAG_COMPARISON;
  else process.env.NATIVELY_CANONICAL_RAG_COMPARISON = originalFlag;
});

function legacyResult(sourceType, sourceId, chunkId, chunkIndex = 0) {
  return {
    chunk: {
      id: chunkId,
      chunkIndex,
      contentHash: `hash-${chunkId}`,
      text: 'diagnostic fixture text',
      metadata: { legacyChunkId: chunkId },
    },
    score: 0.8,
    source: { id: sourceId, sourceType },
  };
}

describe('Change 25 Phase 7 production comparison boundary', () => {
  test('disabled by default and does not perform canonical reads', async () => {
    delete process.env.NATIVELY_CANONICAL_RAG_COMPARISON;

    const manager = Object.create(RAGManager.prototype);
    manager.db = {};
    const results = [legacyResult('personal-files', 'file-1', 'legacy-1')];

    let lexicalReads = 0;
    const previousSearch = CanonicalRagStorage.prototype.searchLexical;
    CanonicalRagStorage.prototype.searchLexical = function searchLexicalDisabled() {
      lexicalReads += 1;
      return [];
    };

    try {
      await manager.compareCanonicalRetrievalIfEnabled(
        'project update',
        results,
        new Set(['personal-files']),
        {},
        20,
      );
    } finally {
      CanonicalRagStorage.prototype.searchLexical = previousSearch;
    }

    assert.equal(lexicalReads, 0);
  });

  test('enabled comparison reads canonical lexical results, compares them, and leaves legacy results untouched', async () => {
    process.env.NATIVELY_CANONICAL_RAG_COMPARISON = 'true';

    const manager = Object.create(RAGManager.prototype);
    const rawDb = new Database(':memory:');
    installCanonicalRagSchema(rawDb);
    const preparedSql = [];
    const db = new Proxy(rawDb, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql, ...args) => {
            const text = String(sql ?? '');
            if (text.includes('rag_chunks_fts')) preparedSql.push(text);
            return target.prepare(sql, ...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    manager.db = db;
    const results = [
      legacyResult('meeting', 'meeting-1', 'legacy-meeting-1'),
      legacyResult('mode-reference', 'mode-file-1', 'legacy-mode-1'),
      legacyResult('personal-files', 'file-1', 'legacy-personal-1'),
    ];
    const before = JSON.parse(JSON.stringify(results));

    try {
      await manager.compareCanonicalRetrievalIfEnabled(
        'project update',
        results,
        new Set(['meeting', 'mode-reference', 'personal-files']),
        { meetingId: 'meeting-1', modeId: 'mode-1' },
        20,
      );
    } finally {
      rawDb.close();
    }

    assert.equal(preparedSql.length, 3);
    assert.deepEqual(results, before);
  });

  test('canonical read failure is isolated from legacy retrieval', async () => {
    process.env.NATIVELY_CANONICAL_RAG_COMPARISON = '1';

    const manager = Object.create(RAGManager.prototype);
    manager.db = {};
    const results = [legacyResult('personal-files', 'file-1', 'legacy-1')];

    const previousSearch = CanonicalRagStorage.prototype.searchLexical;
    CanonicalRagStorage.prototype.searchLexical = function searchLexicalFailure() {
      throw new Error('canonical fixture failure');
    };

    try {
      await assert.doesNotReject(() => manager.compareCanonicalRetrievalIfEnabled(
        'project update',
        results,
        new Set(['personal-files']),
        {},
        20,
      ));
    } finally {
      CanonicalRagStorage.prototype.searchLexical = previousSearch;
    }

    assert.equal(results[0].chunk.id, 'legacy-1');
  });
});
