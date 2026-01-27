import Foundation
import AVFoundation
import Vapor

// MARK: - Service Configuration

/// Configuration for the audio service
struct ServiceConfig: Codable {
    /// WebSocket port for Electron IPC
    var ipcPort: Int = 9876
    
    /// Virtual audio device UID (e.g., BlackHole)
    var virtualDeviceUID: String = "BlackHole2ch_UID"
    
    /// STT Provider: "google" or "deepgram"
    var sttProvider: String = "google"
    
    /// STT WebSocket endpoint (for Deepgram or custom)
    /// For Google, we use gRPC so this is not used
    var sttEndpoint: String = ""
    
    /// Google Cloud project ID (for Google STT)
    var googleProjectId: String = ""
    
    /// STT API key (for Deepgram) or Google service account JSON path
    var sttApiKey: String = ""
    
    /// Rolling context window duration (seconds)
    var contextWindowDuration: TimeInterval = 120.0
    
    /// Silence threshold for turn detection (ms)
    var silenceThresholdMs: Double = 500.0
    
    static func load() -> ServiceConfig {
        // Try to load from config file
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".copilot-audio-service")
            .appendingPathComponent("config.json")
        
        if let data = try? Data(contentsOf: configPath),
           let config = try? JSONDecoder().decode(ServiceConfig.self, from: data) {
            return config 
        }
        
        // Fallback to environment variables
        var config = ServiceConfig()
        
        if let port = ProcessInfo.processInfo.environment["COPILOT_IPC_PORT"],
           let portInt = Int(port) {
            config.ipcPort = portInt
        }
        
        if let deviceUID = ProcessInfo.processInfo.environment["COPILOT_VIRTUAL_DEVICE"] {
            config.virtualDeviceUID = deviceUID
        }
        
        if let provider = ProcessInfo.processInfo.environment["COPILOT_STT_PROVIDER"] {
            config.sttProvider = provider
        }
        
        if let endpoint = ProcessInfo.processInfo.environment["COPILOT_STT_ENDPOINT"] {
            config.sttEndpoint = endpoint
        }
        
        if let apiKey = ProcessInfo.processInfo.environment["COPILOT_STT_API_KEY"] {
            config.sttApiKey = apiKey
        }
        
        if let projectId = ProcessInfo.processInfo.environment["GOOGLE_CLOUD_PROJECT"] {
            config.googleProjectId = projectId
        }
        
        return config
    }
}

// MARK: - Service State

enum ServiceState: String {
    case initializing
    case running
    case paused
    case stopped
    case error
}

// MARK: - Main Service Orchestrator

/// Main service that coordinates all components
final class CopilotAudioService: AudioCaptureDelegate, STTStreamDelegate, IPCServerDelegate {
    
    // MARK: - Properties
    
    private let config: ServiceConfig
    
    private var audioCapture: AudioCaptureManager?
    private var sttManager: STTManager?
    private var contextManager: ContextManager
    private var turnDetector: TurnDetector
    private var ipcServer: IPCServer
    private var tokenProvider: ServiceAccountTokenProvider?
    
    private var state: ServiceState = .initializing
    private let stateLock = NSLock()
    
    // STT connection state
    private var micSTTConnected = false
    private var systemSTTConnected = false
    
    // Silence tracking for turn detection
    private var lastTranscriptTime: TimeInterval = 0
    private var silenceTimer: DispatchSourceTimer?
    
    // MARK: - Initialization
    
    init(config: ServiceConfig = .load()) {
        self.config = config
        self.contextManager = ContextManager() // Rolling window handled internally = 120s
        self.turnDetector = TurnDetector() // Uses default config
        self.ipcServer = IPCServer(port: config.ipcPort)
    }
    
    // MARK: - Lifecycle
    
    func start() {
        Logger.log("Starting Natively Audio Service...", level: .info)
        
        checkSystemAudioRouting()
        
        // Request microphone permission
        requestMicrophonePermission { [weak self] granted in
            guard let self = self else { return }
            
            guard granted else {
                Logger.log("Microphone permission denied", level: .error)
                self.updateState(.error)
                return
            }
            
            self.initializeComponents()
        }
    }
    
    func stop() {
        Logger.log("Stopping Natively Audio Service...", level: .info)
        
        audioCapture?.stop()
        sttManager?.stopAll()
        ipcServer.stop()
        
        updateState(.stopped)
    }
    
    // MARK: - Private Methods
    
