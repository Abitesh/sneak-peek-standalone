import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

process.env.NATIVELY_CANONICAL_RAG_READ = 'on';
process.env.NATIVELY_RAG_LOCAL_RERANK = 'on';

const modulePath = new URL('../../../dist-electron/electron/rag/RAGManager.js', import.meta.url).href;
const schemaPath = new URL('../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js', import.meta.url).href;
const storagePath = new URL('../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js', import.meta.url).href;
const { RAGManager } = await import(modulePath);
const { installCanonicalRagSchema } = await import(schemaPath);
const { CanonicalRagStorage } = await import(storagePath);

const searchSource = RAGManager.prototype.search.toString();

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  installCanonicalRagSchema(db);
  return db;
}

function seedReadyMeeting(storage, meetingId, text = 'canonical meeting result') {
  const doc = storage.createDocument({
    sourceType: 'meeting',
    sourceId: meetingId,
    name: `Meeting ${meetingId}`,
  });
  const revision = storage.createRevision({
    documentId: doc.id,
    contentHash: `hash-${meetingId}`,
    extractionVersion: 'test',
    chunkingVersion: 'test',
    normalizationVersion: 'test',
  });
  storage.replaceChunks(doc.id, revision.id, [{
    chunkIndex: 0,
    text,
    sourceLocator: 'meeting:0',
  }]);
  storage.setStatus(doc.id, revision.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(doc.id, revision.id);
}

function legacyResult(sourceType = 'meeting', text = 'legacy result') {
  return [{
    chunk: {
      id: `legacy-${sourceType}`,
      documentId: `${sourceType}-1`,
      text,
      chunkIndex: 0,
      metadata: {},
    },
    score: 0.8,
    source: {
      id: `${sourceType}-1`,
      sourceType,
      name: `${sourceType}.txt`,
      metadata: {},
    },
  }];
}

function makeSearchHarness(db) {
  const manager = Object.create(RAGManager.prototype);
  manager.db = db;
  manager.queryPlanner = {
    plan() {
      return { retrievalQuery: 'project update', sources: ['meeting'] };
    },
  };
  manager.getSourceManagers = () => ({ modesManager: null, personalKnowledge: null });
  manager.meetingAdapter = { retrieve: async () => legacyResult('meeting') };
  manager.modeAdapter = { retrieve: async () => legacyResult('mode') };
  manager.personalAdapter = { retrieve: async () => legacyResult('personal') };
  manager.knowledgeAdapter = { retrieve: async () => legacyResult('knowledge') };
  manager.rerankCanonicalResults = async (_query, results) => results;
  manager.gateCanonicalResults = results => results;
  return manager;
}

test('RAGManager production search consumes canonicalRagRead', () => {
  assert.match(searchSource, /isIntelligenceFlagEnabled\(['"]canonicalRagRead['"]\)/);
  assert.match(searchSource, /new CanonicalRagReadService/);
  assert.match(searchSource, /canonicalRead\.readSource/);
});

test('canonical read is source-local and Knowledge remains on its existing adapter', () => {
  assert.match(searchSource, /sourceType:\s*['"]meeting['"]/);
  assert.match(searchSource, /sourceType:\s*['"]mode['"]/);
  assert.match(searchSource, /sourceType:\s*['"]personal['"]/);
  assert.doesNotMatch(searchSource, /sourceType:\s*['"]knowledge['"]/);
  assert.match(searchSource, /this\.knowledgeAdapter\.retrieve/);
});

test('canonical read has explicit legacy fallback paths', () => {
  assert.match(searchSource, /fallback: \(\) => this\.meetingAdapter\.retrieve/);
  assert.match(searchSource, /fallback: \(\) => this\.modeAdapter\.retrieve/);
  assert.match(searchSource, /fallback: \(\) => this\.personalAdapter\.retrieve/);
});

test('observe-only comparison and shadow are disabled when canonical read is authoritative', () => {
  assert.match(searchSource, /if \(!canonicalReadEnabled\)/);
  assert.match(searchSource, /rerankCandidatePoolSize,\s*canonicalReadEnabled/);
  assert.match(searchSource, /if \(canonicalReadEnabled && canonicalReadFallbacks\.length > 0\)/);
  assert.match(searchSource, /this\.compareCanonicalRetrievalIfEnabled/);
  assert.match(searchSource, /observeCanonicalRagShadowIfEnabled/);
});

test('canonical read remains fail-closed when reranking is disabled', () => {
  assert.match(searchSource, /isIntelligenceFlagEnabled\(['"]canonicalRagRead['"]\)/);
  assert.match(searchSource, /isRagRerankEnabled\(\)/);
  assert.match(searchSource, /options\.allowRerank !== false/);
});

test('production boundary uses a READY canonical result without invoking the legacy reader', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  seedReadyMeeting(storage, 'meeting-1', 'canonical project update result');
  const manager = makeSearchHarness(db);
  let fallbackCalls = 0;
  manager.meetingAdapter.retrieve = async () => {
    fallbackCalls += 1;
    return legacyResult('meeting');
  };

  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    meetingId: 'meeting-1',
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'canonical project update result');
  assert.equal(fallbackCalls, 0);
  db.close();
});

test('production boundary falls back when canonical coverage is empty', async () => {
  const db = makeDb();
  const manager = makeSearchHarness(db);
  let fallbackCalls = 0;
  manager.meetingAdapter.retrieve = async () => {
    fallbackCalls += 1;
    return legacyResult('meeting', 'legacy after empty canonical');
  };

  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    meetingId: 'missing-meeting',
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'legacy after empty canonical');
  assert.equal(fallbackCalls, 1);
  db.close();
});

test('production boundary falls back when canonical storage fails', async () => {
  const failingDb = {
    prepare() {
      throw new Error('canonical sqlite failure');
    },
  };
  const manager = makeSearchHarness(failingDb);
  let fallbackCalls = 0;
  manager.meetingAdapter.retrieve = async () => {
    fallbackCalls += 1;
    return legacyResult('meeting', 'legacy after canonical error');
  };

  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    meetingId: 'meeting-1',
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'legacy after canonical error');
  assert.equal(fallbackCalls, 1);
});

test('explicit allowRerank false prevents canonical authority at the production boundary', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  seedReadyMeeting(storage, 'meeting-1', 'canonical must not be selected');
  const manager = makeSearchHarness(db);
  let legacyCalls = 0;
  manager.meetingAdapter.retrieve = async () => {
    legacyCalls += 1;
    return legacyResult('meeting', 'legacy because rerank was disabled');
  };

  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    meetingId: 'meeting-1',
    allowRerank: false,
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'legacy because rerank was disabled');
  assert.equal(legacyCalls, 1);
  db.close();
});

test('Knowledge remains on its existing adapter even when canonical reads are enabled', async () => {
  const manager = makeSearchHarness({});
  manager.queryPlanner = { plan() { return { retrievalQuery: 'knowledge query', sources: ['knowledge'] }; } };
  let knowledgeCalls = 0;
  manager.knowledgeAdapter.retrieve = async () => {
    knowledgeCalls += 1;
    return legacyResult('knowledge', 'knowledge result');
  };

  const response = await manager.search('knowledge query', {
    selectedSources: ['knowledge'],
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'knowledge result');
  assert.equal(knowledgeCalls, 1);
});

test('canonical rerank failure falls back to the legacy source instead of exposing BM25', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  seedReadyMeeting(storage, 'meeting-1', 'canonical BM25 must never reach final output');
  const manager = makeSearchHarness(db);
  manager.rerankCanonicalResults = async () => {
    throw new Error('reranker unavailable');
  };
  let fallbackCalls = 0;
  manager.meetingAdapter.retrieve = async () => {
    fallbackCalls += 1;
    return legacyResult('meeting', 'legacy after reranker failure');
  };

  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    meetingId: 'meeting-1',
  });

  assert.equal(response.status, 'ok');
  assert.equal(response.results[0].chunk.text, 'legacy after reranker failure');
  assert.equal(fallbackCalls, 1);
  db.close();
});
