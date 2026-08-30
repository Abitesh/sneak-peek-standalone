import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../../components/TopControlBar.tsx');
const source = readFileSync(sourcePath, 'utf8');
const nativelyInterfaceSource = readFileSync(
  path.resolve(__dirname, '../../components/NativelyInterface.tsx'),
  'utf8',
);

test('TopControlBar is an in-flow toolbar inside the chat shell (not fixed outside it)', () => {
  assert.match(source, /data-top-control-bar="true"/,
    'BUG: toolbar must keep a stable selector for layout/contract checks.');
  assert.doesNotMatch(source, /\bfixed\b/,
    'BUG: fixed positioning puts the bar in transparent click-through margins outside the shell.');
  assert.match(source, /overflow-x-auto/,
    'BUG: the bar must scroll horizontally inside the shell when controls exceed shell width.');
  assert.match(source, /pointer-events-auto/,
    'BUG: toolbar buttons must receive pointer events inside the interactive shell.');
  assert.doesNotMatch(source, /data-top-control-drag-handle|startDrag|natively_top_control_bar_position/,
    'BUG: free-drag positioning is what left the bar outside the clickable chat window.');
});

test('TopControlBar mounts inside the shell card, not as an outside sibling overlay', () => {
  assert.match(nativelyInterfaceSource, /data-shell-card[\s\S]*?<TopControlBar/,
    'BUG: the toolbar must render as a child of the chat shell card so it stays inside the window hit region.');
  assert.doesNotMatch(nativelyInterfaceSource, /<>\s*<TopControlBar/,
    'BUG: rendering TopControlBar as a fragment sibling outside the shell puts it outside the chat window.');
  assert.doesNotMatch(nativelyInterfaceSource, /new BrowserWindow\s*\(.*TopControlBar|TopControlBar.*new BrowserWindow/s,
    'BUG: the toolbar must not be created via a separate Electron BrowserWindow or second renderer root.');
});
