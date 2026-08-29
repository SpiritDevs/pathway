import Foundation
import Security

enum PathwayConnectError: LocalizedError, Sendable {
    case invalidConfiguration(String)
    case invalidProofKey
    case invalidResponse
    case invalidURL
    case keychain(OSStatus)
    case response(status: Int, message: String, traceID: String?)
    case scopeMismatch
    case environmentMismatch

    var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message): message
        case .invalidProofKey: "Pathway could not load this device's secure connection identity."
        case .invalidResponse: "Pathway Connect returned an invalid response."
        case .invalidURL: "The Pathway Connect endpoint is invalid."
        case let .keychain(status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)."
        case let .response(status, message, traceID):
            traceID.map { "\(message) (trace \($0))" } ?? "\(message) (HTTP \(status))"
        case .scopeMismatch: "Pathway Connect did not grant the requested permissions."
        case .environmentMismatch: "Pathway Connect returned a different environment."
        }
    }
}

struct PathwayManagedEndpoint: Codable, Equatable, Sendable {
    let httpBaseUrl: String
    let wsBaseUrl: String
    let providerKind: String

    var httpBaseURL: URL? { URL(string: httpBaseUrl) }
    var webSocketBaseURL: URL? { URL(string: wsBaseUrl) }
}

struct PathwayPreparedEnvironmentConnection: Sendable {
    let environmentID: String
    let label: String
    let httpBaseURL: URL
    let webSocketURL: URL
    let accessToken: String
    let proofKeyThumbprint: String
}

