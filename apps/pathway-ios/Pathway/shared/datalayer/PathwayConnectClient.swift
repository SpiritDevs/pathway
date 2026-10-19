import Foundation
import Security

// The actor deliberately keeps the two-hop authorization flow together so relay and
// environment credentials cannot be mixed across independently mutable services.
// swiftlint:disable file_length

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

/// How a connection attempt failed, so reconnect loops stop retrying input that cannot change.
enum PathwayConnectFailure: Equatable {
    /// Network, timeout, server startup, or a temporary relay outage.
    case transient
    /// The environment or relay rejected a credential. Worth one fresh authorization.
    case unauthorized
    /// Invalid configuration or endpoint, a different environment, refused scopes or proof, or
    /// expired pairing. Retrying unchanged input cannot repair it.
    case permanent

    init(_ error: Error) {
        guard let error = error as? PathwayConnectError else { self = .transient; return }
        switch error {
        case .invalidConfiguration, .invalidURL, .invalidProofKey, .scopeMismatch, .environmentMismatch:
            self = .permanent
        case let .response(status, _, _) where status == 401:
            self = .unauthorized
        case let .response(status, _, _) where status == 403:
            self = .permanent
        case .invalidResponse, .keychain, .response:
            self = .transient
        }
    }
}

/// A validated environment session. Each socket still needs its own one-use ticket from it.
struct PathwayEnvironmentAuthorization: Sendable {
    let environmentID: String
    let label: String
    let httpBaseURL: URL
    let webSocketBaseURL: URL
    let accessToken: String
    let proofKeyThumbprint: String
    let scopes: Set<String>
    let expiresAt: Date
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
    let scopes: Set<String>
    /// When the `wsTicket` in `webSocketURL` expires, as the environment reported it.
    var ticketExpiresAt: Date?

    func threadOperationWebSocketURL() throws -> URL {
        guard scopes.contains("orchestration:operate") else { throw PathwayConnectError.scopeMismatch }
        return webSocketURL
    }
}

extension PathwayPreparedEnvironmentConnection {
    /// `authorization`'s socket URL carrying `ticket`.
    init(_ authorization: PathwayEnvironmentAuthorization, ticket: String, expiresAt: Date?) throws {
        guard var components = URLComponents(url: authorization.webSocketBaseURL, resolvingAgainstBaseURL: false) else {
            throw PathwayConnectError.invalidURL
        }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket))
        components.queryItems = queryItems
        guard let socketURL = components.url else { throw PathwayConnectError.invalidURL }
        self.init(environmentID: authorization.environmentID, label: authorization.label, httpBaseURL: authorization.httpBaseURL,
                  webSocketURL: socketURL, accessToken: authorization.accessToken, proofKeyThumbprint: authorization.proofKeyThumbprint,
                  scopes: authorization.scopes, ticketExpiresAt: expiresAt)
    }
}

