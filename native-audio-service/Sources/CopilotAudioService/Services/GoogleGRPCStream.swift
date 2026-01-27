import Foundation
import GRPC
import NIO
import SwiftProtobuf

final class GoogleGRPCStream: STTStreamProtocol, @unchecked Sendable {
    
    weak var delegate: STTStreamDelegate?
    let source: AudioSource
    
    private let tokenProvider: ServiceAccountTokenProvider
    private let projectId: String
    private let group: EventLoopGroup
    private var channel: GRPCChannel?
    private var client: Google_Cloud_Speech_V2_SpeechNIOClient?
    private var stream: BidirectionalStreamingCall<Google_Cloud_Speech_V2_StreamingRecognizeRequest, Google_Cloud_Speech_V2_StreamingRecognizeResponse>?
    
    private let queue = DispatchQueue(label: "com.copilot.grpc.stream")
    
    // STATE MANAGEMENT
    private var isConnected = false
    // Buffer for audio chunks captured before the stream is ready
    private var pendingAudioBuffer: [Data] = []
    private let bufferLock = NSLock()
    
    init(source: AudioSource, tokenProvider: ServiceAccountTokenProvider, projectId: String, eventLoopGroup: EventLoopGroup) {
        self.source = source
        self.tokenProvider = tokenProvider
        self.projectId = projectId
        self.group = eventLoopGroup
    }
    
    func connect() {
        queue.async { [weak self] in
            self?.performConnect()
        }
    }
    
    private func performConnect() {
        guard !isConnected else { return }
        
        Task {
            do {
                Logger.log("GoogleGRPC[\(self.source.rawValue)] fetching auth token...", level: .info)
                let token = try await tokenProvider.getAccessToken()
                
                // KeepAlive is critical for long-running streams
                let keepalive = ClientConnectionKeepalive(
                    interval: .seconds(30),
                    timeout: .seconds(20), // Increased from 10s
                    permitWithoutCalls: true
                )
                
                // Initialize Channel
                let channel = try GRPCChannelPool.with(
                    target: .host("speech.googleapis.com", port: 443),
                    transportSecurity: .tls(.makeClientDefault(compatibleWith: group)),
                    eventLoopGroup: group
                ) { config in
                    config.keepalive = keepalive
                }
                self.channel = channel
                
                // Custom Headers for Auth and Project info
                let callOptions = CallOptions(
                    customMetadata: [
                        "authorization": "Bearer \(token)",
                        "x-goog-user-project": self.projectId
                    ],
                    timeLimit: .none // Streaming calls must not timeout
                )
                
                let client = Google_Cloud_Speech_V2_SpeechNIOClient(channel: channel, defaultCallOptions: callOptions)
                self.client = client
                
                Logger.log("GoogleGRPC[\(self.source.rawValue)] opening stream...", level: .info)
                
                // Start Bidirectional Stream
                let stream = client.streamingRecognize { [weak self] response in
                    self?.handleResponse(response)
                }
                self.stream = stream
                
                // Monitor stream status
                stream.status.whenComplete { result in
                    switch result {
                    case .success(let status):
                        if !status.isOk {
                            Logger.log("GoogleGRPC[\(self.source.rawValue)] stream closed with error: code=\(status.code) message='\(status.message ?? "unknown")'", level: .error)
                        } else {
                            Logger.log("GoogleGRPC[\(self.source.rawValue)] stream closed gracefully", level: .info)
                        }
                        self.isConnected = false
                        self.delegate?.sttStreamDidDisconnect(self)
                        
                    case .failure(let error):
                        Logger.log("GoogleGRPC[\(self.source.rawValue)] stream failed: \(error)", level: .error)
                        self.isConnected = false
                    }
                }
                
                // Send Initial Config
                Logger.log("GoogleGRPC[\(self.source.rawValue)] sending initial config...", level: .info)
                let configRequest = self.makeConfigMessage()
                
                let promise = stream.eventLoop.makePromise(of: Void.self)
                stream.sendMessage(configRequest, promise: promise)
                
                promise.futureResult.whenComplete { result in
                    switch result {
                    case .success:
                        Logger.log("GoogleGRPC[\(self.source.rawValue)] config sent. Flushing buffer...", level: .info)
                        self.isConnected = true
                        self.delegate?.sttStreamDidConnect(self)
                        self.flushPendingBuffer()
                        
                    case .failure(let error):
                        Logger.log("GoogleGRPC[\(self.source.rawValue)] failed to send config: \(error)", level: .error)
                        self.delegate?.sttStream(self, didEncounterError: error)
                    }
                }
                
            } catch {
                Logger.log("GoogleGRPC[\(self.source.rawValue)] connection setup failed: \(error)", level: .error)
                self.delegate?.sttStream(self, didEncounterError: error)
            }
        }
    }
    
