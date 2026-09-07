#if os(visionOS)
@preconcurrency import Combine
import Foundation

/// Uses Convex's published sync and HTTP protocols on visionOS, where ConvexMobile's
/// binary package has no supported slice. Environment RPC remains shared with iOS.
@MainActor
final class PathwayConvexClient {
    private struct Query {
        let owner: UUID
        let name: String
        let arguments: JSONValue
        let subject: CurrentValueSubject<JSONValue?, Error>
        var journal: JSONValue = .null
        var deadline: Task<Void, Never>?
    }

    private let deploymentURL: URL
    private let credentials: any PathwayAuthenticating
    private let session: URLSession
    private let sessionID = UUID().uuidString
    private var token: String?
    private var tokenExpiresAt: Date?
    private var queries: [Int: Query] = [:]
    private var nextQueryID = 0
    private var querySetVersion = 0
    private var identityVersion = 0
    private var wire = PathwayConvexSyncProtocol()
    private var socket: URLSessionWebSocketTask?
    private var socketID: UUID?
    private var socketToken: String?
    private var loopID: UUID?
    private var loopTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var lastMessageAt = Date()
    private var connectionCount = 0
    private var authFailures = 0
    private var desired = false

    init(deploymentURL: URL, credentials: any PathwayAuthenticating, session: URLSession = .shared) {
        self.deploymentURL = deploymentURL
        self.credentials = credentials
        self.session = session
    }

    deinit {
        loopTask?.cancel(); sendTask?.cancel(); refreshTask?.cancel(); keepaliveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        for query in queries.values { query.deadline?.cancel() }
    }

    func authenticate() async throws {
        _ = try await freshToken()
        // This authenticated query also checks that the configured JWT is accepted by this deployment.
        _ = try await httpRequest(kind: "query", name: "companies:listMine", arguments: .object([:]))
    }

    func disconnect() async {
        stopSocket()
        let active = queries.values
        queries = [:]
        for query in active { query.deadline?.cancel(); query.subject.send(completion: .finished) }
        token = nil; tokenExpiresAt = nil
    }

    func companiesPublisher() -> AnyPublisher<[PathwayCompany], Error> {
        publisher(name: "companies:listMine", arguments: .object([:]))
            .tryMap { try decodePathwayPayload([PathwayCompany].self, from: $0) }.eraseToAnyPublisher()
    }

    func provisionCurrentUser() async throws -> PathwayCompany {
        try decodePathwayPayload(PathwayCompany.self,
            from: await httpRequest(kind: "mutation", name: "companies:provisionCurrentUser", arguments: .object([:])))
    }

    func bootstrapCompany(companyId: String, cursor: String?) async throws -> PathwaySyncBootstrapPage {
        try decodePathwayPayload(PathwaySyncBootstrapPage.self, from: await httpRequest(kind: "query", name: "sync:bootstrap",
            arguments: .object(["companyId": .string(companyId), "cursor": cursor.map(JSONValue.string) ?? .null, "pageSize": .number(100)])))
    }

    func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, Error> {
        publisher(name: "sync:latestVersion", arguments: .object(["companyId": .string(companyId)]))
            .tryMap { try decodePathwayPayload(PathwaySyncHead.self, from: $0) }.eraseToAnyPublisher()
    }

    func listChanges(companyId: String, cursor: Int) async throws -> PathwaySyncChangesPage {
        try decodePathwayPayload(PathwaySyncChangesPage.self, from: await httpRequest(kind: "query", name: "sync:listChanges",
            arguments: .object(["companyId": .string(companyId), "cursor": .number(Double(cursor)), "limit": .number(100)])))
    }

    func applyIssueOperations(companyID: String, operations: JSONValue) async throws -> JSONValue {
        try await httpRequest(kind: "mutation", name: "sync:applyOperations",
            arguments: .object(["companyId": .string(companyID), "operations": operations]))
    }