    private func requestMicrophonePermission(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            completion(true)
            
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    completion(granted)
                }
            }
            
        case .denied, .restricted:
            completion(false)
            
        @unknown default:
            completion(false)
        }
    }
    
    private func initializeComponents() {
        // ADD THIS FIRST - List all devices to debug
        Logger.log("========== AUDIO DEVICE DISCOVERY ==========", level: .warning)
        HALSystemAudioCapture.listAllDevices()
        Logger.log("===========================================", level: .warning)

        do {
            // Initialize Auth
            var effectiveProjectId = config.googleProjectId
            if let credentialsPath = ProcessInfo.processInfo.environment["GOOGLE_APPLICATION_CREDENTIALS"] {
                tokenProvider = try ServiceAccountTokenProvider(credentialsPath: credentialsPath)
                Logger.log("Service Account Auth initialized", level: .info)
                
                // Use project ID from service account if not explicitly configured
                if effectiveProjectId.isEmpty {
                    effectiveProjectId = tokenProvider!.projectId
                    Logger.log("Using project ID from service account: \(effectiveProjectId)", level: .info)
                }
            } else {
                Logger.log("Warning: GOOGLE_APPLICATION_CREDENTIALS not set. gRPC STT will fail.", level: .warning)
            }
            
            // Initialize STT Manager with Auth
            // (Note: STTManager now exclusively uses GoogleGRPCStream)
            sttManager = STTManager(tokenProvider: tokenProvider, projectId: effectiveProjectId)
            sttManager?.delegate = self
            
            // Initialize IPC
            ipcServer.delegate = self
            
            // Start IPC server first
            try ipcServer.start()
            
            // Start STT streams (async connection)
            sttManager?.startStream(for: .microphone)
            sttManager?.startStream(for: .systemAudio)
            
            Logger.log("Starting audio capture immediately (buffering enabled)...", level: .info)
            
            // Initialize Audio Capture immediately
            // GoogleGRPCStream now buffers audio internally until gRPC handshake completes
            do {
                audioCapture = AudioCaptureManager(virtualDeviceUID: config.virtualDeviceUID)
                audioCapture?.delegate = self
                try audioCapture?.start()
                Logger.log("Audio capture started (mic + system)", level: .info)
            } catch {
                Logger.log("Audio capture failed: \(error)", level: .warning)
                Logger.log("Service will run without audio capture - connect via WebSocket to test", level: .warning)
                Logger.log("Install BlackHole (https://github.com/ExistentialAudio/BlackHole) for system audio", level: .info)
            }
            
            updateState(.running)
            sendStatusUpdate()
            
            Logger.log("Natively Audio Service started successfully", level: .info)
            
        } catch {
            Logger.log("Failed to initialize service: \(error)", level: .error)
            updateState(.error)
        }
    }
    
    private func updateState(_ newState: ServiceState) {
        stateLock.lock()
        state = newState
        stateLock.unlock()
        
        sendStatusUpdate()
    }
    
    private func sendStatusUpdate() {
        ipcServer.sendStatus(
            state: state.rawValue,
            micConnected: audioCapture != nil,
            systemAudioConnected: audioCapture != nil,
            sttConnected: micSTTConnected && systemSTTConnected
        )
    }
    
    // MARK: - AudioCaptureDelegate
    
    func audioCaptureManager(_ manager: AudioCaptureManager, didCapture chunk: Data, from source: AudioSource) {
        // Trace log for system audio to verify data flow
        if source == .systemAudio {
            // Reverted to debug level to prevent spam
            Logger.log("CopilotAudioService: Received system audio chunk (\(chunk.count) bytes)", level: .debug)
        }
        // Forward to STT
        sttManager?.sendAudio(chunk, to: source)
    }
    
    
    func audioCaptureManager(_ manager: AudioCaptureManager, didEncounterError error: Error, from source: AudioSource) {
        Logger.log("Audio capture error [\(source.rawValue)]: \(error)", level: .error)
    }
    
    func audioCaptureManager(_ manager: AudioCaptureManager, deviceChanged deviceUID: String?, for source: AudioSource) {
        Logger.log("Audio device changed [\(source.rawValue)]: \(deviceUID ?? "unknown")", level: .warning)
        sendStatusUpdate()
    }
    
    private func checkSystemAudioRouting() {
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address, 0, nil, &size, &deviceID
        )
        
        var deviceName: CFString = "" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &deviceName)
        
        Logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", level: .warning)
        Logger.log("⚠️  CURRENT SYSTEM OUTPUT: \(deviceName)", level: .warning)
        
        let deviceNameStr = deviceName as String
        if !deviceNameStr.lowercased().contains("blackhole") && 
           !deviceNameStr.lowercased().contains("multi") &&
           !deviceNameStr.lowercased().contains("mixed") &&
           !deviceNameStr.lowercased().contains("aggregate") {
            Logger.log("⚠️  WARNING: System output is NOT BlackHole!", level: .warning)
            Logger.log("⚠️  System audio will NOT be captured.", level: .warning)
            Logger.log("⚠️  Set output to BlackHole or Multi-Output Device in System Settings.", level: .warning)
        } else {
            Logger.log("✅ System output includes BlackHole - audio should be captured", level: .info)
        }
        Logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", level: .warning)
    }
    
    // MARK: - STTStreamDelegate
    
    func sttStream(_ stream: STTStreamProtocol, didReceive transcript: TranscriptSegment) {
        // Track speaker state for turn detection
        turnDetector.updateSpeakerState(speaker: transcript.speaker)
        
        // Add transcript to context
        if transcript.isFinal {
            contextManager.addTranscript(transcript)
        }
        
        // Track last transcript time for silence detection
        lastTranscriptTime = Date().timeIntervalSince1970
        resetSilenceTimer()
        
        // Forward to Electron
        ipcServer.sendTranscript(transcript)
    }
    
    func sttStream(_ stream: STTStreamProtocol, didEncounterError error: Error) {
        Logger.log("STT error: \(error)", level: .error)
    }
    
    func sttStreamDidConnect(_ stream: STTStreamProtocol) {
        if let grpcStream = stream as? GoogleGRPCStream {
            if grpcStream.source == .microphone {
                micSTTConnected = true
            } else {
                systemSTTConnected = true
            }
        }
        sendStatusUpdate()
    }
    
    func sttStreamDidDisconnect(_ stream: STTStreamProtocol) {
        // Auto-reconnect on disconnect (handles timeouts during silence)
        if let grpcStream = stream as? GoogleGRPCStream {
            let source = grpcStream.source
            Logger.log("STT stream disconnected for \(source.rawValue), attempting reconnect...", level: .warning)
            
            if source == .microphone {
                micSTTConnected = false
            } else {
                systemSTTConnected = false
            }
            
            // Reconnect after a short delay
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.sttManager?.startStream(for: source)
            }
        }
        sendStatusUpdate()
    }
    
    // MARK: - Turn Detection
    
    private func resetSilenceTimer() {
        silenceTimer?.cancel()
        silenceTimer = nil
        
        // Check for turn after silence
        silenceTimer = DispatchSource.makeTimerSource(queue: .main)
        silenceTimer?.schedule(deadline: .now() + 0.6) // 600ms silence threshold
        silenceTimer?.setEventHandler { [weak self] in
            self?.checkForTurnTrigger()
        }
        silenceTimer?.resume()
    }
    
    private func checkForTurnTrigger() {
        let silenceDurationMs = (Date().timeIntervalSince1970 - lastTranscriptTime) * 1000
        let result = turnDetector.analyze(context: contextManager, silenceDurationMs: silenceDurationMs)
        
        if result.shouldTrigger {
            Logger.log("Turn detected: \(result.reason)", level: .info)
            
            let context = contextManager.renderDialogue()
            let lastQuestion = result.lastInterviewerText ?? contextManager.getLastInterviewerTurn() ?? ""
            
            ipcServer.sendSuggestionTrigger(
                context: context,
                question: lastQuestion,
                confidence: result.confidence
            )
        }
    }
    
    // MARK: - IPCServerDelegate
    
    func ipcServerDidReceivePause(_ server: IPCServer) {
        audioCapture?.pause()
        updateState(.paused)
    }
    
    func ipcServerDidReceiveResume(_ server: IPCServer) {
        do {
            try audioCapture?.resume()
            updateState(.running)
        } catch {
            Logger.log("Failed to resume: \(error)", level: .error)
        }
    }
    
    func ipcServerDidReceiveShutdown(_ server: IPCServer) {
        stop()
        exit(0)
    }
    
    func ipcServerDidRequestContext(_ server: IPCServer) -> String {
        return contextManager.getFormattedContext()
    }
    
    func ipcServer(_ server: IPCServer, didConnect client: WebSocket) {
        Logger.log("Electron client connected", level: .info)
        sendStatusUpdate()
    }
    
    func ipcServer(_ server: IPCServer, didDisconnect client: WebSocket) {
        Logger.log("Electron client disconnected", level: .info)
    }
    
    func ipcServer(_ server: IPCServer, didReceiveAssistantSuggestion suggestion: String) {
        // Store the assistant's suggestion in context for Natively-style follow-ups
        // ("rephrase that", "make it shorter", "give me an example")
        contextManager.addAssistantSuggestion(suggestion)
        Logger.log("Stored assistant suggestion in context (\(suggestion.count) chars)", level: .info)
    }
}

// MARK: - Errors

enum ServiceError: Error {
    case invalidSTTEndpoint
    case permissionDenied
    case initializationFailed
}
