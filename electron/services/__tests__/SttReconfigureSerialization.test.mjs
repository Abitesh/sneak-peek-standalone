// Regression test for the "app hangs / crashes the system right after an STT
// provider or model change that fires concurrent audio-pipeline rebuilds"
// bug (2026-06-05; originally triggered by saving a Natively API key).
//
// ROOT CAUSE: a single user action could fire up to TWO audio-pipeline
// rebuilds nearly simultaneously (e.g. main-process auto-promote + renderer
// follow-up setSttProvider). `reconfigureSttProvider` tears down and
// reconstructs the native captures (SystemAudioCapture / MicrophoneCapture →
// CoreAudio / ScreenCaptureKit / WASAPI). Two interleaved teardown+construct
// sequences against the same native device handles raced → native deadlock /
// process crash on BOTH macOS and Windows.
//
// The hosted Natively API settings surface (`NativelyApiSettings.tsx` +
// `set-natively-api-key`) has since been removed. Live triggers that still
// call `reconfigureSttProvider` are:
//   - `set-stt-provider` (SettingsOverlay STT dropdown)
//   - `local-whisper-set-model` / `local-whisper-set-channel-config`
//     (LocalWhisperModelPanel under Settings → Audio)
//
// FIXES UNDER TEST:
//   #1 reconfigureSttProvider is serialized via `_sttReconfigureChain` — the
//      actual work lives in `_doReconfigureSttProvider`, and concurrent callers
//      are queued so the critical section is never re-entered.
//   #2 the local-whisper model UI does not also fire setSttProvider, and
//      provider changes broadcast credentials-changed so SettingsOverlay
//      refreshes.
//   #3 live reconfigure callers await the serialized path (no fire-and-forget).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

const mainSrc = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const ipcSrc = fs.readFileSync(path.join(root, 'electron/ipcHandlers.ts'), 'utf8');
const panelSrc = fs.readFileSync(
  path.join(root, 'src/components/LocalWhisperModelPanel.tsx'),
  'utf8',
);
const overlaySrc = fs.readFileSync(
  path.join(root, 'src/components/SettingsOverlay.tsx'),
  'utf8',
);

function sliceSafeHandle(source, channel, nextChannel) {
  // Handlers are commonly formatted as safeHandle(\n  'channel', …) so match
  // the channel literal rather than a single-line safeHandle('channel' form.
  const re = new RegExp(`safeHandle\\(\\s*['"]${channel}['"]`);
  const m = re.exec(source);
  assert.ok(m, `${channel} handler must exist`);
  const start = m.index;
  let end = -1;
  if (nextChannel) {
    const nextRe = new RegExp(`safeHandle\\(\\s*['"]${nextChannel}['"]`);
    nextRe.lastIndex = start + 1;
    const next = nextRe.exec(source);
    end = next ? next.index : -1;
  }
  return source.slice(start, end > start ? end : start + 2500);
}