    func issueRequest(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue {
        guard ["query", "mutation", "action"].contains(kind) else {
            throw PathwayConvexWireError.invalidMessage("This cloud operation is not supported.")
        }
        return try await httpRequest(kind: kind, name: name, arguments: arguments)
    }

    func publisher(name: String, arguments: JSONValue) -> AnyPublisher<JSONValue, Error> {
        Deferred { [weak self] in
            let subject = CurrentValueSubject<JSONValue?, Error>(nil)
            let owner = UUID()
            let registration = Task { @MainActor [weak self] in
                guard !Task.isCancelled, let self else { subject.send(completion: .finished); return }
                addQuery(owner: owner, name: name, arguments: arguments, subject: subject)
            }
            return subject.compactMap { $0 }.handleEvents(receiveCancel: { [weak self] in
                registration.cancel()
                Task { @MainActor [weak self] in self?.removeQuery(owner: owner) }
            }).eraseToAnyPublisher()
        }.eraseToAnyPublisher()
    }

    private func addQuery(owner: UUID, name: String, arguments: JSONValue, subject: CurrentValueSubject<JSONValue?, Error>) {
        let id = nextQueryID; nextQueryID += 1
        var query = Query(owner: owner, name: name, arguments: arguments, subject: subject)
        query.deadline = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            guard let self, let query = queries[id] else { return }
            query.subject.send(completion: .failure(PathwayConvexWireError.timedOut))
            removeQuery(owner: owner)
        }
        queries[id] = query
        if socket != nil {
            enqueue(PathwayConvexSyncProtocol.modifyQueries(baseVersion: querySetVersion, modifications: [
                PathwayConvexSyncProtocol.addQuery(id: id, name: name, arguments: arguments)
            ]))
            querySetVersion += 1
        }
        startSocket()
    }

    private func removeQuery(owner: UUID) {
        guard let id = queries.first(where: { $0.value.owner == owner })?.key,
              let query = queries.removeValue(forKey: id) else { return }
        query.deadline?.cancel()
        if socket != nil {
            enqueue(PathwayConvexSyncProtocol.modifyQueries(baseVersion: querySetVersion,
                modifications: [.object(["type": .string("Remove"), "queryId": .number(Double(id))])]))
            querySetVersion += 1
        }
        if queries.isEmpty { stopSocket() }
    }

    private func freshToken() async throws -> String {
        try Task.checkCancellation()
        guard credentials.hasActiveSession else { throw PathwayAuthError.missingSession }
        let value = try await credentials.token(template: AppConfiguration.convexJWTTemplate)
        try Task.checkCancellation()
        token = value
        tokenExpiresAt = PathwayConvexSyncProtocol.tokenExpiration(value)
        return value
    }

