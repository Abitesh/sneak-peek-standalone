import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../../components/TopControlBar.tsx');
const source = readFileSync(sourcePath, 'utf8');

test('TopControlBar has a dedicated drag handle that is the only pointer-drag source', () => {
  assert.match(source, /data-top-control-drag-handle/,
    'BUG: drag must occur from a dedicated handle element, not from the whole toolbar or the action buttons.');
  assert.match(source, /onPointerDown=\{startDrag\}/,
    'BUG: the drag handle must own the pointerdown for drag initiation.');
  assert.match(source, /addEventListener\('pointermove', handlePointerMove\)|addEventListener\("pointermove", handlePointerMove\)/,
    'BUG: drag must continue even when the pointer moves outside the handle while the user is dragging the toolbar.');
  assert.match(source, /pointer-events-auto|touch-none/,
    'BUG: the drag handle needs explicit pointer interaction rules so it can receive real pointer events without fighting the overlay shell.');
});

test('TopControlBar is rendered as a fixed additive overlay sibling, not a separate BrowserWindow or separate root', () => {
  const nativelyInterfaceSource = readFileSync(path.resolve(__dirname, '../../components/NativelyInterface.tsx'), 'utf8');
  assert.match(nativelyInterfaceSource, /<TopControlBar\s*\n\s*isListening/,
    'BUG: the toolbar must remain mounted inside the existing NativelyInterface renderer tree as a sibling additive overlay.');
  assert.doesNotMatch(nativelyInterfaceSource, /new BrowserWindow\s*\(.*TopControlBar|TopControlBar.*new BrowserWindow/s,
    'BUG: the toolbar must not be created via a separate Electron BrowserWindow or second renderer root.');
});