describe('Fix #1: reconfigureSttProvider is serialized (source contract)', () => {
  it('declares a serialization chain field', () => {
    assert.match(
      mainSrc,
      /_sttReconfigureChain\s*:\s*Promise<void>/,
      'BUG: `_sttReconfigureChain` serialization field is gone. Without it, concurrent ' +
        'reconfigureSttProvider calls re-enter the native teardown/rebuild in parallel — ' +
        'the exact race that crashed/hung the app after a key save.',
    );
  });

  it('the public reconfigureSttProvider delegates through the chain, not the body directly', () => {
    // Isolate ONLY the public method body — stop at the private worker so a
    // nearby setupSystemAudioPipeline inside _doReconfigureSttProvider cannot
    // false-fail a fixed-window scan of main.ts.
    const pubStart = mainSrc.indexOf('public async reconfigureSttProvider(');
    assert.ok(pubStart >= 0, 'public reconfigureSttProvider must exist');
    const doStart = mainSrc.indexOf('private async _doReconfigureSttProvider(', pubStart);
    const pubBody = mainSrc.slice(pubStart, doStart > pubStart ? doStart : pubStart + 1200);
    assert.match(
      pubBody,
      /_sttReconfigureChain/,
      'BUG: public reconfigureSttProvider no longer references _sttReconfigureChain — ' +
        'serialization was removed and concurrent calls can race again.',
    );
    assert.match(
      pubBody,
      /_doReconfigureSttProvider\s*\(/,
      'BUG: public reconfigureSttProvider must delegate the real work to ' +
        '_doReconfigureSttProvider (the serialized critical section).',
    );
    // The teardown/rebuild must NOT be inlined in the public method — that
    // would mean it runs unserialized.
    assert.ok(
      !/setupSystemAudioPipeline/.test(pubBody),
      'BUG: setupSystemAudioPipeline is called directly inside the PUBLIC ' +
        'reconfigureSttProvider — the native rebuild must live in the serialized ' +
        '_doReconfigureSttProvider instead.',
    );
  });

  it('the real teardown/rebuild lives in _doReconfigureSttProvider', () => {
    const doStart = mainSrc.indexOf('private async _doReconfigureSttProvider(');
    assert.ok(doStart >= 0, 'BUG: _doReconfigureSttProvider (the serialized worker) is missing.');
    // Bounded by the next section's marker, not a fixed char count — a fixed
    // +2000 previously clipped the function body before reaching the actual
    // call once the RC-01 fix comment (audio-capture drain ordering) made the
    // function longer, producing a false positive on an intact rebuild.
    const doEnd = mainSrc.indexOf('PR #173: Audio Recovery Handler', doStart);
    const doBody = mainSrc.slice(doStart, doEnd > doStart ? doEnd : doStart + 3000);
    assert.match(
      doBody,
      /setupSystemAudioPipeline/,
      'BUG: _doReconfigureSttProvider no longer rebuilds the pipeline — the worker is hollow.',
    );
  });
});

describe('Fix #1: serialization semantics (behavioral)', () => {
  // Faithfully reproduce the chain pattern from main.ts and prove it provides
  // mutual exclusion: the critical section is never entered concurrently, even
  // when callers arrive simultaneously and the work is async.
  function makeSerializedRunner(work) {
    let chain = Promise.resolve();
    return function run() {
      const r = chain.then(
        () => work(),
        () => work(),
      );
      chain = r.then(
        () => undefined,
        () => undefined,
      );
      return r;
    };
  }

  it('never re-enters the critical section under concurrent calls', async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield across multiple microtask/macrotask boundaries to expose any
      // interleaving — this is where the native race used to happen.
      await new Promise((res) => setTimeout(res, 5));
      await Promise.resolve();
      active--;
      completed++;
    };
    const run = makeSerializedRunner(work);

    // Fire the same double-call the key-save flow used to produce.
    await Promise.all([run(), run(), run(), run()]);

    assert.equal(maxActive, 1, 'BUG: critical section was entered concurrently — serialization failed.');
    assert.equal(completed, 4, 'all queued reconfigures must complete.');
  });

  it('a throwing reconfigure does not wedge subsequent reconfigures', async () => {
    let completedAfterThrow = 0;
    let calls = 0;
    const work = async () => {
      calls++;
      if (calls === 1) throw new Error('simulated native init failure');
      await Promise.resolve();
      completedAfterThrow++;
    };
    const run = makeSerializedRunner(work);

    // First call rejects to ITS caller...
    await assert.rejects(run(), /simulated native init failure/);
    // ...but the chain must keep working for the next caller.
    await run();
    await run();
    assert.equal(completedAfterThrow, 2, 'BUG: a failed reconfigure poisoned the chain for later callers.');
  });
});

