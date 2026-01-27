import Foundation
import SwiftJWT
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Valid Google Service Account JSON structure
struct ServiceAccount: Codable {
    let type: String
    let project_id: String
    let private_key_id: String
    let private_key: String
    let client_email: String
    let client_id: String
    let auth_uri: String
    let token_uri: String
}

/// Token response from Google OAuth
struct TokenResponse: Codable {
    let access_token: String
    let expires_in: Int
    let token_type: String
}

/// Google JWT Claims
struct GoogleClaims: Claims {
    let iss: String
    let scope: String
    let aud: String
    let exp: Date
    let iat: Date
}

/// Manages fetching and refreshing OAuth2 tokens for Google Cloud
final class ServiceAccountTokenProvider: @unchecked Sendable {
    
    private let serviceAccount: ServiceAccount
    private var currentToken: String?
    private var tokenExpiration: Date?
    private let queue = DispatchQueue(label: "com.copilot.auth")
    
    /// The project ID from the service account JSON
    var projectId: String {
        return serviceAccount.project_id
    }
    
    init(credentialsPath: String) throws {
        let url = URL(fileURLWithPath: credentialsPath)
        let data = try Data(contentsOf: url)
        self.serviceAccount = try JSONDecoder().decode(ServiceAccount.self, from: data)
    }
    
    /// Returns a valid access token, refreshing if necessary
    func getAccessToken() async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                if let token = self.currentToken,
                   let expiration = self.tokenExpiration,
                   expiration > Date().addingTimeInterval(300) { // Buffer 5 mins
                    continuation.resume(returning: token)
                    return
                }
                
                do {
                    let token = try self.fetchNewToken()
                    self.currentToken = token
                    self.tokenExpiration = Date().addingTimeInterval(3600) // Usually 1 hour
                    continuation.resume(returning: token)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
    
    private func fetchNewToken() throws -> String {
        let now = Date()
        let exp = now.addingTimeInterval(3600)
        
        // 1. Create Claims
        let claims = GoogleClaims(
            iss: serviceAccount.client_email,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            aud: serviceAccount.token_uri,
            exp: exp,
            iat: now
        )
        
        // 2. Sign JWT
        var jwt = JWT(claims: claims)
        
        // Convert PEM private key to data (SwiftJWT handles PEM string parsing mostly, but sometimes needs help)
        // The Service Account private key usually comes with headers which SwiftJWT expects.
        guard let keyData = serviceAccount.private_key.data(using: .utf8) else {
            throw AuthError.invalidKeyEncoding
        }
        
        let signer = JWTSigner.rs256(privateKey: keyData)
        let signedJWT = try jwt.sign(using: signer)
        
        // 3. Exchange for Access Token
        return try exchangeJwtForAccessToken(signedJWT)
    }
    
    private func exchangeJwtForAccessToken(_ jwt: String) throws -> String {
        guard let url = URL(string: serviceAccount.token_uri) else {
            throw AuthError.invalidTokenURI
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        
        let bodyComponents = [
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": jwt
        ]
        
        let bodyString = bodyComponents.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        request.httpBody = bodyString.data(using: .utf8)
        
        let semaphore = DispatchSemaphore(value: 0)
        var resultToken: String?
        var resultError: Error?
        
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            
            if let error = error {
                resultError = error
                return
            }
            
            guard let data = data else {
                resultError = AuthError.noDataReceived
                return
            }
            
            do {
                if let jsonStr = String(data: data, encoding: .utf8), jsonStr.contains("error") {
                     resultError = AuthError.apiError(jsonStr)
                     return
                }
                
                let tokenResponse = try JSONDecoder().decode(TokenResponse.self, from: data)
                resultToken = tokenResponse.access_token
            } catch {
                resultError = error
            }
        }
        task.resume()
        
        semaphore.wait()
        
        if let error = resultError {
            throw error
        }
        
        guard let token = resultToken else {
            throw AuthError.unknownError
        }
        
        return token
    }
}

enum AuthError: Error {
    case invalidKeyEncoding
    case invalidTokenURI
    case noDataReceived
    case apiError(String)
    case unknownError
}
