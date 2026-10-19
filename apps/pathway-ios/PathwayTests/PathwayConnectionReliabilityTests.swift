import Foundation
import Observation
@testable import Pathway
import Testing

struct PathwayRPCHeartbeatTests {
    private let start = ContinuousClock.now
    private func at(_ seconds: Int) -> ContinuousClock.Instant { start + .seconds(seconds) }

    @Test func aSlowResponseInsideTheGraceKeepsTheSocket() {
        var heartbeat = PathwayRPCHeartbeat()
        #expect(heartbeat.tick(now: at(5)) == .ping)
        // The environment answers six seconds after the Ping; the old detector closed at ten.
        #expect(heartbeat.tick(now: at(10)) == .ping)
        heartbeat.received()
        #expect(heartbeat.tick(now: at(15)) == .ping)
        #expect(heartbeat.tick(now: at(20)) == .ping)
    }

    @Test func silenceForTheWholeGraceExpiresExactlyOnce() {
        var heartbeat = PathwayRPCHeartbeat()
        #expect(heartbeat.tick(now: at(5)) == .ping)
        #expect(heartbeat.tick(now: at(10)) == .ping)
        #expect(heartbeat.tick(now: at(15)) == .ping)
        #expect(heartbeat.tick(now: at(20)) == .ping)
        #expect(heartbeat.tick(now: at(25)) == .expire)
    }

