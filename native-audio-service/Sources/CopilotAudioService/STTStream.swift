import Foundation
import NIO
import GRPC

/// Represents a piece of transcription
struct TranscriptSegment: Codable, CustomStringConvertible {
    let speaker: String
    let text: String
    let timestamp: TimeInterval
    let isFinal: Bool
    let confidence: Double
    
    var description: String {
        return "[\(speaker)] \(text) (final: \(isFinal))"
    }
}

/// Delegate for receiving STT events
protocol STTStreamDelegate: AnyObject {
    func sttStream(_ stream: STTStreamProtocol, didReceive transcript: TranscriptSegment)
    func sttStream(_ stream: STTStreamProtocol, didEncounterError error: Error)
    func sttStreamDidConnect(_ stream: STTStreamProtocol)
    func sttStreamDidDisconnect(_ stream: STTStreamProtocol)
}

/// Protocol for STT Streaming implementations
protocol STTStreamProtocol: AnyObject {
    var delegate: STTStreamDelegate? { get set }
    func connect()
    func sendAudio(_ audioData: Data)
    func disconnect()
}

// AudioSource is defined in AudioCaptureManager.swift

/// Provider selection (Deprecated, only Google gRPC supported)
enum STTProvider: String {
    case google
    case deepgram // Retained for config compatibility but unused
}

/// Manages multiple STT streams (mic + system)
final class STTManager {
    
    weak var delegate: STTStreamDelegate? {
        didSet {
            streams.values.forEach { $0.delegate = delegate }
        }
    }
    
    private let tokenProvider: ServiceAccountTokenProvider?
    private let projectId: String
    private var streams: [AudioSource: STTStreamProtocol] = [:]
    
    private let eventLoopGroup: EventLoopGroup
    
    init(tokenProvider: ServiceAccountTokenProvider?, projectId: String) {
        self.tokenProvider = tokenProvider
        self.projectId = projectId
        // Use PlatformSupport to get the native OS event loop (NIOTS on macOS)
        // This ensures SSL certificates work correctly without manual configuration.
        self.eventLoopGroup = PlatformSupport.makeEventLoopGroup(loopCount: 2)
    }
    
    deinit {
        try? eventLoopGroup.syncShutdownGracefully()
    }
    
    func startStream(for source: AudioSource) {
        guard let provider = tokenProvider else {
            Logger.log("STTManager: No token provider available for \(source.rawValue)", level: .error)
            return
        }
        
        Logger.log("STTManager: Starting gRPC stream for \(source.rawValue)", level: .info)
        
        let stream = GoogleGRPCStream(
            source: source,
            tokenProvider: provider,
            projectId: projectId,
            eventLoopGroup: eventLoopGroup
        )
        stream.delegate = delegate
        stream.connect()
        streams[source] = stream
    }
    
    func sendAudio(_ data: Data, to source: AudioSource) {
        if let stream = streams[source] {
            stream.sendAudio(data)
        } else {
            Logger.log("STTManager: No stream for \(source.rawValue)! Available: \(streams.keys.map { $0.rawValue })", level: .warning)
        }
    }
    
    func stopAll() {
        defer {
             streams.removeAll()
        }
        
        for (source, stream) in streams {
            Logger.log("Stopping stream: \(source.rawValue)", level: .info)
            stream.disconnect()
        }
    }
}
