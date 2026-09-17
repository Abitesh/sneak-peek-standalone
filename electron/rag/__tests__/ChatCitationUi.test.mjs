import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ui = fs.readFileSync(
  path.join(process.cwd(), 'src/components/NativelyInterface.tsx'),
  'utf8',
);

test('markdown p (and li) wrap children in CitationAwareText', () => {
  assert.match(ui, /markdownWithCitations\('p'/);
  assert.match(ui, /markdownWithCitations\('li'/);
  assert.match(
    ui,
    /<CitationAwareText>\{children\}<\/CitationAwareText>/,
  );
});

test('stream done uses citationMarkers or citations; unknown markers stay text', () => {
  assert.match(ui, /data\?\.citationMarkers \?\? data\?\.citations/);
  assert.match(ui, /Never turn an unknown\/model-invented marker into a citation UI/);
  assert.match(ui, /Object\.keys\(markers\)\.length === 0/);
  assert.doesNotMatch(ui, /fakeCitation|placeholder citation|invented citation badge/i);
});

test('CitationAwareText walks mixed markdown children instead of dropping nodes', () => {
  const start = ui.indexOf('const CitationAwareText');
  const end = ui.indexOf('const CitationMarkerProvider');
  assert.ok(start >= 0 && end > start);
  const body = ui.slice(start, end);
  assert.match(body, /Children\.toArray\(children\)/);
  assert.match(body, /typeof child !== 'string'/);
});
