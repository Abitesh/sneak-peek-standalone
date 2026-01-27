import Foundation
import Vapor

/// WebSocket message types from native service to Electron
enum OutgoingMessageType: String, Codable {
    case transcript
    case suggestionTrigger = "suggestion_trigger"
    case status
}

/// WebSocket message types from Electron to native service
enum IncomingMessageType: String, Codable {
    case pause
    case resume
    case shutdown
    case getContext = "get_context"
    case assistantSuggestion = "assistant_suggestion"
}

/// Outgoing message structure
struct OutgoingMessage: Codable {
    let type: String
    let data: AnyCodable
    let timestamp: TimeInterval
    
    init(type: OutgoingMessageType, data: Codable) {
        self.type = type.rawValue
        self.data = AnyCodable(data)
        self.timestamp = Date().timeIntervalSince1970
    }
}

/// Incoming message structure
struct IncomingMessage: Codable {
    let type: String
    let data: AnyCodable?
}

/// Transcript message payload
struct TranscriptPayload: Codable {
    let speaker: String
    let text: String
    let timestamp: TimeInterval
    let final: Bool
    let confidence: Double?
}

/// Suggestion trigger payload
struct SuggestionTriggerPayload: Codable {
    let context: String
    let lastQuestion: String
    let confidence: Double
}

/// Status payload
struct StatusPayload: Codable {
    let state: String
    let micConnected: Bool
    let systemAudioConnected: Bool
    let sttConnected: Bool
}

/// Protocol for IPC events
protocol IPCServerDelegate: AnyObject {
    func ipcServerDidReceivePause(_ server: IPCServer)
    func ipcServerDidReceiveResume(_ server: IPCServer)
    func ipcServerDidReceiveShutdown(_ server: IPCServer)
    func ipcServerDidRequestContext(_ server: IPCServer) -> String
    func ipcServer(_ server: IPCServer, didConnect client: WebSocket)
    func ipcServer(_ server: IPCServer, didDisconnect client: WebSocket)
    func ipcServer(_ server: IPCServer, didReceiveAssistantSuggestion suggestion: String)
}

/// WebSocket IPC server for Electron communication
final class IPCServer {
    
    // MARK: - Properties
    
    weak var delegate: IPCServerDelegate?
    
    private let port: Int
    private var app: Application?
    private var connectedClients: [WebSocket] = []
    private let clientLock = NSLock()
    
    // MARK: - Initialization
    
    init(port: Int = 9876) {
        self.port = port
    }
    
    // MARK: - Public Methods
    
