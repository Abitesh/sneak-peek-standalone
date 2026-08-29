import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = path.resolve(process.cwd(), 'dist-electron/electron/services/InstallPingManager.js');

test('InstallPingManager works in non-Electron test context', async () => {
  const mod = await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}`);
  const id = mod.getOrCreateInstallId();

  assert.match(id, /^[0-9a-f-]{36}$/i, 'should generate a UUID when Electron app data is unavailable');
  await assert.doesNotReject(() => mod.sendAnonymousInstallPing());
});