    @Test func activityJustBeforeTheDeadlineStartsAFreshProbe() {
        var heartbeat = PathwayRPCHeartbeat()
        for second in stride(from: 5, through: 20, by: 5) { #expect(heartbeat.tick(now: at(second)) == .ping) }
        heartbeat.received()
        for second in stride(from: 25, through: 40, by: 5) { #expect(heartbeat.tick(now: at(second)) == .ping) }
        #expect(heartbeat.tick(now: at(45)) == .expire)
    }

    @Test func aSuspendedProcessProbesBeforeClosing() {
        var heartbeat = PathwayRPCHeartbeat()
        #expect(heartbeat.tick(now: at(5)) == .ping)
        // The app was suspended with a Ping outstanding; its late timer wakes must not close at once.
        #expect(heartbeat.tick(now: at(600)) == .ping)
        #expect(heartbeat.tick(now: at(1200)) == .ping)
        #expect(heartbeat.tick(now: at(1205)) == .ping)
        #expect(heartbeat.tick(now: at(1210)) == .ping)
        #expect(heartbeat.tick(now: at(1215)) == .ping)
        #expect(heartbeat.tick(now: at(1220)) == .expire)
    }
}

struct PathwayRPCConnectFailureTests {
    @Test func classifiesConnectionFailures() {
        #expect(PathwayConnectFailure(PathwayConnectError.environmentMismatch) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.scopeMismatch) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.invalidProofKey) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.invalidURL) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.invalidConfiguration("This server session expired. Pair again.")) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.response(status: 403, message: "Denied", traceID: nil)) == .permanent)
        #expect(PathwayConnectFailure(PathwayConnectError.response(status: 401, message: "Expired", traceID: nil)) == .unauthorized)
        #expect(PathwayConnectFailure(PathwayConnectError.response(status: 503, message: "Starting", traceID: nil)) == .transient)
        #expect(PathwayConnectFailure(PathwayConnectError.invalidResponse) == .transient)
        #expect(PathwayConnectFailure(URLError(.timedOut)) == .transient)
        #expect(PathwayConnectFailure(URLError(.notConnectedToInternet)) == .transient)
    }

    @Test func permanentRejectionEndsTheStreamWithItsErrorAfterOneAttempt() async {
        let attempts = EndpointAttempts { _ in throw PathwayConnectError.environmentMismatch }
        let rpc = PathwayRPCClient { try await attempts.next() }
        let outcome = await Self.finish(await rpc.subscribe("subscribeServerConfig", payload: .object([:])))
        #expect(outcome.states == ["connecting"])
        #expect(outcome.error?.localizedDescription == PathwayConnectError.environmentMismatch.localizedDescription)
        #expect(await attempts.count == 1)
        await rpc.stop()
    }

    @Test func permanentRejectionFailsAPendingRequestAtOnceWithItsError() async {
        let attempts = EndpointAttempts { _ in throw PathwayConnectError.scopeMismatch }
        let rpc = PathwayRPCClient { try await attempts.next() }
        do {
            _ = try await rpc.request("server.getConfig", payload: .object([:]))
            Issue.record("A pending request must fail with the rejection")
        } catch { #expect(error.localizedDescription == PathwayConnectError.scopeMismatch.localizedDescription) }
        #expect(await attempts.count == 1)
        await rpc.stop()
    }

    @Test func explicitRetryAfterARejectionTriesAgain() async {
        let attempts = EndpointAttempts { _ in throw PathwayConnectError.invalidConfiguration("This server session expired. Pair again using a new pairing link.") }
        let rpc = PathwayRPCClient { try await attempts.next() }
        _ = await Self.finish(await rpc.subscribe("subscribeServerConfig", payload: .object([:])))
        #expect(await attempts.count == 1)
        _ = await Self.finish(await rpc.subscribe("subscribeServerConfig", payload: .object([:])))
        #expect(await attempts.count == 2)
        await rpc.stop()
    }

    @Test func aRejectedCredentialGetsOneFreshAuthorizationBeforeStopping() async {
        let attempts = EndpointAttempts { _ in throw PathwayConnectError.response(status: 401, message: "Unauthorized", traceID: nil) }
        let rpc = PathwayRPCClient { try await attempts.next() }
        let outcome = await Self.finish(await rpc.subscribe("subscribeServerConfig", payload: .object([:])))
        #expect(outcome.error.map { PathwayConnectFailure($0) } == .unauthorized)
        #expect(await attempts.count == 2)
        await rpc.stop()
    }

    @Test func transientFailuresKeepRetryingAndOneUnauthorizedDoesNotStop() async {
        let attempts = EndpointAttempts { number in
            if number == 1 { throw PathwayConnectError.response(status: 401, message: "Unauthorized", traceID: nil) }
            throw URLError(.notConnectedToInternet)
        }
        let rpc = PathwayRPCClient { try await attempts.next() }
        let stream = await rpc.subscribe("subscribeServerConfig", payload: .object([:]))
        await attempts.wait(for: 4)
        await rpc.stop()
        let outcome = await Self.finish(stream)
        #expect(outcome.error == nil)
        #expect(outcome.states.first == "connecting")
    }

    private static func finish(_ stream: AsyncThrowingStream<JSONValue, Error>) async -> (states: [String], error: Error?) {
        var states: [String] = []
        do {
            for try await value in stream {
                if let state = value.objectValue?["_pathwayTransport"]?.stringValue { states.append(state) }
            }
            return (states, nil)
        } catch { return (states, error) }
    }
}

private actor EndpointAttempts {
    private let result: @Sendable (Int) throws -> URL
    private(set) var count = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(_ result: @escaping @Sendable (Int) throws -> URL) { self.result = result }

    func next() throws -> URL {
        count += 1
        let ready = waiters.filter { $0.0 <= count }
        waiters.removeAll { $0.0 <= count }
        ready.forEach { $0.1.resume() }
        return try result(count)
    }

    func wait(for attempts: Int) async {
        guard count < attempts else { return }
        await withCheckedContinuation { waiters.append((attempts, $0)) }
    }
}

@Suite(.serialized)
struct PathwayEnvironmentAuthorizationTests {
    private let environment = PathwayCompanyEnvironment(companyId: "company", environment: PathwayEnvironment(id: "environment", environmentId: "environment",
        descriptor: PathwayEnvironmentDescriptor(environmentId: "environment", label: "Mac", serverVersion: "test"),
        relayLinkState: "linked", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))

    @Test func concurrentSocketsShareOneAuthorizationAndEachGetsItsOwnTicket() async throws {
        let (connect, server) = Self.client()
        async let first = connect.prepare(environment: environment)
        async let second = connect.prepare(environment: environment)
        let connections = try await [first, second]
        let reconnect = try await connect.prepare(environment: environment)
        #expect(server.count("/v1/environments/environment/connect") == 1)
        #expect(server.count("/oauth/token") == 1)
        #expect(server.count("/api/auth/websocket-ticket") == 3)
        let tickets = Set((connections + [reconnect]).compactMap { URLComponents(url: $0.webSocketURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "wsTicket" }?.value })
        #expect(tickets.count == 3)
        #expect(reconnect.webSocketURL.path == "/ws")
    }

    @Test func signedHTTPAndAssetBasesNeverMintATicket() async throws {
        let (connect, server) = Self.client()
        let authorization = try await connect.authorize(environment: environment)
        #expect(authorization.httpBaseURL.absoluteString == "https://environment.test")
        let request = try await connect.authenticatedRequest(environment: environment, method: "POST", path: "/api/uploads/one")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "DPoP environment-token-1")
        _ = try await connect.authorize(environment: environment)
        #expect(server.count("/oauth/token") == 1)
        #expect(server.count("/api/auth/websocket-ticket") == 0)
    }

    @Test func aRevokedSessionAuthorizesAgainOnce() async throws {
        let (connect, server) = Self.client()
        _ = try await connect.prepare(environment: environment)
        server.rejectNextTicket()
        let connection = try await connect.prepare(environment: environment)
        #expect(connection.accessToken == "environment-token-2")
        #expect(server.count("/oauth/token") == 2)
    }

    @Test func anExpiringSessionIsNotReused() async throws {
        let (connect, server) = Self.client(environmentTokenLifetime: 30)
        _ = try await connect.prepare(environment: environment)
        _ = try await connect.prepare(environment: environment)
        #expect(server.count("/oauth/token") == 2)
    }

    @Test func accountSwitchAndSignOutDoNotReuseTheOldSession() async throws {
        let account = AccountToken()
        let (connect, server) = Self.client(token: { account.value })
        _ = try await connect.prepare(environment: environment)
        await account.set("account-b")
        _ = try await connect.prepare(environment: environment)
        #expect(server.count("/oauth/token") == 2)
        await connect.clearEnvironmentAuthorizations()
        _ = try await connect.prepare(environment: environment)
        #expect(server.count("/oauth/token") == 3)
    }

    @Test func aDifferentEnvironmentIsRejectedPermanently() async throws {
        let (connect, server) = Self.client(descriptorEnvironmentID: "another-environment")
        do {
            _ = try await connect.prepare(environment: environment)
            Issue.record("A different environment must be rejected")
        } catch { #expect(PathwayConnectFailure(error) == .permanent) }
        #expect(server.count("/oauth/token") == 0)
    }

    private static func client(
        environmentTokenLifetime: Double = 3600,
        descriptorEnvironmentID: String = "environment",
        token: @escaping PathwayConnectClient.ClerkTokenProvider = { "account-a" }
    ) -> (PathwayConnectClient, AuthorizationServer) {
        let server = AuthorizationServer(environmentTokenLifetime: environmentTokenLifetime, descriptorEnvironmentID: descriptorEnvironmentID)
        AuthorizationURLProtocol.server = server
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthorizationURLProtocol.self]
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: token,
                                           session: URLSession(configuration: configuration))
        return (connect, server)
    }
}

@MainActor private final class AccountToken {
    private(set) var value = "account-a"
    func set(_ value: String) { self.value = value }
}

private final class AuthorizationServer: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String] = []
    private var environmentTokens = 0
    private var tickets = 0
    private var rejectsTicket = false
    private let environmentTokenLifetime: Double
    private let descriptorEnvironmentID: String

    init(environmentTokenLifetime: Double, descriptorEnvironmentID: String) {
        self.environmentTokenLifetime = environmentTokenLifetime
        self.descriptorEnvironmentID = descriptorEnvironmentID
    }

    func count(_ path: String) -> Int { lock.withLock { paths.filter { $0 == path }.count } }
    func rejectNextTicket() { lock.withLock { rejectsTicket = true } }

    func respond(to request: URLRequest) -> (Int, JSONValue) {
        lock.withLock {
            let path = request.url?.path ?? ""
            paths.append(path)
            let accessTokenType = "urn:ietf:params:oauth:token-type:access_token"
            switch path {
            case "/v1/client/dpop-token":
                return (200, .object(["access_token": .string("relay-token"), "issued_token_type": .string(accessTokenType),
                                      "token_type": .string("DPoP"), "expires_in": .number(600), "scope": .string("environment:connect")]))
            case "/v1/environments/environment/connect":
                return (200, .object(["environmentId": .string("environment"), "credential": .string("bootstrap"), "expiresAt": .string("2099-01-01T00:00:00Z"),
                                      "endpoint": .object(["httpBaseUrl": .string("https://environment.test"), "wsBaseUrl": .string("wss://environment.test"),
                                                           "providerKind": .string("relay")])]))
            case "/.well-known/pathway/environment":
                return (200, .object(["environmentId": .string(descriptorEnvironmentID), "applicationId": .string("pathway"), "label": .string("Mac")]))
            case "/oauth/token":
                environmentTokens += 1
                return (200, .object(["access_token": .string("environment-token-\(environmentTokens)"), "issued_token_type": .string(accessTokenType),
                                      "token_type": .string("DPoP"), "expires_in": .number(environmentTokenLifetime),
                                      "scope": .string(PathwayConnectClient.environmentScopes(computerOperateScope: false).joined(separator: " "))]))
            case "/api/auth/websocket-ticket":
                if rejectsTicket {
                    rejectsTicket = false
                    return (401, .object(["message": .string("Session revoked")]))
                }
                tickets += 1
                return (200, .object(["ticket": .string("ticket-\(tickets)")]))
            default:
                return (404, .object([:]))
            }
        }
    }
}

