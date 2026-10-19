import Foundation

protocol PathwayIssueRPCClient: Sendable {
    func subscribe(_ tag: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error>
    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool, waitForSubscription: Bool, timeout: Duration) async throws -> JSONValue
    func stop() async
}

extension PathwayRPCClient: PathwayIssueRPCClient {}

/// Keeps protocol negotiation and the event drain alive on the connection that executes work.
@MainActor
final class PathwayIssueEnvironmentClient {
    typealias ClientFactory = @MainActor (PathwayCompanyEnvironment, PathwayConnectClient) -> any PathwayIssueRPCClient
    var onEvent: (@MainActor (String, String, JSONValue) -> Void)?
    private let makeClient: ClientFactory
    private var clients: [String: any PathwayIssueRPCClient] = [:]
    private var clientIDs: [String: UUID] = [:]
    private var eventTasks: [String: Task<Void, Never>] = [:]

    init(makeClient: @escaping ClientFactory = { environment, connect in
        PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
    }) {
        self.makeClient = makeClient
    }

    func request(
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient,
        method: String,
        payload: JSONValue,
        timeout: Duration = .seconds(30)
    ) async throws -> JSONValue {
        let key = environment.id
        let rpc: any PathwayIssueRPCClient
        let clientID: UUID
        if let existing = clients[key], let existingID = clientIDs[key] {
            rpc = existing
            clientID = existingID
        } else {
            rpc = makeClient(environment, connect)
            clientID = UUID()
            clients[key] = rpc
            clientIDs[key] = clientID
            let stream = await rpc.subscribe("issues.stream", payload: .object([
                "clientProtocolVersion": .number(1)
            ]))
            // Stop/reconnect may replace this entry while subscribe prepares its stream.
            guard clientIDs[key] == clientID, !Task.isCancelled else {
                if clientIDs[key] == clientID {
                    clients.removeValue(forKey: key)
                    clientIDs.removeValue(forKey: key)
                }
                await rpc.stop()
                throw CancellationError()
            }
            eventTasks[key] = Task { [weak self] in
                do {
                    for try await event in stream {
                        guard !Task.isCancelled, let self, clientIDs[key] == clientID else { break }
                        onEvent?(environment.companyId, environment.environment.environmentId, event)
                    }
                } catch {
                    // The request transport owns its user-visible error. This drain owns cleanup.
                }
                if let self, clientIDs[key] == clientID {
                    clients.removeValue(forKey: key)
                    clientIDs.removeValue(forKey: key)
                    eventTasks.removeValue(forKey: key)
                }
                await rpc.stop()
            }
        }
        // Reconnect repeats this gate because protocol negotiation belongs to the socket.
        let result = try await rpc.request(method, payload: payload, requiresSubscription: true,
                                           waitForSubscription: true, timeout: timeout)
        guard clientIDs[key] == clientID, !Task.isCancelled else { throw CancellationError() }
        return result
    }

    /// Placement reads do not require an issue or conversation subscription.
    static func placementSnapshot(
        environment: PathwayCompanyEnvironment, connect: PathwayConnectClient,
        makeClient: ClientFactory = { environment, connect in
            PathwayRPCClient { try await connect.prepare(environment: environment).threadOperationWebSocketURL() }
        }
    ) async throws -> PathwayEnvironmentPlacementSnapshot {
        let rpc = makeClient(environment, connect)
        do {
            let config = try await rpc.request("server.getConfig", payload: .object([:]),
                requiresSubscription: false, waitForSubscription: false, timeout: .seconds(5))
            let resources = try await rpc.request("server.getHostResources", payload: .object([:]),
                requiresSubscription: false, waitForSubscription: false, timeout: .seconds(5))
            let receivedAt = ProcessInfo.processInfo.systemUptime
            await rpc.stop()
            try Task.checkCancellation()
            return PathwayEnvironmentPlacementSnapshot(config: config, resources: resources, receivedAt: receivedAt)
        } catch {
            await rpc.stop()
            throw error
        }
    }

    func stop() async {
        let openClients = Array(clients.values)
        clientIDs = [:]
        eventTasks.values.forEach { $0.cancel() }
        eventTasks = [:]
        clients = [:]
        for client in openClients { await client.stop() }
    }
}