describe('Fix #2: local-whisper UI does not double-fire; provider IPC refreshes SettingsOverlay', () => {
  it('SettingsOverlay mounts LocalWhisperModelPanel for the local-whisper provider', () => {
    assert.match(
      overlaySrc,
      /LocalWhisperModelPanel/,
      'BUG: SettingsOverlay no longer mounts LocalWhisperModelPanel — local model reconfigure has no settings surface.',
    );
    assert.match(
      overlaySrc,
      /sttProvider\s*===\s*['"]local-whisper['"]/,
      'BUG: LocalWhisperModelPanel must be gated on sttProvider === local-whisper.',
    );
  });

  it('LocalWhisperModelPanel model mutators do not also call setSttProvider/setDefaultModel', () => {
    // Model / channel changes already reconfigure (or invalidate) STT in main.
    // A redundant setSttProvider from the same UI action would race a SECOND
    // audio-pipeline rebuild — the crash/hang this whole fix removes.
    const mutators = ['setGlobalModel', 'setMicModel', 'setSystemModel', 'toggleDualChannel'];
    for (const name of mutators) {
      const start = panelSrc.indexOf(`const ${name}`);
      assert.ok(start >= 0, `${name} must exist in LocalWhisperModelPanel.tsx`);
      // Bound each mutator by the next const/function or the loading early-return.
      const nextConst = panelSrc.indexOf('\n    const ', start + 1);
      const nextIf = panelSrc.indexOf('\n    if (loading)', start + 1);
      const endCandidates = [nextConst, nextIf].filter((i) => i > start);
      const end = endCandidates.length ? Math.min(...endCandidates) : start + 800;
      const body = panelSrc.slice(start, end);
      assert.ok(
        !/electronAPI\s*\?\.\s*setSttProvider/.test(body) &&
          !/window\.electronAPI\s*\?\.\s*setSttProvider/.test(body),
        `BUG: ${name} fires setSttProvider after a local-whisper model/config write. ` +
          'Main already reconfigures/invalidates STT for that write; the redundant call ' +
          'races a SECOND audio-pipeline rebuild.',
      );
      assert.ok(
        !/electronAPI\s*\?\.\s*setDefaultModel/.test(body) &&
          !/window\.electronAPI\s*\?\.\s*setDefaultModel/.test(body),
        `BUG: ${name} fires setDefaultModel after a local-whisper model/config write.`,
      );
    }
    assert.match(
      panelSrc,
      /localWhisperSetModel/,
      'BUG: LocalWhisperModelPanel must call localWhisperSetModel for global model changes.',
    );
    assert.match(
      panelSrc,
      /localWhisperSetChannelConfig/,
      'BUG: LocalWhisperModelPanel must call localWhisperSetChannelConfig for channel overrides.',
    );
  });

  it("set-stt-provider broadcasts 'credentials-changed' so the SettingsOverlay STT dropdown refreshes", () => {
    // SettingsOverlay re-reads credentials on onCredentialsChanged. Provider
    // changes must emit that event so the dropdown stays in sync across windows.
    const handlerBody = sliceSafeHandle(ipcSrc, 'set-stt-provider', 'get-stt-provider');
    const usesHelper = /broadcastCredentialsChanged\s*\(\s*\)/.test(handlerBody);
    if (usesHelper) {
      const helperStart = ipcSrc.indexOf('const broadcastCredentialsChanged');
      assert.ok(helperStart >= 0, 'BUG: broadcastCredentialsChanged helper is called but no longer defined.');
      const helperBody = ipcSrc.slice(helperStart, helperStart + 400);
      assert.match(
        helperBody,
        /send\(\s*['"]credentials-changed['"]\s*\)/,
        "BUG: broadcastCredentialsChanged no longer sends 'credentials-changed'. The Settings STT " +
          'dropdown will show a stale provider after set-stt-provider.',
      );
    } else {
      assert.match(
        handlerBody,
        /send\(\s*['"]credentials-changed['"]\s*\)/,
        "BUG: set-stt-provider no longer broadcasts 'credentials-changed'. The Settings STT " +
          'dropdown will show a stale provider after a provider change.',
      );
    }
    assert.match(
      overlaySrc,
      /onCredentialsChanged/,
      'BUG: SettingsOverlay must subscribe to credentials-changed to refresh the STT dropdown.',
    );
  });
});

describe('Fix #3: live reconfigure callers await the serialized path', () => {
  it('set-stt-provider awaits reconfigureSttProvider (no fire-and-forget)', () => {
    const handlerBody = sliceSafeHandle(ipcSrc, 'set-stt-provider', 'get-stt-provider');
    assert.match(
      handlerBody,
      /await\s+appState\.reconfigureSttProvider\s*\(/,
      'BUG: set-stt-provider must await reconfigureSttProvider so concurrent provider ' +
        'changes queue on _sttReconfigureChain instead of racing native teardown.',
    );
    assert.ok(
      !/void\s+appState\.reconfigureSttProvider\s*\(/.test(handlerBody),
      'BUG: set-stt-provider detached reconfigureSttProvider into a fire-and-forget call.',
    );
  });

  it('local-whisper-set-model awaits reconfigureSttProvider when a meeting is active', () => {
    const handlerBody = sliceSafeHandle(
      ipcSrc,
      'local-whisper-set-model',
      'local-whisper-reset-to-default',
    );
    assert.match(
      handlerBody,
      /await\s+appState\.reconfigureSttProvider\s*\(/,
      'BUG: local-whisper-set-model must await reconfigureSttProvider during an active ' +
        'meeting so model switches serialize with other STT rebuilds.',
    );
    assert.ok(
      !/void\s+appState\.reconfigureSttProvider\s*\(/.test(handlerBody),
      'BUG: local-whisper-set-model detached reconfigureSttProvider into a fire-and-forget call.',
    );
  });
});