    private func makeConfigMessage() -> Google_Cloud_Speech_V2_StreamingRecognizeRequest {
        var request = Google_Cloud_Speech_V2_StreamingRecognizeRequest()
        
        // V2 Resource Name: projects/{project}/locations/{location}/recognizers/{recognizer}
        // Using "_" uses the global dynamic recognizer
        request.recognizer = "projects/\(projectId)/locations/global/recognizers/_"
        
        var streamingConfig = Google_Cloud_Speech_V2_StreamingRecognitionConfig()
        
        var config = Google_Cloud_Speech_V2_RecognitionConfig()
        // Use "latest_long" instead of "chirp" for reliability and lower latency in interviews
        // "chirp" is expensive and often requires specific region enabling.
        config.model = "latest_long" 
        config.languageCodes = ["en-US"]
        
        // Explicit decoding is safer for raw PCM
        var explicitDecoding = Google_Cloud_Speech_V2_ExplicitDecodingConfig()
        explicitDecoding.encoding = .linear16
        explicitDecoding.sampleRateHertz = 16000
        explicitDecoding.audioChannelCount = 1
        config.explicitDecodingConfig = explicitDecoding
        
        // Enable automatic punctuation for better LLM readability
        var features = Google_Cloud_Speech_V2_RecognitionFeatures()
        features.enableAutomaticPunctuation = true
        config.features = features
        
        streamingConfig.config = config
        
        // Interim results are critical for "real-time" feel
        var streamingFeatures = Google_Cloud_Speech_V2_StreamingRecognitionFeatures()
        streamingFeatures.interimResults = true
        streamingConfig.streamingFeatures = streamingFeatures
        
        request.streamingConfig = streamingConfig
        
        return request
    }
    
    func sendAudio(_ audioData: Data) {
        Logger.log("GoogleGRPC[\(source.rawValue)] sendAudio called with \(audioData.count) bytes. Connected: \(isConnected)", level: .debug)
        
        bufferLock.lock()
        defer { bufferLock.unlock() }
        
        if isConnected {
            // If connected, send immediately
            sendDataToStream(audioData)
        } else {
            // If connecting, buffer the audio so we don't lose the first word
            pendingAudioBuffer.append(audioData)
            
            // Safety: prevent infinite memory growth if connection fails for too long
            if pendingAudioBuffer.count > 500 { // Approx 50 seconds
                pendingAudioBuffer.removeFirst()
            }
        }
    }
    
    private func flushPendingBuffer() {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        
        Logger.log("GoogleGRPC[\(source.rawValue)] flushing \(pendingAudioBuffer.count) chunks", level: .info)
        
        for data in pendingAudioBuffer {
            sendDataToStream(data)
        }
        pendingAudioBuffer.removeAll()
    }
    
    private func sendDataToStream(_ data: Data) {
        guard let stream = stream else { return }
        
        Logger.log("GoogleGRPC[\(source.rawValue)] sending chunk: \(data.count) bytes", level: .debug)
        
        var request = Google_Cloud_Speech_V2_StreamingRecognizeRequest()
        request.audio = data
        
        // Use promise to track send failures
        let promise = stream.eventLoop.makePromise(of: Void.self)
        stream.sendMessage(request, promise: promise)
        
        promise.futureResult.whenFailure { [weak self] error in
             Logger.log("GoogleGRPC[\(self?.source.rawValue ?? "?")] send failed: \(error)", level: .error)
        }
    }
    
    func disconnect() {
        isConnected = false
        stream?.sendEnd(promise: nil)
        
        // Clear buffer
        bufferLock.lock()
        pendingAudioBuffer.removeAll()
        bufferLock.unlock()
        
        // Wait a tick to allow the close frame to send
        queue.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            try? self?.channel?.close().wait()
            self?.channel = nil
            self?.stream = nil
            self?.client = nil
            self?.delegate?.sttStreamDidDisconnect(self!)
        }
    }
    
    private func handleResponse(_ response: Google_Cloud_Speech_V2_StreamingRecognizeResponse) {
        Logger.log("GoogleGRPC[\(source.rawValue)] received response: results=\(response.results.count), speechEventType=\(response.speechEventType)", level: .debug)
        
        // V2 can return empty results (e.g. metadata updates), ignore them
        guard !response.results.isEmpty else { return }
        
        for result in response.results {
            guard let alternative = result.alternatives.first else { continue }
            
            let transcript = alternative.transcript
            if transcript.isEmpty { continue }
            
            let isFinal = result.isFinal
            let confidence = Double(alternative.confidence)
            
            let segment = TranscriptSegment(
                speaker: source.rawValue,
                text: transcript,
                timestamp: Date().timeIntervalSince1970,
                isFinal: isFinal,
                confidence: confidence
            )
            
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.delegate?.sttStream(self, didReceive: segment)
            }
        }
    }
}
