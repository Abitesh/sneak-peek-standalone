# Copilot Audio Service

Production-grade native macOS background service for real-time conversation copilot.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CopilotAudioService                         │
│                      (Main Orchestrator)                        │
└────────────┬────────────────┬────────────────┬─────────────────┘
             │                │                │
             ▼                ▼                ▼
┌────────────────┐  ┌─────────────────┐  ┌──────────────┐
│ AudioCapture   │  │   STTManager    │  │  IPCServer   │
│    Manager     │  │                 │  │  (WebSocket) │
└───────┬────────┘  └────────┬────────┘  └──────┬───────┘
        │                    │                   │
   ┌────┴────┐          ┌────┴────┐              │
   │   Mic   │          │  STT    │              │
   │ Engine  │          │ Stream  │              ▼
   └─────────┘          │  (x2)   │         ┌────────────┐
   ┌─────────┐          └─────────┘         │  Electron  │
   │ System  │                              │    App     │
   │ Engine  │                              └────────────┘
   └─────────┘
        │
        ▼
┌─────────────────┐    ┌─────────────────┐
│ ContextManager  │◄───│  TurnDetector   │
│ (Rolling 120s)  │    │  (Heuristics)   │
└─────────────────┘    └─────────────────┘
```

## Module Structure

```
Sources/CopilotAudioService/
├── main.swift                 # Entry point, CLI, signal handling
├── CopilotAudioService.swift  # Main orchestrator
├── AudioCaptureManager.swift  # Dual-pipeline CoreAudio capture
├── STTStream.swift            # WebSocket STT streaming
├── ContextManager.swift       # Conversation memory (120s window)
├── TurnDetector.swift         # Question detection & turn-taking
├── IPCServer.swift            # WebSocket server for Electron IPC
└── Logger.swift               # Logging utility
```

## Requirements

- macOS 13.0+
- Xcode 15+ / Swift 5.9+
- Virtual audio driver (e.g., BlackHole)
- Google Cloud Service Account JSON (Voice/Speech API enabled)

## Build

```bash
cd native-audio-service
swift build -c release
```

## Run

```bash
# Set required environment variables
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export COPILOT_VIRTUAL_DEVICE="BlackHole2ch_UID"  # Optional

# Run the service
.build/release/copilot-audio-service
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | (required) | Path to Google Service Account JSON |
| `COPILOT_IPC_PORT` | `9876` | WebSocket port for Electron IPC |
| `COPILOT_VIRTUAL_DEVICE` | `BlackHole2ch_UID` | Virtual audio device UID |
| `COPILOT_LOG_LEVEL` | `info` | Log level: debug/info/warning/error |

### Config File

Alternatively, create `~/.copilot-audio-service/config.json`:

```json
{
  "ipcPort": 9876,
  "virtualDeviceUID": "BlackHole2ch_UID",
  "contextWindowDuration": 120.0,
  "silenceThresholdMs": 500.0
}
```

## WebSocket IPC Protocol

### Electron → Native

```json
{"type": "pause"}
{"type": "resume"}
{"type": "shutdown"}
{"type": "get_context"}
```

### Native → Electron

**Transcript:**
```json
{
  "type": "transcript",
  "data": {
    "speaker": "interviewer",
    "text": "Can you tell me about yourself?",
    "timestamp": 1737209123.456,
    "final": true,
    "confidence": 0.95
  },
  "timestamp": 1737209123.456
}
```

**Suggestion Trigger:**
```json
{
  "type": "suggestion_trigger",
  "data": {
    "context": "[INTERVIEWER]: Can you tell me about yourself?",
    "lastQuestion": "Can you tell me about yourself?",
    "confidence": 0.85
  },
  "timestamp": 1737209124.100
}
```

**Status:**
```json
{
  "type": "status",
  "data": {
    "state": "running",
    "micConnected": true,
    "systemAudioConnected": true,
    "sttConnected": true
  },
  "timestamp": 1737209120.000
}
```

## Turn Detection Logic

The `TurnDetector` uses deterministic heuristics:

1. **Speaker Check**: Only triggers when last speaker = INTERVIEWER
2. **Finality Check**: Transcript must be marked as final
3. **Silence Detection**: 400-700ms silence required
4. **Question Semantics**: Detects questions via:
   - Punctuation (`?`)
   - Question words (what, why, how, etc.)
   - Question phrases ("tell me about", "can you explain", etc.)
5. **Overlap Prevention**: Avoids triggering during rapid speaker switching
6. **Cooldown**: 3-second minimum between triggers

## TODO Markers

The following require external configuration:

1. **STT Provider** (`STTStream.swift`): Adjust parsing for your provider's response format
2. **API Key** (`CopilotAudioService.swift`): Set via environment or config
3. **Virtual Device UID** (`AudioCaptureManager.swift`): Verify BlackHole device UID

## Electron Integration

```javascript
// Electron: Connect to native service
const ws = new WebSocket('ws://127.0.0.1:9876/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  if (message.type === 'transcript') {
    // Display transcript in overlay
  } else if (message.type === 'suggestion_trigger') {
    // Send context to LLM for suggestion generation
    generateSuggestion(message.data.context, message.data.lastQuestion);
  }
};

// Control commands
ws.send(JSON.stringify({type: 'pause'}));
ws.send(JSON.stringify({type: 'resume'}));
```