actor PathwayConnectClient {
    typealias ClerkTokenProvider = @MainActor @Sendable () async throws -> String

    private struct RelayAccessToken: Decodable, Sendable {
        let accessToken: String
        let issuedTokenType: String
        let tokenType: String
        let expiresIn: Double
        let scope: String

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case issuedTokenType = "issued_token_type"
            case tokenType = "token_type"
            case expiresIn = "expires_in"
            case scope
        }
    }

    private struct CachedRelayToken: Sendable {
        let accessToken: String
        let expiresAt: Date
        let clerkSubject: String
        let thumbprint: String
    }

    private struct RelayConnectRequest: Encodable, Sendable {
        let clientProofKeyThumbprint: String
    }

    private struct RelayConnectResponse: Decodable, Sendable {
        let environmentId: String
        let endpoint: PathwayManagedEndpoint
        let credential: String
        let expiresAt: String
    }

    private struct EnvironmentDescriptor: Decodable, Sendable {
        let environmentId: String
        let applicationId: String?
        let label: String
    }

    private struct WebSocketTicket: Decodable, Sendable {
        let ticket: String
    }

    private struct ErrorBody: Decodable, Sendable {
        let message: String?
        let reason: String?
        let code: String?
        let traceId: String?
    }

    private static let tokenExchangeGrant = "urn:ietf:params:oauth:grant-type:token-exchange"
    private static let accessTokenType = "urn:ietf:params:oauth:token-type:access_token"
    private static let relaySubjectTokenType = "urn:ietf:params:oauth:token-type:jwt"
    private static let environmentBootstrapType =
        "urn:pathway:params:oauth:token-type:environment-bootstrap"
    private static let standardEnvironmentScopes = [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read"
    ]

    private let relayURL: URL
    private let clerkTokenProvider: ClerkTokenProvider
    private let signer: PathwayDPoPSigner
    private let session: URLSession
    private var relayToken: CachedRelayToken?

    init(
        relayURL: URL,
        clerkTokenProvider: @escaping ClerkTokenProvider,
        signer: PathwayDPoPSigner = PathwayDPoPSigner(),
        session: URLSession = .shared
    ) {
        self.relayURL = relayURL
        self.clerkTokenProvider = clerkTokenProvider
        self.signer = signer
        self.session = session
    }

    func prepare(environment: PathwayCompanyEnvironment) async throws
        -> PathwayPreparedEnvironmentConnection
    {
        let clerkToken = try await clerkTokenProvider()
        let thumbprint = try await signer.thumbprint()
        let relayAccessToken = try await relayAccessToken(
            clerkToken: clerkToken,
            thumbprint: thumbprint
        )
        let bootstrap = try await connectRelay(
            environment: environment,
            relayAccessToken: relayAccessToken,
            thumbprint: thumbprint
        )
        guard let httpBaseURL = bootstrap.endpoint.httpBaseURL else {
            throw PathwayConnectError.invalidConfiguration(
                "The environment's Pathway Connect URL is invalid."
            )
        }
        let descriptor: EnvironmentDescriptor = try await send(
            request(url: endpoint(httpBaseURL, path: [".well-known", "pathway", "environment"])),
            as: EnvironmentDescriptor.self
        )
        guard descriptor.environmentId == environment.environment.environmentId,
              descriptor.applicationId == "pathway"
        else {
            throw PathwayConnectError.environmentMismatch
        }

        let accessToken = try await exchangeEnvironmentToken(
            bootstrapCredential: bootstrap.credential,
            endpoint: bootstrap.endpoint,
            thumbprint: thumbprint
        )
        let socketURL = try await webSocketURL(
            endpoint: bootstrap.endpoint,
            accessToken: accessToken.accessToken,
            thumbprint: thumbprint
        )
        return PathwayPreparedEnvironmentConnection(
            environmentID: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: httpBaseURL,
            webSocketURL: socketURL,
            accessToken: accessToken.accessToken,
            proofKeyThumbprint: thumbprint
        )
    }

    func clearTokenCache() {
        relayToken = nil
    }

    private func relayAccessToken(
        clerkToken: String,
        thumbprint: String
    ) async throws -> String {
        let subject = clerkSubject(clerkToken) ?? PathwayDPoPSigner.accessTokenHash(clerkToken)
        if let relayToken,
           relayToken.clerkSubject == subject,
           relayToken.thumbprint == thumbprint,
           relayToken.expiresAt.timeIntervalSinceNow > 5
        {
            return relayToken.accessToken
        }

        let target = relayEndpoint(["v1", "client", "dpop-token"])
        let proof = try await signer.proof(method: "POST", url: target)
        let scopes = "environment:connect"
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = formEncoded([
            "grant_type": Self.tokenExchangeGrant,
            "subject_token": clerkToken,
            "subject_token_type": Self.relaySubjectTokenType,
            "requested_token_type": Self.accessTokenType,
            "resource": relayOrigin.absoluteString,
            "scope": scopes,
            "client_id": "pathway-mobile"
        ])
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response: RelayAccessToken = try await send(request, as: RelayAccessToken.self)
        guard response.issuedTokenType == Self.accessTokenType,
              response.tokenType == "DPoP",
              response.scope == scopes,
              response.expiresIn.isFinite,
              response.expiresIn > 0,
              !response.accessToken.isEmpty
        else {
            throw PathwayConnectError.scopeMismatch
        }
        relayToken = CachedRelayToken(
            accessToken: response.accessToken,
            expiresAt: Date().addingTimeInterval(response.expiresIn),
            clerkSubject: subject,
            thumbprint: thumbprint
        )
        return response.accessToken
    }

    private func connectRelay(
        environment: PathwayCompanyEnvironment,
        relayAccessToken: String,
        thumbprint: String
    ) async throws -> RelayConnectResponse {
        let target = relayEndpoint([
            "v1", "environments", environment.environment.environmentId, "connect"
        ])
        let proof = try await signer.proof(
            method: "POST",
            url: target,
            accessToken: relayAccessToken
        )
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder.pathway.encode(
            RelayConnectRequest(clientProofKeyThumbprint: thumbprint)
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("DPoP \(relayAccessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response: RelayConnectResponse = try await send(request, as: RelayConnectResponse.self)
        guard response.environmentId == environment.environment.environmentId,
              !response.credential.isEmpty,
              !response.expiresAt.isEmpty
        else {
            throw PathwayConnectError.environmentMismatch
        }
        return response
    }

    private func exchangeEnvironmentToken(
        bootstrapCredential: String,
        endpoint managedEndpoint: PathwayManagedEndpoint,
        thumbprint: String
    ) async throws -> RelayAccessToken {
        guard let httpBaseURL = managedEndpoint.httpBaseURL else {
            throw PathwayConnectError.invalidURL
        }
        let target = endpoint(httpBaseURL, path: ["oauth", "token"])
        let proof = try await signer.proof(method: "POST", url: target)
        let scopes = Self.standardEnvironmentScopes.joined(separator: " ")
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = formEncoded([
            "grant_type": Self.tokenExchangeGrant,
            "subject_token": bootstrapCredential,
            "subject_token_type": Self.environmentBootstrapType,
            "requested_token_type": Self.accessTokenType,
            "scope": scopes,
            "client_label": "Pathway Mobile",
            "client_device_type": "mobile",
            "client_os": "iOS"
        ])
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response: RelayAccessToken = try await send(request, as: RelayAccessToken.self)
        guard response.issuedTokenType == Self.accessTokenType,
              response.tokenType == "DPoP",
              Set(response.scope.split(separator: " ").map(String.init))
              == Set(Self.standardEnvironmentScopes),
              !response.accessToken.isEmpty,
              thumbprint == proof.thumbprint
        else {
            throw PathwayConnectError.scopeMismatch
        }
        return response
    }

    private func webSocketURL(
        endpoint managedEndpoint: PathwayManagedEndpoint,
        accessToken: String,
        thumbprint: String
    ) async throws -> URL {
        guard
            let httpBaseURL = managedEndpoint.httpBaseURL,
            let socketBaseURL = managedEndpoint.webSocketBaseURL,
            httpBaseURL.scheme?.lowercased() == "https",
            socketBaseURL.scheme?.lowercased() == "wss",
            httpBaseURL.host?.caseInsensitiveCompare(socketBaseURL.host ?? "") == .orderedSame,
            (httpBaseURL.port ?? 443) == (socketBaseURL.port ?? 443)
        else {
            throw PathwayConnectError.invalidConfiguration(
                "The managed environment endpoint is not secure."
            )
        }
        let target = endpoint(httpBaseURL, path: ["api", "auth", "websocket-ticket"])
        let proof = try await signer.proof(method: "POST", url: target, accessToken: accessToken)
        guard proof.thumbprint == thumbprint else { throw PathwayConnectError.invalidProofKey }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let ticket: WebSocketTicket = try await send(request, as: WebSocketTicket.self)

        var components = URLComponents(url: socketBaseURL, resolvingAgainstBaseURL: false)
        if components?.path.isEmpty == true || components?.path == "/" {
            components?.path = "/ws"
        }
        var queryItems = components?.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        components?.queryItems = queryItems
        guard let result = components?.url else { throw PathwayConnectError.invalidURL }
        return result
    }

    private var relayOrigin: URL {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        return components?.url ?? relayURL
    }

    private func relayEndpoint(_ components: [String]) -> URL {
        components.reduce(relayOrigin) { $0.appendingPathComponent($1) }
    }

    private func endpoint(_ baseURL: URL, path: [String]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        let origin = components?.url ?? baseURL
        return path.reduce(origin) { $0.appendingPathComponent($1) }
    }

    private func request(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send<Response: Decodable & Sendable>(
        _ input: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        var request = input
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("gzip", forHTTPHeaderField: "Accept-Encoding")
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw PathwayConnectError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw PathwayConnectError.response(
                status: httpResponse.statusCode,
                message: body?.message ?? body?.reason ?? body?.code ?? "Pathway Connect failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw PathwayConnectError.invalidResponse
        }
    }

    private func formEncoded(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.keys.sorted().map {
            URLQueryItem(name: $0, value: fields[$0])
        }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }

    private func clerkSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var encoded = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard
            let data = Data(base64Encoded: encoded),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["sub"] as? String
    }
}

extension JSONEncoder {
    fileprivate static let pathway: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
