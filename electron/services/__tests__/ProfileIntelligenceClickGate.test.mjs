// electron/services/__tests__/ProfileIntelligenceClickGate.test.mjs
//
// Verifies the Profile Intelligence renderer keeps resume + JD upload actions
// local and reachable through the shared picker helpers.
//
// We follow the same source-level pattern as ProfileIntelligenceGate.test.mjs:
// no JSX runtime, no jsdom. The renderer is plain text that must contain the
// the shared picker and profile-upload calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '../../../src/components/ProfileIntelligenceSettings.tsx');

describe('Profile Intelligence renderer: local document upload', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');

  test('component keeps local profile uploads and premium analysis boundaries', () => {
    assert.match(source, /const hasProfileAccess = true/);
    assert.ok(source.includes('profileUploadResume'), 'resume upload API missing');
    assert.ok(source.includes('profileUploadJD'), 'JD upload API missing');
    assert.ok(source.includes('RoleInsightPanel'), 'premium analysis integration missing');
  });

  // THE GATE MOVED TO A CHOKE POINT. This used to walk back from each upload
  // IPC to an enclosing `onClick={async () => {` and assert the gate inline at
  // that call site. The upload flow has since been refactored: the picker is
  // reached through the shared `browseResume` / `browseJD` helpers, and the
  // buttons are presentational (FileUploadEmpty takes hasAccess/onNeedUpgrade/
  // onBrowse). No `onClick={async () => {` wraps the IPC any more, so the old
  // locator matched nothing.
  //
  // Rewritten to assert the gate where it now belongs — and this is STRICTER
  // than what it replaced. The per-button form only proved that the buttons it
  // knew about were gated; it could not see a new call site. In fact one had
  // already appeared: the "Re-upload" button in the heuristic-extraction notice
  // wires onClick={browseResume} directly, and it renders whenever
  // `hasProfile && extractionMode === 'heuristic'` — which a user whose Pro or
  // trial has LAPSED still satisfies, because the stored profile outlives the
  // entitlement. That was a live bypass to the OS file picker. Gating the shared
  // helper closes it for every present and future caller.
  const BROWSE_HELPERS = [
    { fn: 'browseResume', label: 'resume' },
    { fn: 'browseJD',     label: 'job description' },
  ];

  for (const { fn, label } of BROWSE_HELPERS) {
    test(`${label} picker helper (${fn}) reaches the local upload flow`, () => {
      const declIdx = source.indexOf(`const ${fn} = async () => {`);
      assert.ok(declIdx >= 0, `${fn} declaration not found`);
      const pickerIdx = source.indexOf('profileSelectFile', declIdx);
      assert.ok(pickerIdx >= 0, `${fn} must reach profileSelectFile`);
      assert.ok(source.includes(fn === 'browseResume' ? 'profileUploadResume' : 'profileUploadJD'));
    });
  }

  test('every call site that opens the picker goes through the gated helpers', () => {
    // Belt-and-braces: no component may call profileSelectFile directly outside
    // the shared upload helpers.
    const direct = [...source.matchAll(/profileSelectFile/g)].length;
    const inHelpers = [...source.matchAll(/const browse(?:Resume|JD) = async \(\) => \{[\s\S]*?profileSelectFile/g)].length;
    assert.equal(direct, inHelpers,
      'profileSelectFile must only be reached from browseResume/browseJD');
  });

  test('premium access remains represented for genuinely premium sections', () => {
    assert.ok(source.includes('hasAccess={hasProfileAccess}'), 'premium section access boundary missing');
  });
});
