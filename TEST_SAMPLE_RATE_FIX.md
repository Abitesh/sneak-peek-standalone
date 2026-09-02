# Test: Sample Rate Bug Fix for LocalWhisperSTT

## Problem Fixed
LocalWhisperSTT was hardcoding `inputSampleRate = 48000` but receiving 16kHz audio from SystemAudioCapture/MicrophoneCapture. This caused audio to be resampled 3x shorter than reality, preventing VAD from detecting speech and inference from running.

## Solution
- Added `setSampleRate(rate: number)` method to LocalWhisperSTT
- Constructor now accepts optional `inputSampleRate` parameter (defaults to 16000)
- Existing wireSystemCapture/wireMicCapture methods call setSampleRate on first chunk
- resampleToF32() now uses correct sample rate for audio conversion

## Test Procedure

### Prerequisites
1. Connect headphones/earphones (to avoid feedback)
2. Ensure system audio output is available
3. Have a test audio file or app ready to play clear human speech

### Step 1: Start App with LocalWhisper STT
```bash
npm run dev
# App will start with hot-reload enabled
```

### Step 2: Configure Settings
1. Open Settings (⚙️ icon)
2. **STT Provider**: Select "Local Whisper (ONNX)"
3. **Model**: Choose a model (e.g., "Xenova/whisper-tiny.en")
4. **Split Channels** (Optional): Toggle to test both mic and system audio separately
5. Close Settings

### Step 3: Start Meeting
1. Click "Start Meeting" or "Continue Interview"
2. You should see in terminal:
   ```
   [LocalWhisperSTT/system] streaming profile: interval=1500ms minAudio=800ms skipAgreement=false inputRate=16000Hz
   [LocalWhisperSTT/mic] streaming profile: interval=1500ms minAudio=800ms skipAgreement=false inputRate=16000Hz
   ```

### Step 4: Enable Audio Capture
1. Click "Listen" button (to start audio capture)
2. Grant Screen Recording permission if prompted
3. Watch terminal for:
   ```
   SystemAudio->STT: chunk #1, 1920B, googleSTT=active
   SystemAudioCapture rate locked from first chunk: 16000Hz
   [LocalWhisperSTT/system] Updated input sample rate: 16000Hz → 16000Hz
   ```

### Step 5: Play System Audio
1. In a separate app (Spotify, YouTube, zoom recording, etc.), play clear human speech
2. Keep microphone silent
3. Watch terminal for audio chunks flowing through:
   ```
   [SystemAudioCapture] Emitted STT rate: 16000
   [LocalWhisperSTT/system] write() chunks=1 total=... last_chunk=1920B rate=16000Hz (~60ms/chunk)
   ```

### Step 6: Check Transcription
1. **Expected**: You should see transcription appearing in the "Interviewer" transcript area
2. Check for log messages like:
   ```
   [LocalWhisperSTT/system] streaming profile: interval=1500ms minAudio=800ms
   [LocalWhisperSTT/system] write() chunks=N total=X.XKB last_chunk=1920B rate=16000Hz
   ```

## Validation Checklist

### ✅ Audio Flow
- [ ] SystemAudioCapture receives chunks from CoreAudio Tap
- [ ] `getSampleRate()` returns 16000Hz
- [ ] LocalWhisperSTT.setSampleRate() is called with 16000Hz
- [ ] write() logs show `rate=16000Hz`

### ✅ Inference Execution
- [ ] streamingTick() fires periodically (every 1500ms)
- [ ] VAD detects speech and opens segments
- [ ] Worker receives transcribe messages
- [ ] Transcription appears in UI

### ✅ Diagnostics
- [ ] Constructor logs show `inputRate=16000Hz`
- [ ] No "chunk #0" repetition in logs (old diagnostic issue fixed)
- [ ] write() logs are throttled (not flooded with every chunk)

## Expected Log Pattern (Working)
```
[Main] Using LocalWhisperSTT for interviewer, model: Xenova/whisper-tiny.en
[LocalWhisperSTT/system] streaming profile: interval=1500ms minAudio=800ms skipAgreement=false inputRate=16000Hz
[Main] Listen clicked
[Main] SystemAudio->STT: chunk #1, 1920B, googleSTT=active
[SystemAudioCapture] rate locked from first chunk: 16000Hz
[LocalWhisperSTT/system] Updated input sample rate: 16000Hz → 16000Hz
[LocalWhisperSTT/system] write() chunks=1 total=0.0KB last_chunk=1920B rate=16000Hz (~60ms/chunk)
[LocalWhisperSTT/system] write() chunks=51 total=97.7KB last_chunk=1920B rate=16000Hz (~60ms/chunk)
[LocalWhisperSTT/system] Dispatched 6400 samples for streaming inference
[LocalWhisperSTT/system] Got partial: "Hello"
[LocalWhisperSTT/system] Got partial: "Hello, this"
[LocalWhisperSTT/system] Got result: "Hello, this is a test."
```

## Debugging If It Still Doesn't Work

### Check 1: Verify setSampleRate Called
```
Grep logs for: "[LocalWhisperSTT/system] Updated input sample rate"
Expected: Should appear on first chunk
```

### Check 2: Verify resampleToF32 Correct
```
If sample rate is still 48000, resampleToF32 will still downsample 3x
Check write() logs: should show rate=16000Hz, not 48000Hz
```

### Check 3: Check VAD Detection
```
Add temporary log to VAD.push() return value
If VAD never opens segments, audio never reaches streamingTick
```

### Check 4: Verify Worker Dispatch
```
Look for logs in streamingTick confirming dispatch to worker
Check worker console for inference execution
```

## Rollback Plan
If the fix causes regressions:
1. The old behavior was `inputSampleRate = 48000`
2. Change default parameter: `inputSampleRate: number = 48000`
3. This restores hardcoded 48000Hz (broken, but matches old behavior)

## Success Criteria
✅ System audio plays → Transcription appears in UI with correct content
✅ No crashes or type errors
✅ Logs show proper sample rate flow: 16000Hz throughout
✅ VAD detects speech and triggers inference
✅ Both mic and system channels work (if Split Channels enabled)
