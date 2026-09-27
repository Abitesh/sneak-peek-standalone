# ASR model benchmark (Stage 7)

Measure-then-pick results for local Whisper/Moonshine/Parakeet/Nemotron catalog models.

## Environment

- Date: 2026-09-27T09:48:31.531Z
- Host: Apple M3 / arm64 / darwin
- RAM: 8 GB
- Models dir: `/Users/sriramvanga/Library/Application Support/natively/whisper-models`
- Fixture: `known-phrase-16k-mono.wav` (2463 ms @ 16 kHz mono) — "the quick brown fox jumps over the lazy dog"
- Warmups: 1, timed runs: 3 (median reported)
- `allowRemoteModels: false` — installed models only; no downloads

## Results

| Model | Status | Load ms | Warm final ms | Partial ms | Final ms | RTF | Word overlap | RSS MB | CPU % | Profile interval/minAudio | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Moonshine Tiny | needs run | — | — | — | — | — | — | — | — | 400/400 | not in whisper-models cache |
| Moonshine Base | measured | 1087 | — | 275 | 316 | 0.128 | 100% | 588 | 68 | 400/400 | "The quick brown fox jumps over the lazy dog." |
| Parakeet CTC 0.6B | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Nemotron 3.5 ASR Streaming | needs run | — | — | — | — | — | — | — | — | 280/560 | not in whisper-models cache |
| Distil Small EN | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Distil Medium EN | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Distil Large v3 | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Distil Large v2 | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Whisper Large v3 Turbo | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Tiny English | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Tiny Multilingual | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Base English | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Base Multilingual | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Small English | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Small Multilingual | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Medium English | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |
| Medium Multilingual | needs run | — | — | — | — | — | — | — | — | 1500/800 | not in whisper-models cache |

## Latency budget vs streaming profile

First-partial wall time ≈ `max(minAudioMs, intervalMs)` wait + inference. Retune interval/minAudio only when the profile wait dominates measured inference.

- **Moonshine Base**: profile gate ≈ 400 ms (interval 400, minAudio 400, poll waste 0 ms), measured partial/final ≈ 275 ms → profile does not dominate (leave interval/minAudio)

## Recommended defaults (from this run)

- **Shared `localWhisperModel`**: `onnx-community/moonshine-base-ONNX` (only/fastest accurate measured model on this machine).
- **Mic `localWhisperModelMic`**: `onnx-community/moonshine-base-ONNX` — streaming latency priority; moonshine/nemotron profiles already skip LocalAgreement-2.
- **System `localWhisperModelSystem`**: `onnx-community/moonshine-base-ONNX` — same pick until a higher-accuracy installed model is measured (Parakeet / Distil Medium / Turbo = needs run).
- **`localWhisperPerChannelEnabled`**: leave **false** while mic and system resolve to the same model; enable when a second measured model is installed and assigned.
- **Moonshine streaming profile**: retuned `750/400` → `400/400` after the 750 ms poll gate dominated measured inference on this host (see LocalWhisperSTT.resolveStreamingProfile).

## Needs run

- `onnx-community/moonshine-tiny-ONNX` (~26 MB) — not in whisper-models cache
- `onnx-community/parakeet-ctc-0.6b-ONNX` (~583 MB) — not in whisper-models cache
- `onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4` (~793 MB) — not in whisper-models cache
- `distil-whisper/distil-small.en` (~164 MB) — not in whisper-models cache
- `distil-whisper/distil-medium.en` (~383 MB) — not in whisper-models cache
- `distil-whisper/distil-large-v3` (~731 MB) — not in whisper-models cache
- `distil-whisper/distil-large-v2` (~731 MB) — not in whisper-models cache
- `onnx-community/whisper-large-v3-turbo-ONNX` (~1031 MB) — not in whisper-models cache
- `Xenova/whisper-tiny.en` (~39 MB) — not in whisper-models cache
- `Xenova/whisper-tiny` (~74 MB) — not in whisper-models cache
- `Xenova/whisper-base.en` (~142 MB) — not in whisper-models cache
- `Xenova/whisper-base` (~145 MB) — not in whisper-models cache
- `Xenova/whisper-small.en` (~244 MB) — not in whisper-models cache
- `Xenova/whisper-small` (~466 MB) — not in whisper-models cache
- `Xenova/whisper-medium.en` (~1500 MB) — not in whisper-models cache
- `Xenova/whisper-medium` (~1530 MB) — not in whisper-models cache

## Transcript UI vs RAG

Verified in `electron/main.ts` STT path: `feedLiveTranscript` is fire-and-forget (no await); `sendThrottledTranscript` / `emitTranscriptToSurfaces` run after the RAG feed without waiting on retrieval. Pinned by `electron/audio/__tests__/TranscriptUiIndependentOfRag.test.mjs`.

## How to re-run

```bash
npm run build:electron   # optional but enables dtype-aware catalog + Nemotron
node scripts/benchmark-asr-models.mjs
# or subset:
NATIVELY_ASR_BENCH_MODELS=onnx-community/moonshine-base-ONNX node scripts/benchmark-asr-models.mjs
```