private final class AuthorizationURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var server: AuthorizationServer?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let server = Self.server, let url = request.url else { return }
        let (status, body) = server.respond(to: request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONEncoder().encode(body)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

@MainActor struct PathwayThreadConnectionFailureTests {
    @Test(.timeLimit(.minutes(1)))
    func aRejectedConnectionShowsItsErrorKeepsSavedMessagesAndCanRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
            relayLinkState: "linked", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let saved = PathwayAgentThreadModel(thread: thread, environment: environment, request: { _, _ in .object([:]) })
        saved.installSnapshot(.object(["visibleTurnItems": .array([.object(["item": .object([
            "id": .string("message"), "type": .string("user_message"), "createdBy": .string("user"), "text": .string("Saved message")
        ])])])]))
        let cache = PathwayThreadCache(directory: directory.appending(path: "AgentThreads"))
        await cache.save(items: saved.items, threadID: thread.id, revision: 1)
        let rejection = PathwayConnectError.invalidConfiguration("This server session expired. Pair again using a new pairing link.")
        let attempts = TokenAttempts()
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.invalid")!, clerkTokenProvider: {
            attempts.count += 1
            throw rejection
        })
        let model = PathwayAgentThreadModel(thread: thread, environment: environment, connect: connect, cache: cache, storageDirectory: directory)
        model.start()
        await waitUntil { model.connectionState == .failed(rejection.localizedDescription) }
        #expect(model.items.map(\.text) == saved.items.map(\.text))
        #expect(!model.items.isEmpty)
        let failedAttempts = attempts.count
        await model.stop()
        model.start()
        await waitUntil { attempts.count > failedAttempts && model.connectionState == .failed(rejection.localizedDescription) }
        await model.stop()
    }

    private func waitUntil(_ predicate: @escaping @MainActor () -> Bool) async {
        while !predicate() {
            await withCheckedContinuation { continuation in
                withObservationTracking { _ = predicate() } onChange: { continuation.resume() }
            }
        }
    }
}

@MainActor private final class TokenAttempts {
    var count = 0
}
