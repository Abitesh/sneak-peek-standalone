import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Cmd/Ctrl+L and Cmd/Ctrl+S are registered as dedicated listen start/stop keybinds', () => {
  const keybinds = readFileSync(path.join(root, 'electron/services/KeybindManager.ts'), 'utf8');
  assert.match(keybinds, /id: 'chat:startListen'[\s\S]*?accelerator: 'CommandOrControl\+L'/);
  assert.match(keybinds, /id: 'chat:stopListen'[\s\S]*?accelerator: 'CommandOrControl\+S'/);
});

test('main process maps startListen/stopListen onto the overlay global-shortcut channel', () => {
  const main = readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  assert.match(main, /'chat:startListen': 'startListen'/);
  assert.match(main, /'chat:stopListen': 'stopListen'/);
});

test('renderer starts on startListen, stops on stopListen, and Enter while listening submits', () => {
  const ui = readFileSync(path.join(root, 'src/components/NativelyInterface.tsx'), 'utf8');
  assert.match(ui, /action === 'startListen'\) handlers\.handleStartListening\(\)/);
  assert.match(ui, /action === 'stopListen'\) handlers\.handleStopListening\(\)/);
  assert.match(ui, /isRecordingRef\.current &&\s*\n\s*e\.key === 'Enter'/);
  assert.match(ui, /handleStartListening/);
  assert.match(ui, /handleStopListening/);
});
