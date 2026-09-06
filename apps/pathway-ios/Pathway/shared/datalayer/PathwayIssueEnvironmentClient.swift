import Foundation

/// Keeps protocol negotiation and the event drain alive on the connection that executes work.
@MainActor
final class PathwayIssueEnvironmentClient {
    var onEvent: (@MainActor (String, String, JSONValue) -> Void)?
    private var clients: [String: PathwayRPCClient] = [:]
    private var eventTasks: [String: Task<Void, Never>] = [:]

    func request(
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient,
        method: String,
        payload: JSONValue
    ) async throws -> JSONValue {
        let key = environment.id
        let rpc: PathwayRPCClient
        if let existing = clients[key] {
            rpc = existing
        } else {
            rpc = PathwayRPCClient {
                try await connect.prepare(environment: environment).webSocketURL
            }
            clients[key] = rpc
            let stream = await rpc.subscribe("issues.stream", payload: .object([
                "clientProtocolVersion": .number(1)
            ]))
            eventTasks[key] = Task { [weak self] in
                do {
                    for try await event in stream {
                        guard !Task.isCancelled else { return }
                        self?.onEvent?(environment.companyId, environment.environment.environmentId, event)
                    }
                } catch {
                    self?.clients.removeValue(forKey: key)
                    self?.eventTasks.removeValue(forKey: key)
                    await rpc.stop()
                }
            }
        }
        // The RPC client repeats this gate after reconnecting, when the server has forgotten
        // this connection's protocol version. A one-time handshake task cannot provide that.
        return try await rpc.request(method, payload: payload, requiresSubscription: true)
    }

    func stop() async {
        let openClients = Array(clients.values)
        eventTasks.values.forEach { $0.cancel() }
        eventTasks = [:]
        clients = [:]
        for client in openClients { await client.stop() }
    }
}