private struct PathwayRelayAccessToken: Decodable, Sendable {
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

private struct PathwayCachedRelayToken: Sendable {
    let accessToken: String
    let expiresAt: Date
    let clerkSubject: String
    let thumbprint: String
}

private struct PathwayRelayConnectRequest: Encodable, Sendable {
    let clientProofKeyThumbprint: String
}

private struct PathwayRelayConnectResponse: Decodable, Sendable {
    let environmentId: String
    let endpoint: PathwayManagedEndpoint
    let credential: String
    let expiresAt: String
}

private struct PathwayRemoteEnvironmentDescriptor: Decodable, Sendable {
    let environmentId: String
    let applicationId: String?
    let label: String
    let capabilities: [String: JSONValue]?
}

private struct PathwayWebSocketTicket: Decodable, Sendable {
    let ticket: String
    let expiresAt: String?
}

private struct PathwayConnectErrorBody: Decodable, Sendable {
    let message: String?
    let reason: String?
    let code: String?
    let traceId: String?
}

actor PathwayConnectClient {
    typealias ClerkTokenProvider = @MainActor @Sendable () async throws -> String

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

    /// The scopes to request. `computer:operate` is named only to a server that advertises
    /// it; older servers refuse the whole request when it appears.
    static func environmentScopes(computerOperateScope: Bool) -> [String] {
        standardEnvironmentScopes + (computerOperateScope ? ["computer:operate"] : [])
    }

    /// A grant may leave out Computer; every standard scope must be there and nothing unasked.
    static func acceptsGrantedScopes(_ granted: String, requested: [String]) -> Bool {
        let granted = Set(granted.split(separator: " ").map(String.init))
        return granted.isSubset(of: requested) && Set(standardEnvironmentScopes).isSubset(of: granted)
    }

    private let relayURL: URL
    private let clerkTokenProvider: ClerkTokenProvider
    private let signer: PathwayDPoPSigner
    private let session: URLSession
    private var relayTokens: [String: PathwayCachedRelayToken] = [:]
    private var authorizations: [String: PathwayEnvironmentAuthorization] = [:]
    private var pendingAuthorizations: [String: Task<PathwayEnvironmentAuthorization, Error>] = [:]
    private var authorizationGeneration = 0

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

    /// A socket-ready connection with a fresh one-use ticket. The environment session behind it is
    /// reused until it expires, so a reconnect costs one ticket request.
    func prepare(environment: PathwayCompanyEnvironment) async throws -> PathwayPreparedEnvironmentConnection {
        let clerkToken = try await clerkTokenProvider()
        if let accountKey = PathwayAccountStorage.identity(fromToken: clerkToken),
           let direct = try await PathwayDirectConnections.shared.prepare(environmentID: environment.environment.environmentId, accountKey: accountKey) {
            return direct
        }
        let (authorization, reused) = try await relayAuthorization(environment: environment, clerkToken: clerkToken)
        do {
            return try await ticketed(authorization)
        } catch let error where reused && !(error is CancellationError) {
            // A revoked session or moved endpoint fails here; authorize once from scratch.
            invalidate(authorization, clerkToken: clerkToken)
            let (fresh, _) = try await relayAuthorization(environment: environment, clerkToken: clerkToken)
            return try await ticketed(fresh)
        }
    }

    /// The environment session alone, for signed HTTP and asset URLs. Never mints a socket ticket.
    func authorize(environment: PathwayCompanyEnvironment) async throws -> PathwayEnvironmentAuthorization {
        let clerkToken = try await clerkTokenProvider()
        if let accountKey = PathwayAccountStorage.identity(fromToken: clerkToken),
           let direct = try await PathwayDirectConnections.shared.authorization(environmentID: environment.environment.environmentId, accountKey: accountKey) {
            return direct
        }
        return try await relayAuthorization(environment: environment, clerkToken: clerkToken).0
    }

    /// Forgets a session the environment rejected, so the next connection authorizes again.
    func invalidateAuthorization(environment: PathwayCompanyEnvironment) {
        authorizations = authorizations.filter { !$0.key.hasSuffix("\n\(environment.environment.environmentId)") }
    }


    /// A fresh `wsTicket` minted with `connection`'s access token, so the socket it opens belongs to the
    /// same authenticated environment session. Every `prepare` through Pathway Connect opens a new session.
    func refreshingTicket(_ connection: PathwayPreparedEnvironmentConnection) async throws -> PathwayPreparedEnvironmentConnection {
        let target = endpoint(connection.httpBaseURL, path: ["api", "auth", "websocket-ticket"])
        let proof = try await signer.proof(method: "POST", url: target, accessToken: connection.accessToken)
        guard proof.thumbprint == connection.proofKeyThumbprint else { throw PathwayConnectError.invalidProofKey }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("DPoP \(connection.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let ticket: PathwayWebSocketTicket = try await send(request, as: PathwayWebSocketTicket.self)
        guard var components = URLComponents(url: connection.webSocketURL, resolvingAgainstBaseURL: false) else {
            throw PathwayConnectError.invalidURL
        }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        components.queryItems = queryItems
        guard let socketURL = components.url else { throw PathwayConnectError.invalidURL }
        return PathwayPreparedEnvironmentConnection(
            environmentID: connection.environmentID, label: connection.label, httpBaseURL: connection.httpBaseURL,
            webSocketURL: socketURL, accessToken: connection.accessToken, proofKeyThumbprint: connection.proofKeyThumbprint,
            scopes: connection.scopes, ticketExpiresAt: ticket.expiresAt.flatMap(pathwayDate(from:))
        )
    }

    func authenticatedRequest(environment: PathwayCompanyEnvironment, method: String, path: String) async throws -> URLRequest {
        let connection = try await authorize(environment: environment)
        guard let url = URL(string: path, relativeTo: connection.httpBaseURL)?.absoluteURL,
              url.scheme == connection.httpBaseURL.scheme,
              url.host == connection.httpBaseURL.host,
              url.port == connection.httpBaseURL.port,
              url.user == nil, url.password == nil else { throw URLError(.badURL) }
        let proof = try await signer.proof(method: method, url: url, accessToken: connection.accessToken)
        guard proof.thumbprint == connection.proofKeyThumbprint else { throw PathwayConnectError.invalidProofKey }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("DPoP \(connection.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        return request
    }

    func clearTokenCache() {
        relayTokens = [:]
        clearEnvironmentAuthorizations()
    }

    /// Drops every environment session, including ones still being authorized. Relay tokens stay
    /// so sign-out can still unregister this device.
    func clearEnvironmentAuthorizations() {
        authorizations = [:]
        authorizationGeneration += 1
        pendingAuthorizations.values.forEach { $0.cancel() }
        pendingAuthorizations = [:]
    }

    func relayRequest(method: String, path: String, payload: JSONValue? = nil) async throws -> JSONValue {
        let clerkToken = try await clerkTokenProvider()
        let thumbprint = try await signer.thumbprint()
        let token = try await relayAccessToken(clerkToken: clerkToken, thumbprint: thumbprint, scopes: "mobile:registration")
        guard let url = URL(string: path, relativeTo: relayURL)?.absoluteURL,
              url.scheme == relayURL.scheme, url.host == relayURL.host, url.port == relayURL.port,
              url.user == nil, url.password == nil else { throw URLError(.badURL) }
        let proof = try await signer.proof(method: method, url: url, accessToken: token)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("DPoP \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        if let payload {
            request.httpBody = try JSONEncoder().encode(payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request, as: JSONValue.self)
    }

    func relayAccountRequest(method: String, path: String, payload: JSONValue? = nil) async throws -> JSONValue {
        let token = try await clerkTokenProvider()
        guard let url = URL(string: path, relativeTo: relayURL)?.absoluteURL,
              url.scheme == relayURL.scheme, url.host == relayURL.host, url.port == relayURL.port,
              url.user == nil, url.password == nil else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let payload {
            request.httpBody = try JSONEncoder().encode(payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request, as: JSONValue.self)
    }
}

private extension PathwayConnectClient {
    private func authorizationKey(clerkToken: String, environmentID: String) -> String {
        let subject = PathwayAccountStorage.identity(fromToken: clerkToken) ?? PathwayDPoPSigner.accessTokenHash(clerkToken)
        return "\(subject)\n\(environmentID)"
    }

    /// Reuses this account's valid session for the environment and joins one already being authorized.
    private func relayAuthorization(
        environment: PathwayCompanyEnvironment,
        clerkToken: String
    ) async throws -> (PathwayEnvironmentAuthorization, reused: Bool) {
        let key = authorizationKey(clerkToken: clerkToken, environmentID: environment.environment.environmentId)
        let thumbprint = try await signer.thumbprint()
        if let cached = authorizations[key] {
            if cached.proofKeyThumbprint == thumbprint, cached.expiresAt.timeIntervalSinceNow > 60 { return (cached, true) }
            authorizations.removeValue(forKey: key)
        }
        if let pending = pendingAuthorizations[key] { return (try await pending.value, false) }
        let generation = authorizationGeneration
        let task = Task {
            try await authorizeRelay(environment: environment, clerkToken: clerkToken, thumbprint: thumbprint)
        }
        pendingAuthorizations[key] = task
        defer { if generation == authorizationGeneration { pendingAuthorizations.removeValue(forKey: key) } }
        let authorization = try await task.value
        // Sign-out during authorization must not leave the old account's session behind.
        guard generation == authorizationGeneration else { throw CancellationError() }
        authorizations[key] = authorization
        return (authorization, false)
    }

    private func invalidate(_ authorization: PathwayEnvironmentAuthorization, clerkToken: String) {
        let key = authorizationKey(clerkToken: clerkToken, environmentID: authorization.environmentID)
        if authorizations[key]?.accessToken == authorization.accessToken { authorizations.removeValue(forKey: key) }
    }

    private func authorizeRelay(
        environment: PathwayCompanyEnvironment,
        clerkToken: String,
        thumbprint: String
    ) async throws -> PathwayEnvironmentAuthorization {
        let relayAccessToken = try await relayAccessToken(
            clerkToken: clerkToken,
            thumbprint: thumbprint
        )
        let bootstrap: PathwayRelayConnectResponse
        do {
            bootstrap = try await connectRelay(
                environment: environment,
                relayAccessToken: relayAccessToken,
                thumbprint: thumbprint
            )
        } catch let PathwayConnectError.response(status, message, traceID) where status == 401 {
            // The cached relay token was revoked; the next attempt exchanges a fresh one.
            relayTokens = [:]
            throw PathwayConnectError.response(status: status, message: message, traceID: traceID)
        }
        guard let httpBaseURL = bootstrap.endpoint.httpBaseURL else {
            throw PathwayConnectError.invalidConfiguration(
                "The environment's Pathway Connect URL is invalid."
            )
        }
        let descriptor: PathwayRemoteEnvironmentDescriptor = try await send(
            request(url: endpoint(httpBaseURL, path: [".well-known", "pathway", "environment"])),
            as: PathwayRemoteEnvironmentDescriptor.self
        )
        guard descriptor.environmentId == environment.environment.environmentId,
              descriptor.applicationId == "pathway"
        else {
            throw PathwayConnectError.environmentMismatch
        }
        let socketBaseURL = try secureWebSocketBaseURL(bootstrap.endpoint)
        let accessToken = try await exchangeEnvironmentToken(
            bootstrapCredential: bootstrap.credential,
            endpoint: bootstrap.endpoint,
            thumbprint: thumbprint,
            scopes: Self.environmentScopes(computerOperateScope: descriptor.capabilities?["computerOperateScope"]?.boolValue == true)
        )
        return PathwayEnvironmentAuthorization(
            environmentID: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: httpBaseURL,
            webSocketBaseURL: socketBaseURL,
            accessToken: accessToken.accessToken,
            proofKeyThumbprint: thumbprint,
            scopes: Set(accessToken.scope.split(separator: " ").map(String.init)),
            expiresAt: Date().addingTimeInterval(accessToken.expiresIn.isFinite ? accessToken.expiresIn : 0)
        )
    }

    /// Mints the one-use ticket a new socket presents.
    private func ticketed(_ authorization: PathwayEnvironmentAuthorization) async throws -> PathwayPreparedEnvironmentConnection {
        let target = endpoint(authorization.httpBaseURL, path: ["api", "auth", "websocket-ticket"])
        let proof = try await signer.proof(method: "POST", url: target, accessToken: authorization.accessToken)
        guard proof.thumbprint == authorization.proofKeyThumbprint else { throw PathwayConnectError.invalidProofKey }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.setValue("DPoP \(authorization.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let ticket: PathwayWebSocketTicket = try await send(request, as: PathwayWebSocketTicket.self)
        return try PathwayPreparedEnvironmentConnection(authorization, ticket: ticket.ticket,
                                                        expiresAt: ticket.expiresAt.flatMap(pathwayDate(from:)))
    }

    private func relayAccessToken(
        clerkToken: String,
        thumbprint: String,
        scopes: String = "environment:connect"
    ) async throws -> String {
        let subject = PathwayAccountStorage.identity(fromToken: clerkToken) ?? PathwayDPoPSigner.accessTokenHash(clerkToken)
        // swiftlint:disable opening_brace
        if let relayToken = relayTokens[scopes],
           relayToken.clerkSubject == subject,
           relayToken.thumbprint == thumbprint,
           relayToken.expiresAt.timeIntervalSinceNow > 5
        {
            return relayToken.accessToken
        }
        // swiftlint:enable opening_brace

        let target = relayEndpoint(["v1", "client", "dpop-token"])
        let proof = try await signer.proof(method: "POST", url: target)
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
        let response: PathwayRelayAccessToken = try await send(
            request,
            as: PathwayRelayAccessToken.self
        )
        guard response.issuedTokenType == Self.accessTokenType,
              response.tokenType == "DPoP",
              response.scope == scopes,
              response.expiresIn.isFinite,
              response.expiresIn > 0,
              !response.accessToken.isEmpty
        else {
            throw PathwayConnectError.scopeMismatch
        }
        relayTokens[scopes] = PathwayCachedRelayToken(
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
    ) async throws -> PathwayRelayConnectResponse {
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
            PathwayRelayConnectRequest(clientProofKeyThumbprint: thumbprint)
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("DPoP \(relayAccessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response: PathwayRelayConnectResponse = try await send(
            request,
            as: PathwayRelayConnectResponse.self
        )
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
        thumbprint: String,
        scopes requestedScopes: [String]
    ) async throws -> PathwayRelayAccessToken {
        guard let httpBaseURL = managedEndpoint.httpBaseURL else {
            throw PathwayConnectError.invalidURL
        }
        let target = endpoint(httpBaseURL, path: ["oauth", "token"])
        let proof = try await signer.proof(method: "POST", url: target)
        let scopes = requestedScopes.joined(separator: " ")
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
        let response: PathwayRelayAccessToken = try await send(
            request,
            as: PathwayRelayAccessToken.self
        )
        guard response.issuedTokenType == Self.accessTokenType,
              response.tokenType == "DPoP",
              Self.acceptsGrantedScopes(response.scope, requested: requestedScopes),
              !response.accessToken.isEmpty,
              thumbprint == proof.thumbprint
        else {
            throw PathwayConnectError.scopeMismatch
        }
        return response
    }

    private func secureWebSocketBaseURL(_ managedEndpoint: PathwayManagedEndpoint) throws -> URL {
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
        var components = URLComponents(url: socketBaseURL, resolvingAgainstBaseURL: false)
        if components?.path.isEmpty == true || components?.path == "/" {
            components?.path = "/ws"
        }
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
            let body = try? JSONDecoder().decode(PathwayConnectErrorBody.self, from: data)
            throw PathwayConnectError.response(
                status: httpResponse.statusCode,
                message: body?.message ?? body?.reason ?? body?.code ?? "Pathway Connect failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder().decode(type, from: data.isEmpty ? Data("null".utf8) : data)
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

private extension JSONEncoder {
    static let pathway: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
