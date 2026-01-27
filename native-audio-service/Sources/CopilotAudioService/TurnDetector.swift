import Foundation

/// Result of turn detection analysis
struct TurnDetectionResult {
    let shouldTrigger: Bool
    let reason: String
    let confidence: Double
    let lastInterviewerText: String?
}

/// Deterministic turn-taking and trigger detection
/// Decides when to generate AI suggestions based on conversation flow
final class TurnDetector {
    
    // MARK: - Configuration
    
    struct Config {
        /// Minimum silence duration to consider turn complete (ms)
        var minSilenceDurationMs: Double = 400
        
        /// Maximum silence duration before forcing trigger (ms)
        var maxSilenceDurationMs: Double = 700
        
        /// Minimum word count in interviewer's last utterance
        var minWordCount: Int = 3
        
        /// Question indicator words (heuristic, not just "?")
        var questionIndicators: Set<String> = [
            "what", "why", "how", "when", "where", "who", "which",
            "can", "could", "would", "should", "do", "does", "did",
            "is", "are", "was", "were", "have", "has", "had",
            "tell", "explain", "describe", "walk", "give"
        ]
        
        /// Phrases that indicate a question
        var questionPhrases: [String] = [
            "tell me about",
            "can you explain",
            "walk me through",
            "give me an example",
            "what do you think",
            "how would you",
            "what would you",
            "why did you",
            "describe a time",
            "have you ever"
        ]
    }
    
    // MARK: - Properties
    
    private var config: Config
    private var lastTriggerTime: TimeInterval = 0
    private var lastSpeaker: String?
    private var lastSpeakerChangeTime: TimeInterval = 0
    
    /// Cooldown between triggers to prevent spamming (seconds)
    private let triggerCooldown: TimeInterval = 3.0
    
    // MARK: - Initialization
    
    init(config: Config = Config()) {
        self.config = config
    }
    
    // MARK: - Public Methods
    
    /// Analyze conversation state and determine if AI suggestion should be triggered
    /// - Parameters:
    ///   - context: Current conversation context
    ///   - silenceDurationMs: Current silence duration in milliseconds
    /// - Returns: Turn detection result
    func analyze(context: ContextManager, silenceDurationMs: Double) -> TurnDetectionResult {
        let now = Date().timeIntervalSince1970
        
        // Check cooldown
        if now - lastTriggerTime < triggerCooldown {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "Cooldown active",
                confidence: 0,
                lastInterviewerText: nil
            )
        }
        
        // Get last turn
        guard let lastTurn = context.getLastTurn() else {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "No conversation context",
                confidence: 0,
                lastInterviewerText: nil
            )
        }
        
        // Rule 1: Last speaker must be interviewer
        guard lastTurn.speaker == "interviewer" else {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "Last speaker is user",
                confidence: 0,
                lastInterviewerText: nil
            )
        }
        
        // Rule 2: Check silence duration
        let silenceOk = silenceDurationMs >= config.minSilenceDurationMs
        guard silenceOk else {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "Insufficient silence (\(Int(silenceDurationMs))ms)",
                confidence: 0,
                lastInterviewerText: lastTurn.text
            )
        }
        
        // Rule 3: Check for interruption/overlap
        if isOverlapDetected(context: context) {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "Overlap detected",
                confidence: 0,
                lastInterviewerText: lastTurn.text
            )
        }
        
        // Rule 4: Check content quality
        let words = lastTurn.text.split(separator: " ")
        guard words.count >= config.minWordCount else {
            return TurnDetectionResult(
                shouldTrigger: false,
                reason: "Utterance too short (\(words.count) words)",
                confidence: 0.2,
                lastInterviewerText: lastTurn.text
            )
        }
        
        // Rule 5: Detect question semantics
        let (isQuestion, questionConfidence) = detectQuestionSemantics(text: lastTurn.text)
        
        // Calculate overall confidence
        let silenceScore = min(silenceDurationMs / config.maxSilenceDurationMs, 1.0)
        let overallConfidence = (questionConfidence * 0.6) + (silenceScore * 0.4)
        
        // Threshold for triggering
        let shouldTrigger = isQuestion && overallConfidence >= 0.5
        
        if shouldTrigger {
            lastTriggerTime = now
        }
        
        return TurnDetectionResult(
            shouldTrigger: shouldTrigger,
            reason: shouldTrigger ? "Question detected with sufficient silence" : "Low confidence question",
            confidence: overallConfidence,
            lastInterviewerText: lastTurn.text
        )
    }
    
    /// Update speaker state for overlap detection
    func updateSpeakerState(speaker: String) {
        let now = Date().timeIntervalSince1970
        if lastSpeaker != speaker {
            lastSpeaker = speaker
            lastSpeakerChangeTime = now
        }
    }
    
    /// Reset detector state
    func reset() {
        lastTriggerTime = 0
        lastSpeaker = nil
        lastSpeakerChangeTime = 0
    }
    
    // MARK: - Private Methods
    
    private func detectQuestionSemantics(text: String) -> (isQuestion: Bool, confidence: Double) {
        let lowercased = text.lowercased()
        let trimmed = lowercased.trimmingCharacters(in: .whitespacesAndNewlines)
        
        var confidence: Double = 0
        var signals: [Double] = []
        
        // Signal 1: Ends with question mark
        if trimmed.hasSuffix("?") {
            signals.append(0.9)
        }
        
        // Signal 2: Starts with question word
        let firstWord = trimmed.split(separator: " ").first.map(String.init) ?? ""
        if config.questionIndicators.contains(firstWord) {
            signals.append(0.7)
        }
        
        // Signal 3: Contains question phrase
        for phrase in config.questionPhrases {
            if lowercased.contains(phrase) {
                signals.append(0.8)
                break
            }
        }
        
        // Signal 4: Contains any question word
        let containsQuestionWord = config.questionIndicators.contains { lowercased.contains($0) }
        if containsQuestionWord {
            signals.append(0.4)
        }
        
        // Signal 5: Upward intonation pattern (approximated by sentence structure)
        // Sentences that are questions often have specific structures
        if trimmed.contains("you") && (trimmed.contains("can") || trimmed.contains("could") || trimmed.contains("would")) {
            signals.append(0.5)
        }
        
        // Calculate weighted average
        if signals.isEmpty {
            return (false, 0)
        }
        
        confidence = signals.reduce(0, +) / Double(signals.count)
        let isQuestion = confidence >= 0.4
        
        return (isQuestion, confidence)
    }
    
    private func isOverlapDetected(context: ContextManager) -> Bool {
        let recentTurns = context.getLastTurns(4)
        
        guard recentTurns.count >= 2 else { return false }
        
        // Check for rapid speaker switching (indicates interruption)
        for i in 1..<recentTurns.count {
            let prev = recentTurns[i - 1]
            let curr = recentTurns[i]
            
            // If speakers switched within 300ms, likely overlap
            if prev.speaker != curr.speaker && abs(curr.timestamp - prev.timestamp) < 0.3 {
                return true
            }
        }
        
        return false
    }
}
