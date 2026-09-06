import Foundation
import Security

struct PathwayPairingInput: Equatable, Sendable {
    let baseURL: URL
    let token: String

    init(address: String, token manualToken: String = "") throws {
        guard let input = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw PathwayConnectError.invalidURL
        }
        let fragment = URLComponents(string: "?" + (input.fragment ?? ""))?.queryItems ?? []
        let query = input.queryItems ?? []
        let host = query.first { $0.name == "host" }?.value
        if let host, URLComponents(string: host) == nil { throw PathwayConnectError.invalidURL }
        var endpoint = host.flatMap(URLComponents.init(string:)) ?? input
        let token = manualToken.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = token.isEmpty ? (fragment.first { $0.name == "token" }?.value ?? query.first { $0.name == "token" }?.value ?? "") : token
        guard !self.token.isEmpty else {
            throw PathwayConnectError.invalidConfiguration("Paste a pairing link or enter the server's pairing token.")
        }
        endpoint.query = nil
        endpoint.fragment = nil
        // Pairing links may point at /pair; the environment API lives at its origin.
        endpoint.path = ""
        guard ["http", "https"].contains(endpoint.scheme?.lowercased() ?? ""),
              let hostname = endpoint.host, !hostname.isEmpty,
              endpoint.user == nil, endpoint.password == nil,
              let url = endpoint.url else { throw PathwayConnectError.invalidURL }
        baseURL = url
    }
}

struct PathwayDirectConnectionSummary: Identifiable, Equatable, Sendable {
    let environmentID: String
    let label: String
    let baseURL: URL
    let expiresAt: Date
    let scopes: Set<String>
    let useForConnections: Bool
    var id: String { environmentID }
    var canManageLink: Bool { scopes.contains("relay:write") }
}

private struct PathwayStoredDirectConnection: Codable, Sendable {
    let environmentID: String
    let label: String
    let baseURL: URL
    let accessToken: String
    let expiresAt: Date
    let thumbprint: String
    let scopes: Set<String>
    var useForConnections: Bool
    var summary: PathwayDirectConnectionSummary {
        .init(environmentID: environmentID, label: label, baseURL: baseURL, expiresAt: expiresAt, scopes: scopes, useForConnections: useForConnections)
    }
}