    private func httpRequest(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue {
        let token = try await freshToken()
        var request = URLRequest(url: deploymentURL.appending(path: "api/\(kind)"), timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("swift-visionos-\(PathwayConvexSyncProtocol.version)", forHTTPHeaderField: "Convex-Client")
        request.httpBody = try JSONEncoder().encode(PathwayConvexSyncProtocol.httpBody(name: name, arguments: arguments))
        // HTTP writes are never automatically replayed after an ambiguous transport failure.
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if response.statusCode == 401 || response.statusCode == 403 {
            throw PathwayConvexWireError.authentication("The cloud rejected this session. Sign in again to reconnect.")
        }
        guard (200..<300).contains(response.statusCode) || response.statusCode == 560 else {
            throw PathwayConvexWireError.remote("The cloud request failed with HTTP \(response.statusCode).")
        }
        return try PathwayConvexSyncProtocol.httpResult(data)
    }

    private func startSocket() {
        desired = true
        guard loopTask == nil else { return }
        let id = UUID(); loopID = id
        loopTask = Task { @MainActor [weak self] in await self?.connectionLoop(id: id) }
    }

    private func stopSocket() {
        desired = false
        loopTask?.cancel(); loopTask = nil; loopID = nil
        closeSocket()
    }

    private func closeSocket() {
        sendTask?.cancel(); sendTask = nil
        refreshTask?.cancel(); refreshTask = nil
        keepaliveTask?.cancel(); keepaliveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil; socketID = nil; socketToken = nil
    }

    private func connectionLoop(id loopID: UUID) async {
        var failures = 0
        var lastReason: String?
        while desired, self.loopID == loopID, !Task.isCancelled, !queries.isEmpty {
            do {
                let value = try await freshToken()
                try Task.checkCancellation()
                guard self.loopID == loopID else { return }
                guard var components = URLComponents(url: deploymentURL, resolvingAgainstBaseURL: false),
                      let scheme = components.scheme, ["https", "http"].contains(scheme) else {
                    throw PathwayConvexWireError.invalidMessage("The cloud deployment URL is invalid.")
                }
                components.scheme = scheme == "https" ? "wss" : "ws"
                components.path = "/api/\(PathwayConvexSyncProtocol.version)/sync"
                components.query = nil; components.fragment = nil
                guard let url = components.url else { throw URLError(.badURL) }
                let task = session.webSocketTask(with: url)
                task.maximumMessageSize = 16 * 1024 * 1024
                let id = UUID()
                socket = task; socketID = id; socketToken = value; wire.reset(); querySetVersion = 1; identityVersion = 1
                task.resume()
                enqueue(PathwayConvexSyncProtocol.connect(sessionID: sessionID, count: connectionCount, lastCloseReason: lastReason))
                connectionCount += 1
                enqueue(PathwayConvexSyncProtocol.authenticate(token: value, baseVersion: 0))
                enqueue(PathwayConvexSyncProtocol.modifyQueries(baseVersion: 0, modifications: queries.sorted { $0.key < $1.key }.map {
                    PathwayConvexSyncProtocol.addQuery(id: $0.key, name: $0.value.name, arguments: $0.value.arguments, journal: $0.value.journal)
                }))
                lastMessageAt = Date()
                scheduleRefresh(socketID: id)
                keepaliveTask = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(15)) } catch { return }
                        guard let self, self.socketID == id else { return }
                        if Date().timeIntervalSince(lastMessageAt) > 45 { closeSocket(); return }
                    }
                }
                while desired, socketID == id, !Task.isCancelled {
                    let message = try await task.receive()
                    guard socketID == id else { break }
                    lastMessageAt = Date()
                    let data: Data
                    switch message {
                    case let .data(bytes): data = bytes
                    case let .string(text): data = Data(text.utf8)
                    @unknown default: throw PathwayConvexWireError.invalidMessage("The cloud returned an unknown message.")
                    }
                    if let decoded = try wire.decode(data) {
                        try handle(decoded)
                        if wire.remoteVersion.identity == identityVersion { failures = 0; authFailures = 0 }
                    }
                }
            } catch is CancellationError { break }
            catch {
                guard self.loopID == loopID else { return }
                lastReason = error.localizedDescription
                closeSocket()
                guard desired, !Task.isCancelled else { break }
                failures += 1
                if failures >= 8 || authFailures >= 2 {
                    let active = queries.values; queries = [:]
                    for query in active { query.deadline?.cancel(); query.subject.send(completion: .failure(error)) }
                    desired = false
                    break
                }
                do { try await Task.sleep(for: .seconds(min(8, 0.5 * pow(1.8, Double(failures - 1))))) }
                catch { break }
            }
        }
        if self.loopID == loopID { loopTask = nil; self.loopID = nil }
    }

    private func enqueue(_ value: JSONValue) {
        guard let socket, let id = socketID else { return }
        let previous = sendTask
        sendTask = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, socketID == id else { return }
            do { try await socket.send(.string(String(decoding: JSONEncoder().encode(value), as: UTF8.self))) }
            catch { if socketID == id { closeSocket() } }
        }
    }

    private func handle(_ value: JSONValue) throws {
        guard let object = value.objectValue else { throw URLError(.cannotParseResponse) }
        switch object["type"]?.stringValue {
        case "Ping": return
        case "Transition":
            let modifications = try wire.applyTransition(value)
            for modification in modifications {
                guard let fields = modification.objectValue, let id = fields["queryId"]?.intValue,
                      var query = queries[id] else { continue }
                switch fields["type"]?.stringValue {
                case "QueryUpdated":
                    query.deadline?.cancel(); query.deadline = nil
                    query.journal = fields["journal"] ?? .null; queries[id] = query
                    query.subject.send(fields["value"] ?? .null)
                case "QueryFailed":
                    query.subject.send(completion: .failure(PathwayConvexWireError.remote(
                        fields["errorMessage"]?.stringValue ?? "The cloud query failed.")))
                    removeQuery(owner: query.owner)
                case "QueryRemoved": break
                default: throw PathwayConvexWireError.invalidMessage("The cloud returned an unknown query transition.")
                }
            }
        case "AuthError":
            if let base = object["baseVersion"]?.intValue, base + 1 < identityVersion { return }
            authFailures += 1
            throw PathwayConvexWireError.authentication(object["error"]?.stringValue ?? "The cloud session expired.")
        case "FatalError":
            throw PathwayConvexWireError.remote(object["error"]?.stringValue ?? "The cloud connection failed.")
        default: throw PathwayConvexWireError.invalidMessage("The cloud returned an unsupported sync message.")
        }
    }

    private func scheduleRefresh(socketID id: UUID) {
        refreshTask?.cancel()
        let delay = max(5, (tokenExpiresAt?.timeIntervalSinceNow ?? 60) - 10)
        refreshTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard let self, socketID == id else { return }
                let previous = socketToken
                let refreshed = try await freshToken()
                guard socketID == id else { return }
                if previous != refreshed {
                    socketToken = refreshed
                    enqueue(PathwayConvexSyncProtocol.authenticate(token: refreshed, baseVersion: identityVersion))
                    identityVersion += 1
                }
                scheduleRefresh(socketID: id)
            } catch { if self?.socketID == id { self?.closeSocket() } }
        }
    }
}
#endif
