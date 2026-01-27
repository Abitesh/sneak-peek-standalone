import Foundation

/// Represents a conversation turn in memory
struct ConversationTurn: Codable, Equatable {
    let speaker: String
    let text: String
    let timestamp: TimeInterval
    
    /// Unique identifier for deduplication
    var id: String {
        return "\(speaker)_\(Int(timestamp * 1000))"
    }
}

/// In-memory conversation context manager with rolling window
final class ContextManager {
    
    // MARK: - Properties
    
    /// Rolling window duration in seconds
    private let windowDuration: TimeInterval
    
    /// Thread-safe storage
    private var turns: [ConversationTurn] = []
    private let lock = NSLock()
    
    /// Maximum turns to prevent memory issues (safety limit)
    private let maxTurns = 500
    
    // MARK: - Initialization
    
    /// Initialize context manager
    /// - Parameter windowDuration: Rolling window duration in seconds (default: 120)
    init(windowDuration: TimeInterval = 120.0) {
        self.windowDuration = windowDuration
    }
    
    // MARK: - Public Methods
    
    /// Add a finalized transcript to context
    /// - Parameter segment: Finalized transcript segment
    func addTranscript(_ segment: TranscriptSegment) {
        guard segment.isFinal else { return }
        
        let turn = ConversationTurn(
            speaker: segment.speaker,
            text: segment.text.trimmingCharacters(in: .whitespacesAndNewlines),
            timestamp: segment.timestamp
        )
        
        // Skip empty turns
        guard !turn.text.isEmpty else { return }
        
        lock.lock()
        defer { lock.unlock() }
        
        // Deduplicate: check if this exact turn already exists
        if let lastTurn = turns.last,
           lastTurn.speaker == turn.speaker,
           abs(lastTurn.timestamp - turn.timestamp) < 0.5,
           lastTurn.text == turn.text {
            return
        }
        
        turns.append(turn)
        evictOldEntries()
    }
    
    /// Get all turns within the rolling window
    /// - Returns: Array of conversation turns
    func getTurns() -> [ConversationTurn] {
        lock.lock()
        defer { lock.unlock() }
        
        evictOldEntries()
        return turns
    }
    
    /// Get the last N turns
    /// - Parameter count: Number of turns to retrieve
    /// - Returns: Array of most recent turns
    func getLastTurns(_ count: Int) -> [ConversationTurn] {
        lock.lock()
        defer { lock.unlock() }
        
        return Array(turns.suffix(count))
    }
    
    /// Get the most recent turn
    /// - Returns: Last conversation turn if available
    func getLastTurn() -> ConversationTurn? {
        lock.lock()
        defer { lock.unlock() }
        
        return turns.last
    }
    
    /// Get the most recent turn from a specific speaker
    /// - Parameter speaker: Speaker identifier
    /// - Returns: Last turn from that speaker
    func getLastTurn(from speaker: String) -> ConversationTurn? {
        lock.lock()
        defer { lock.unlock() }
        
        return turns.last { $0.speaker == speaker }
    }
    
    /// Add an assistant suggestion to context
    /// This enables Natively-style "rephrase that" / "make it shorter" behavior
    /// - Parameter text: The assistant's suggestion text
    func addAssistantSuggestion(_ text: String) {
        let turn = ConversationTurn(
            speaker: "assistant",
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            timestamp: Date().timeIntervalSince1970
        )
        
        guard !turn.text.isEmpty else { return }
        
        lock.lock()
        defer { lock.unlock() }
        
        turns.append(turn)
        evictOldEntries()
    }
    
    /// Get the last assistant suggestion
    /// - Returns: Most recent assistant suggestion if available
    func getLastAssistantSuggestion() -> String? {
        lock.lock()
        defer { lock.unlock() }
        
        return turns.last { $0.speaker == "assistant" }?.text
    }
    
    /// Render conversation as formatted dialogue string
    /// - Returns: Formatted conversation string
    func renderDialogue() -> String {
        lock.lock()
        defer { lock.unlock() }
        
        evictOldEntries()
        
        return turns.map { turn in
            let speakerLabel: String
            switch turn.speaker {
            case "user":
                speakerLabel = "ME"
            case "assistant":
                speakerLabel = "ASSISTANT (PREVIOUS SUGGESTION)"
            default:
                speakerLabel = "INTERVIEWER"
            }
            return "[\(speakerLabel)]: \(turn.text)"
        }.joined(separator: "\n")
    }
    
    /// Render conversation as JSON array
    /// - Returns: JSON string representation
    func renderJSON() -> String? {
        lock.lock()
        defer { lock.unlock() }
        
        evictOldEntries()
        
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        
        guard let data = try? encoder.encode(turns) else { return nil }
        return String(data: data, encoding: .utf8)
    }
    
    /// Clear all context
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        
        turns.removeAll()
    }
    
    /// Get total turn count
    var turnCount: Int {
        lock.lock()
        defer { lock.unlock() }
        
        return turns.count
    }
    
    // MARK: - Compatibility Aliases
    
    /// Get formatted context (alias for renderDialogue)
    /// Used by CopilotAudioService and TurnDetector
    func getFormattedContext() -> String {
        return renderDialogue()
    }
    
    /// Get the last interviewer turn text
    /// - Returns: Text of the most recent interviewer turn
    func getLastInterviewerTurn() -> String? {
        return getLastTurn(from: "interviewer")?.text
    }
    
    // MARK: - Private Methods
    
    /// Evict entries older than the rolling window
    /// Note: Must be called within lock
    private func evictOldEntries() {
        let cutoff = Date().timeIntervalSince1970 - windowDuration
        turns.removeAll { $0.timestamp < cutoff }
        
        // Safety limit
        if turns.count > maxTurns {
            turns.removeFirst(turns.count - maxTurns)
        }
    }
}
