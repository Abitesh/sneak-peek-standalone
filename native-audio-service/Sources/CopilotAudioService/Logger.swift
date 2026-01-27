import Foundation

/// Log levels
enum LogLevel: String {
    case debug = "DEBUG"
    case info = "INFO"
    case warning = "WARN"
    case error = "ERROR"
}

/// Simple logging utility
enum Logger {
    
    /// Current minimum log level
    static var minLevel: LogLevel = .debug
    
    /// Log a message
    static func log(_ message: String, level: LogLevel = .info, file: String = #file, line: Int = #line) {
        guard shouldLog(level) else { return }
        
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let filename = (file as NSString).lastPathComponent
        
        let output = "[\(timestamp)] [\(level.rawValue)] [\(filename):\(line)] \(message)"
        
        switch level {
        case .error:
            fputs(output + "\n", stderr)
        default:
            print(output)
        }
    }
    
    private static func shouldLog(_ level: LogLevel) -> Bool {
        let levels: [LogLevel] = [.debug, .info, .warning, .error]
        guard let minIndex = levels.firstIndex(of: minLevel),
              let levelIndex = levels.firstIndex(of: level) else {
            return true
        }
        return levelIndex >= minIndex
    }
}