// Pairing tokens and source session credentials must never follow HTTP redirects.
private final class PathwayDirectRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Only account-scoped credentials and explicit direct overrides are stored here. Environment and
/// project discovery remains authoritative in Convex; this is not a second environment catalog.
actor PathwayDirectConnections {
    static let shared = PathwayDirectConnections()
    private let signer: PathwayDPoPSigner
    private let session: URLSession
    private let service = "com.spiritdevs.pathway.direct-connections"

    init(signer: PathwayDPoPSigner = PathwayDPoPSigner(), session: URLSession? = nil) {
        self.signer = signer
        self.session = session ?? URLSession(configuration: .ephemeral, delegate: PathwayDirectRedirectPolicy(), delegateQueue: nil)
    }

    func saved(accountKey: String) throws -> [PathwayDirectConnectionSummary] {
        try read(accountKey).map(\.summary).sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    func forget(environmentID: String, accountKey: String) throws {
        try write(try read(accountKey).filter { $0.environmentID != environmentID }, accountKey: accountKey)
    }

    func setUseForConnections(_ enabled: Bool, environmentID: String, accountKey: String) throws {
        var records = try read(accountKey)
        guard let index = records.firstIndex(where: { $0.environmentID == environmentID }) else { return }
        records[index].useForConnections = enabled
        try write(records, accountKey: accountKey)
    }

    func pair(input: PathwayPairingInput, accountKey: String) async throws -> PathwayDirectConnectionSummary {
        guard !accountKey.isEmpty else { throw PathwayConnectError.invalidConfiguration("Sign in before pairing a server.") }
        let descriptor = try await send(URLRequest(url: input.baseURL.appendingPathComponent(".well-known/pathway/environment")))
        guard let fields = descriptor.objectValue, fields["applicationId"]?.stringValue == "pathway",
              let id = fields["environmentId"]?.stringValue, let label = fields["label"]?.stringValue else {
            throw PathwayConnectError.environmentMismatch
        }
        let url = input.baseURL.appendingPathComponent("oauth/token")
        let proof = try await signer.proof(method: "POST", url: url)
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "urn:ietf:params:oauth:grant-type:token-exchange"),
            URLQueryItem(name: "subject_token", value: input.token),
            URLQueryItem(name: "subject_token_type", value: "urn:pathway:params:oauth:token-type:environment-bootstrap"),
            URLQueryItem(name: "requested_token_type", value: "urn:ietf:params:oauth:token-type:access_token"),
            URLQueryItem(name: "client_label", value: "Pathway mobile"),
            URLQueryItem(name: "client_device_type", value: "mobile")
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response = try await send(request).objectValue
        guard response?["token_type"]?.stringValue == "DPoP",
              let token = response?["access_token"]?.stringValue,
              let lifetime = response?["expires_in"]?.intValue, lifetime > 0,
              let scope = response?["scope"]?.stringValue else { throw PathwayConnectError.invalidResponse }
        let scopes = Set(scope.split(separator: " ").map(String.init))
        guard scopes.contains("orchestration:read"), scopes.contains("relay:read") else { throw PathwayConnectError.scopeMismatch }
        let connection = PathwayStoredDirectConnection(environmentID: id, label: label, baseURL: input.baseURL,
            accessToken: token, expiresAt: Date().addingTimeInterval(Double(lifetime)), thumbprint: proof.thumbprint, scopes: scopes, useForConnections: true)
        var saved = try read(accountKey).filter { $0.environmentID != id }
        saved.append(connection)
        try write(saved, accountKey: accountKey)
        return connection.summary
    }

    func prepare(environmentID: String, accountKey: String, requirePreferred: Bool = true) async throws -> PathwayPreparedEnvironmentConnection? {
        guard let connection = try read(accountKey).first(where: { $0.environmentID == environmentID && (!requirePreferred || $0.useForConnections) }) else { return nil }
        try validate(connection)
        let descriptor = try await send(URLRequest(url: connection.baseURL.appendingPathComponent(".well-known/pathway/environment")))
        guard descriptor.objectValue?["environmentId"]?.stringValue == environmentID,
              descriptor.objectValue?["applicationId"]?.stringValue == "pathway" else { throw PathwayConnectError.environmentMismatch }
        let ticket = try await authenticated(connection, method: "POST", path: "/api/auth/websocket-ticket", payload: .object([:]))
        guard let value = ticket.objectValue?["ticket"]?.stringValue else { throw PathwayConnectError.invalidResponse }
        guard var socket = URLComponents(url: connection.baseURL, resolvingAgainstBaseURL: false) else { throw PathwayConnectError.invalidURL }
        socket.scheme = connection.baseURL.scheme == "https" ? "wss" : "ws"
        socket.path = "/ws"
        socket.queryItems = [URLQueryItem(name: "wsTicket", value: value)]
        guard let socketURL = socket.url else { throw PathwayConnectError.invalidURL }
        return .init(environmentID: environmentID, label: connection.label, httpBaseURL: connection.baseURL,
            webSocketURL: socketURL, accessToken: connection.accessToken, proofKeyThumbprint: connection.thumbprint)
    }

    func request(environmentID: String, accountKey: String, method: String, path: String, payload: JSONValue? = nil) async throws -> JSONValue {
        guard let connection = try read(accountKey).first(where: { $0.environmentID == environmentID }) else {
            throw PathwayConnectError.invalidConfiguration("Pair this device with the server first.")
        }
        return try await authenticated(connection, method: method, path: path, payload: payload)
    }

    private func authenticated(_ connection: PathwayStoredDirectConnection, method: String, path: String, payload: JSONValue?) async throws -> JSONValue {
        try validate(connection)
        guard let url = URL(string: path, relativeTo: connection.baseURL)?.absoluteURL,
              url.scheme == connection.baseURL.scheme, url.host == connection.baseURL.host,
              url.port == connection.baseURL.port, url.user == nil, url.password == nil else { throw PathwayConnectError.invalidURL }
        let proof = try await signer.proof(method: method, url: url, accessToken: connection.accessToken)
        guard proof.thumbprint == connection.thumbprint else { throw PathwayConnectError.invalidProofKey }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("DPoP \(connection.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        if let payload {
            request.httpBody = try JSONEncoder().encode(payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request)
    }

    private func validate(_ connection: PathwayStoredDirectConnection) throws {
        guard connection.expiresAt > Date().addingTimeInterval(5) else {
            throw PathwayConnectError.invalidConfiguration("This server session expired. Pair again using a new pairing link.")
        }
    }

    private func send(_ input: URLRequest) async throws -> JSONValue {
        var request = input
        request.timeoutInterval = 20
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PathwayConnectError.invalidResponse }
        guard (200 ..< 300).contains(response.statusCode) else {
            let body = try? JSONDecoder().decode(JSONValue.self, from: data).objectValue
            throw PathwayConnectError.response(status: response.statusCode,
                message: body?["message"]?.stringValue ?? body?["reason"]?.stringValue ?? "The server request failed.",
                traceID: body?["traceId"]?.stringValue)
        }
        return data.isEmpty ? .null : try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func read(_ accountKey: String) throws -> [PathwayStoredDirectConnection] {
        guard !accountKey.isEmpty else { return [] }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: accountKey, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw PathwayConnectError.keychain(status) }
        return try JSONDecoder().decode([PathwayStoredDirectConnection].self, from: data)
    }

    private func write(_ connections: [PathwayStoredDirectConnection], accountKey: String) throws {
        guard !accountKey.isEmpty else { throw PathwayConnectError.invalidConfiguration("Sign in before saving a connection.") }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: accountKey]
        let data = try JSONEncoder().encode(connections)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PathwayConnectError.keychain(status) }
    }
}