    func start() throws {
        // Create a simple environment (don't use command line args)
        let env = Environment(name: "production", arguments: ["vapor"])
        
        app = Application(env)
        
        guard let app = app else {
            throw IPCError.serverInitFailed
        }
        
        // Configure HTTP server
        app.http.server.configuration.hostname = "127.0.0.1"
        app.http.server.configuration.port = port
        
        // Disable Vapor's default logging for cleaner output
        app.logger.logLevel = .warning
        
        // Configure WebSocket route
        app.webSocket("ws") { [weak self] req, ws in
            self?.handleNewConnection(ws)
        }
        
        // Start server in background
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try app.run()
            } catch {
                Logger.log("IPC server error: \(error)", level: .error)
            }
        }
        
        Logger.log("IPC server started on ws://127.0.0.1:\(port)/ws", level: .info)
    }
    
    func stop() {
        clientLock.lock()
        for client in connectedClients {
            try? client.close().wait()
        }
        connectedClients.removeAll()
        clientLock.unlock()
        
        app?.shutdown()
        app = nil
        
        Logger.log("IPC server stopped", level: .info)
    }
    
    /// Broadcast message to all connected clients
    func broadcast(_ message: OutgoingMessage) {
        guard let data = try? JSONEncoder().encode(message),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        
        clientLock.lock()
        let clients = connectedClients
        clientLock.unlock()
        
        for client in clients {
            client.send(json)
        }
    }
    
    /// Send transcript to Electron
    func sendTranscript(_ segment: TranscriptSegment) {
        let payload = TranscriptPayload(
            speaker: segment.speaker,
            text: segment.text,
            timestamp: segment.timestamp,
            final: segment.isFinal,
            confidence: segment.confidence
        )
        
        let message = OutgoingMessage(type: .transcript, data: payload)
        broadcast(message)
    }
    
    /// Send suggestion trigger to Electron
    func sendSuggestionTrigger(context: String, question: String, confidence: Double) {
        let payload = SuggestionTriggerPayload(
            context: context,
            lastQuestion: question,
            confidence: confidence
        )
        
        let message = OutgoingMessage(type: .suggestionTrigger, data: payload)
        broadcast(message)
        
        Logger.log("Suggestion trigger sent: \(question.prefix(50))...", level: .info)
    }
    
    /// Send status update to Electron
    func sendStatus(state: String, micConnected: Bool, systemAudioConnected: Bool, sttConnected: Bool) {
        let payload = StatusPayload(
            state: state,
            micConnected: micConnected,
            systemAudioConnected: systemAudioConnected,
            sttConnected: sttConnected
        )
        
        let message = OutgoingMessage(type: .status, data: payload)
        broadcast(message)
    }
    
    /// Get connected client count
    var clientCount: Int {
        clientLock.lock()
        defer { clientLock.unlock() }
        return connectedClients.count
    }
    
    // MARK: - Private Methods
    
    private func handleNewConnection(_ ws: WebSocket) {
        clientLock.lock()
        connectedClients.append(ws)
        clientLock.unlock()
        
        Logger.log("IPC client connected (total: \(clientCount))", level: .info)
        delegate?.ipcServer(self, didConnect: ws)
        
        // Handle incoming messages
        ws.onText { [weak self] ws, text in
            self?.handleMessage(text, from: ws)
        }
        
        // Handle disconnection
        ws.onClose.whenComplete { [weak self] _ in
            self?.handleDisconnection(ws)
        }
    }
    
    private func handleDisconnection(_ ws: WebSocket) {
        clientLock.lock()
        connectedClients.removeAll { $0 === ws }
        clientLock.unlock()
        
        Logger.log("IPC client disconnected (remaining: \(clientCount))", level: .info)
        delegate?.ipcServer(self, didDisconnect: ws)
    }
    
    private func handleMessage(_ text: String, from ws: WebSocket) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONDecoder().decode(IncomingMessage.self, from: data) else {
            Logger.log("IPC: Invalid message received", level: .warning)
            return
        }
        
        guard let type = IncomingMessageType(rawValue: message.type) else {
            Logger.log("IPC: Unknown message type: \(message.type)", level: .warning)
            return
        }
        
        switch type {
        case .pause:
            Logger.log("IPC: Pause received", level: .info)
            delegate?.ipcServerDidReceivePause(self)
            
        case .resume:
            Logger.log("IPC: Resume received", level: .info)
            delegate?.ipcServerDidReceiveResume(self)
            
        case .shutdown:
            Logger.log("IPC: Shutdown received", level: .info)
            delegate?.ipcServerDidReceiveShutdown(self)
            
        case .getContext:
            if let context = delegate?.ipcServerDidRequestContext(self) {
                let response = OutgoingMessage(type: .status, data: ["context": context])
                if let responseData = try? JSONEncoder().encode(response),
                   let json = String(data: responseData, encoding: .utf8) {
                    ws.send(json)
                }
            }
            
        case .assistantSuggestion:
            // Extract suggestion text from message data
            if let dataDict = message.data?.value as? [String: Any],
               let suggestionText = dataDict["text"] as? String {
                Logger.log("IPC: Assistant suggestion received (\(suggestionText.count) chars)", level: .info)
                delegate?.ipcServer(self, didReceiveAssistantSuggestion: suggestionText)
            }
        }
    }
}

// MARK: - Errors

enum IPCError: Error {
    case serverInitFailed
    case encodingFailed
}

// MARK: - AnyCodable Helper

/// Type-erased Codable wrapper for dynamic JSON
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else {
            value = NSNull()
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        switch value {
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let string as String:
            try container.encode(string)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let bool as Bool:
            try container.encode(bool)
        case let codable as Codable:
            try codable.encode(to: encoder)
        default:
            try container.encodeNil()
        }
    }
}
