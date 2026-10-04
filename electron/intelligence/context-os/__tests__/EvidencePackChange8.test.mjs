import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const src = path.join(root, 'electron/intelligence/context-os/evidencePack.ts');
const outDir = path.join(root, '.change8-testdist');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', src, '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck', '--outDir', outDir], { cwd: root, stdio: 'ignore' });
const mod = await import(pathToFileURL(path.join(outDir, 'evidencePack.js')).href);
const { buildEvidencePackFromNativelyEvidence } = mod;

function plan(...requiredSources) {
  const all = ['none','recent_conversation','longer_conversation','meeting_transcript','personal_knowledge','project_knowledge','my_files','mode_documents','rag','screen','profile','structured_knowledge'];
  return {
    sources: all.map(source => ({ source, requirement: requiredSources.includes(source) ? 'required' : 'forbidden', reason: requiredSources.includes(source) ? 'test' : 'not needed' })),
    requiredSources, optionalSources: [], forbiddenSources: all.filter(s => !requiredSources.includes(s)), notRequiredSources: [],
    needsContext: requiredSources.length > 0, generalKnowledgeAllowed: requiredSources.length === 0,
    retrievalRequired: requiredSources.some(s => !['none','recent_conversation','longer_conversation','screen'].includes(s)),
    retrievalSources: requiredSources, rationale: ['test']
  };
}

const item = (source, id, text, metadata={}) => ({ id, source, content:text, score:0.9, metadata });

test('pack preserves project source identity, scope, relevance, provenance and authority', () => {
  const pack = buildEvidencePackFromNativelyEvidence({
    turnId:'t1', query:'Why Redis?', contextPlan:plan('project_knowledge'),
    evidence:{items:[item('project_knowledge','p1','Redis was used for caching',{sourceId:'linkship',scopeId:'project:linkship',relevance:.91,confidence:.88,provenance:{file:'README.md'},authority:'evidence'})],sufficient:true}
  });
  assert.equal(pack.items.length,1);
  assert.equal(pack.items[0].canonicalSource,'project_knowledge');
  assert.equal(pack.items[0].sourceId,'linkship');
  assert.deepEqual(pack.items[0].scope,{kind:'project_knowledge',id:'project:linkship'});
  assert.equal(pack.items[0].relevance,.91);
  assert.equal(pack.items[0].confidence,.88);
  assert.equal(pack.items[0].authority,'evidence');
  assert.deepEqual(pack.items[0].provenance,{file:'README.md'});
});

test('pack preserves personal, meeting and document source identity separately', () => {
  const p = buildEvidencePackFromNativelyEvidence({turnId:'t2',query:'q',contextPlan:plan('personal_knowledge','meeting_transcript','mode_documents'),evidence:{items:[
    item('personal_knowledge','me','My experience',{scopeId:'profile:1'}),
    item('meeting_transcript','m1','We discussed Redis',{scopeId:'meeting:7'}),
    item('mode_documents','d1','Document section',{scopeId:'file:9'})
  ],sufficient:true}});
  assert.deepEqual(p.items.map(x=>x.canonicalSource),['personal_knowledge','meeting_transcript','mode_documents']);
  assert.deepEqual(p.items.map(x=>x.scope.id),['profile:1','meeting:7','file:9']);
});

test('personal evidence cannot be relabeled as project evidence', () => {
  const p = buildEvidencePackFromNativelyEvidence({turnId:'t3',query:'project q',contextPlan:plan('project_knowledge'),evidence:{items:[
    item('personal_knowledge','private','Private fact',{scopeId:'profile:1'})
  ],sufficient:true}});
  assert.equal(p.items.length,0);
  assert.equal(p.rejected.length,1);
  assert.equal(p.rejected[0].reason,'forbidden_source');
});
