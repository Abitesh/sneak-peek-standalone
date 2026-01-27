import Foundation
import Dispatch

/// Entry point for the Copilot Audio Service
struct Main {
    static func main() {
        // Load .env file first
        loadEnv()
        
        // Parse command line arguments
        let arguments = CommandLine.arguments
        
        if arguments.contains("--help") || arguments.contains("-h") {
            printUsage()
            return
        }
        
        if arguments.contains("--version") || arguments.contains("-v") {
            print("Copilot Audio Service v1.0.0")
            return
        }
        
        // Set log level from environment
        if let logLevel = ProcessInfo.processInfo.environment["COPILOT_LOG_LEVEL"] {
            switch logLevel.lowercased() {
            case "debug":
                Logger.minLevel = .debug
            case "info":
                Logger.minLevel = .info
            case "warning", "warn":
                Logger.minLevel = .warning
            case "error":
                Logger.minLevel = .error
            default:
                break
            }
        }
        
        Logger.log("===========================================", level: .info)
        Logger.log("  Copilot Audio Service Starting", level: .info)
        Logger.log("===========================================", level: .info)
        
        // Load configuration
        let config = ServiceConfig.load()
        
        Logger.log("Configuration:", level: .info)
        Logger.log("  IPC Port: \(config.ipcPort)", level: .info)
        Logger.log("  Virtual Device: \(config.virtualDeviceUID)", level: .info)
        if !config.sttEndpoint.isEmpty {
            Logger.log("  STT Endpoint: \(config.sttEndpoint.prefix(50))...", level: .info)
        } else {
             Logger.log("  STT Provider: \(config.sttProvider) (gRPC)", level: .info)
        }
        Logger.log("  Context Window: \(config.contextWindowDuration)s", level: .info)
        
        // Validate Google credentials for gRPC
        let googleCreds = ProcessInfo.processInfo.environment["GOOGLE_APPLICATION_CREDENTIALS"] ?? ""
        guard !googleCreds.isEmpty else {
            Logger.log("ERROR: Google credentials not configured", level: .error)
            Logger.log("Set GOOGLE_APPLICATION_CREDENTIALS environment variable to your service account JSON", level: .error)
            Logger.log("Example: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json", level: .error)
            exit(1)
        }
        
        Logger.log("  Google Credentials: \(googleCreds)", level: .info)
        
        // Create and start service
        let service = CopilotAudioService(config: config)
        
        // Handle termination signals
        setupSignalHandlers(service: service)
        
        // Start the service
        service.start()
        
        // Keep the process running
        dispatchMain()
    }
    
    static func loadEnv() {
        let fileManager = FileManager.default
        // Check current directory and parent directory for .env
        let possiblePaths = [".env", "../.env"]
        
        for relativePath in possiblePaths {
            let currentPath = fileManager.currentDirectoryPath
            let envPath = URL(fileURLWithPath: currentPath).appendingPathComponent(relativePath).path
            
            if fileManager.fileExists(atPath: envPath) {
                // We'll log to stdout since Logger might not be fully configured yet (though it defaults to info)
                // But let's use a simple print for this startup phase just in case
                print("[INFO] Loading environment from \(envPath)")
                
                do {
                    let contents = try String(contentsOfFile: envPath)
                    let lines = contents.components(separatedBy: .newlines)
                    
                    for line in lines {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        // Skip comments and empty lines
                        if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
                        
                        // Simple parser for KEY=VALUE
                        let parts = trimmed.split(separator: "=", maxSplits: 1).map { String($0) }
                        if parts.count == 2 {
                            let key = parts[0].trimmingCharacters(in: .whitespaces)
                            var value = parts[1].trimmingCharacters(in: .whitespaces)
                            
                            // Remove quotes if present
                            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || 
                               (value.hasPrefix("'") && value.hasSuffix("'")) {
                                value = String(value.dropFirst().dropLast())
                            }
                            
                            // Set environment variable (overwrite if exists, to ensure .env takes precedence if loaded)
                            // However, standard modifying process environment in Swift is done via setenv
                            setenv(key, value, 1)
                        }
                    }
                } catch {
                    print("[WARNING] Failed to load .env: \(error)")
                }
            }
        }
    }
    
    static func printUsage() {
        print("""
        Copilot Audio Service - Real-time conversation copilot backend
        
        USAGE:
            copilot-audio-service [OPTIONS]
        
        OPTIONS:
            -h, --help      Show this help message
            -v, --version   Show version
        
        ENVIRONMENT VARIABLES:
            GOOGLE_APPLICATION_CREDENTIALS  Path to Google service account JSON (required)
            COPILOT_IPC_PORT               WebSocket port for Electron IPC (default: 9876)
            COPILOT_VIRTUAL_DEVICE         Virtual audio device UID (default: BlackHole2ch_UID)
            COPILOT_LOG_LEVEL              Log level: debug, info, warning, error (default: info)
        
        CONFIG FILE:
            ~/.copilot-audio-service/config.json
        
        EXAMPLE:
            GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json copilot-audio-service
        """)
    }
    
    static func setupSignalHandlers(service: CopilotAudioService) {
        // Handle SIGINT (Ctrl+C)
        signal(SIGINT) { _ in
            Logger.log("Received SIGINT, shutting down...", level: .info)
            exit(0)
        }
        
        // Handle SIGTERM
        signal(SIGTERM) { _ in
            Logger.log("Received SIGTERM, shutting down...", level: .info)
            exit(0)
        }
    }
}

// Top-level entry point
Main.main()
