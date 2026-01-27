import Foundation

/// VAD (Voice Activity Detection) Gate
/// Uses energy-based detection with hysteresis and a ring buffer to suppress silence
/// while preserving speech quality.
///
/// State Machine:
/// - IDLE: Signal < startThreshold. Buffering to preRoll (do not emit).
/// - SPEECH: Signal > startThreshold. Emit everything.
/// - HANGOVER: Signal < endThreshold. Continue emitting for hangoverDuration.
///
final class VADGate {
    
    enum State: String {
        case idle
        case speech
        case hangover
    }
    
    // MARK: - Configuration
    
    /// RMS value to trigger SPEECH state (approx -45dB)
    /// Higher = less sensitive, less noise triggers
    let startThreshold: Float
    
    /// RMS value to exit SPEECH state (approx -50dB)
    /// Lower than startThreshold to prevent rapid switching
    let endThreshold: Float
    
    /// Duration to stay in HANGOVER state before going IDLE
    let hangoverDuration: TimeInterval
    
    /// Max chunks to keep in pre-roll buffer
    let maxPreRollCount: Int
    
    // MARK: - State
    
    private let identifier: String
    private(set) var state: State = .idle
    private var hangoverStartTime: TimeInterval = 0
    private var preRollBuffer: [Data] = []
    
    // Debug stats
    private var lastRMS: Float = 0
    
    init(identifier: String,
         startThreshold: Float = 185.0,  // ~ -45dBFS
         endThreshold: Float = 100.0,    // ~ -50dBFS
         hangoverDuration: TimeInterval = 0.5, // 500ms
         maxPreRollCount: Int = 3) {     // 300ms (assuming 100ms chunks)
        
        self.identifier = identifier
        self.startThreshold = startThreshold
        self.endThreshold = endThreshold
        self.hangoverDuration = hangoverDuration
        self.maxPreRollCount = maxPreRollCount
    }
    
    /// Process a chunk of audio and return data to be sent (if any)
    /// - Parameter chunk: Raw PCM audio data (Int16, mono/stereo)
    /// - Returns: Array of data chunks to send. Empty if silence.
    func process(chunk: Data) -> [Data] {
        let rms = calculateRMS(chunk)
        lastRMS = rms
        
        var output: [Data] = []
        
        switch state {
        case .idle:
            if rms > startThreshold {
                // Transition to SPEECH
                state = .speech
                Logger.log("VAD[\(identifier)] Triggered: IDLE -> SPEECH (RMS: \(Int(rms)))", level: .info)
                
                // Flush pre-roll + current chunk
                output.append(contentsOf: preRollBuffer)
                output.append(chunk)
                preRollBuffer.removeAll()
            } else {
                // Stay IDLE, maintain buffer
                preRollBuffer.append(chunk)
                if preRollBuffer.count > maxPreRollCount {
                    preRollBuffer.removeFirst()
                }
                // Do not emit
            }
            
        case .speech:
            if rms < endThreshold {
                // Transition to HANGOVER
                state = .hangover
                hangoverStartTime = Date().timeIntervalSince1970
                // Logger.log("VAD[\(identifier)] Hysteresis: SPEECH -> HANGOVER (RMS: \(Int(rms)))", level: .debug)
            }
            // Always emit in speech
            output.append(chunk)
            
        case .hangover:
            if rms > startThreshold {
                // Back to SPEECH
                state = .speech
                // Logger.log("VAD[\(identifier)] Resumed: HANGOVER -> SPEECH (RMS: \(Int(rms)))", level: .debug)
                output.append(chunk)
                
            } else {
                // Check duration
                let timeInHangover = Date().timeIntervalSince1970 - hangoverStartTime
                
                if timeInHangover > hangoverDuration {
                    // Transition to IDLE
                    state = .idle
                    Logger.log("VAD[\(identifier)] Silenced: HANGOVER -> IDLE", level: .info)
                    
                    // Start buffering this chunk for next utterance (don't emit clipped tail)
                    preRollBuffer.append(chunk)
                    if preRollBuffer.count > maxPreRollCount {
                        preRollBuffer.removeFirst()
                    }
                } else {
                    // Still in hangover, keep emitting
                    output.append(chunk)
                }
            }
        }
        
        return output
    }
    
    func reset() {
        state = .idle
        preRollBuffer.removeAll()
    }
    
    // MARK: - Helpers
    
    private func calculateRMS(_ data: Data) -> Float {
        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return 0 }
        
        return data.withUnsafeBytes { buffer -> Float in
            guard let int16Buffer = buffer.bindMemory(to: Int16.self).baseAddress else { return 0 }
            
            var sum: Float = 0
            // Optimization: Skip samples to save CPU (1 in 10 is plenty for VAD)
            let step = 10
            let iterations = sampleCount / step
            
            guard iterations > 0 else { return 0 }
            
            for i in 0..<iterations {
                let sample = Float(int16Buffer[i * step])
                sum += sample * sample
            }
            
            return sqrt(sum / Float(iterations))
        }
    }
}
