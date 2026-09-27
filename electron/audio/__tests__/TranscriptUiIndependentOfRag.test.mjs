/**
 * Stage 7 pin: transcript UI must not wait on RAG.
 *
 * In createSTTProvider's segment handler, feedLiveTranscript is fire-and-forget
 * (no await). sendThrottledTranscript runs after it without depending on RAG
 * completion. Regressions that `await` the RAG feed before emitting transcript
 * IPC would block the rolling transcript bar on retrieval.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../main.ts'), 'utf8');

describe('transcript UI independent of live RAG feed', () => {
  test('feedLiveTranscript is not awaited before display send', () => {
    // Locate the live STT segment path that both feeds RAG and sends UI IPC.
    const feedIdx = mainSrc.indexOf('this.ragManager.feedLiveTranscript([');
    assert.ok(feedIdx > 0, 'expected feedLiveTranscript call in main.ts');

    // Look back a short window for an await on this call.
    const windowStart = Math.max(0, feedIdx - 80);
    const prelude = mainSrc.slice(windowStart, feedIdx);
    assert.doesNotMatch(
      prelude,
      /await\s*$/,
      'BUG: feedLiveTranscript must not be awaited — transcript UI must not wait on RAG',
    );
    assert.doesNotMatch(
      prelude,
      /await\s+this\.ragManager\.feed/,
      'BUG: feedLiveTranscript must not be awaited',
    );
  });

  test('display send follows RAG feed without gating on retrieval', () => {
    const feedIdx = mainSrc.indexOf('this.ragManager.feedLiveTranscript([');
    const sendIdx = mainSrc.indexOf('this.sendThrottledTranscript(payload)', feedIdx);
    assert.ok(sendIdx > feedIdx, 'sendThrottledTranscript must appear after feedLiveTranscript');

    const between = mainSrc.slice(feedIdx, sendIdx);
    // No await anywhere between feed and display send.
    assert.doesNotMatch(
      between,
      /\bawait\b/,
      'BUG: code between RAG feed and transcript IPC must not await (would block UI on RAG)',
    );
    assert.match(
      between,
      /\/\/ Display-only send/,
      'expected display-only comment documenting independence from answer/RAG path',
    );
  });
});