extension PathwayDirectConnections {
    /// Uses the server's verified installer and waits for its completion receipt.
    func ensureManagedRelay(environmentID: String, accountKey: String) async throws {
        let rpc = PathwayRPCClient { [self] in
            guard let connection = try await prepare(environmentID: environmentID, accountKey: accountKey, requirePreferred: false) else {
                throw PathwayConnectError.invalidConfiguration("Pair this server first.")
            }
            return connection.webSocketURL
        }
        do {
            let status = try await rpc.request("cloud.getRelayClientStatus", payload: .object([:]))
            if status.objectValue?["status"]?.stringValue == "available" {
                await rpc.stop()
                return
            }
            if status.objectValue?["status"]?.stringValue == "unsupported" {
                throw PathwayConnectError.invalidConfiguration("This server platform cannot install the Pathway Connect tunnel. Use direct access.")
            }
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    for try await event in await rpc.subscribe("cloud.installRelayClient", payload: .object([:])) {
                        if event.objectValue?["type"]?.stringValue == "complete" {
                            guard event.objectValue?["status"]?.objectValue?["status"]?.stringValue == "available" else {
                                throw PathwayConnectError.invalidConfiguration("The relay client installation did not become available.")
                            }
                            return
                        }
                    }
                    throw PathwayConnectError.invalidResponse
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(180))
                    throw PathwayConnectError.invalidConfiguration("The relay client installation timed out. Retry to check its status.")
                }
                defer { group.cancelAll() }
                _ = try await group.next()
            }
            await rpc.stop()
        } catch {
            await rpc.stop()
            throw error
        }
    }
}
