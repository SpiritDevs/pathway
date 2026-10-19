import Foundation
import Observation

struct PathwayWorkspaceCleanupFailure: Decodable, Equatable, Sendable {
    let effectId: String
    let threadId: String
    let title: String
    let message: String
    let nextAttemptAt: String?
}

struct PathwayWorkspaceCleanupEntry: Identifiable, Equatable, Sendable {
    let environmentID: String
    let environmentLabel: String
    let failure: PathwayWorkspaceCleanupFailure
    var id: String { "\(environmentID):\(failure.effectId)" }
}

/// Environment subscriptions survive thread deletion and report retained local files.
@MainActor
@Observable
final class PathwayWorkspaceCleanupModel {
    private var entriesByEnvironment: [String: [PathwayWorkspaceCleanupEntry]] = [:]
    private var clients: [String: PathwayRPCClient] = [:]
    private(set) var retrying: Set<String> = []
    var errorMessage: String?

    var entries: [PathwayWorkspaceCleanupEntry] {
        entriesByEnvironment.values.flatMap { $0 }.sorted { $0.id < $1.id }
    }

    func canRetry(_ entry: PathwayWorkspaceCleanupEntry) -> Bool {
        clients[entry.environmentID] != nil && !retrying.contains(entry.id)
    }

    func apply(_ value: JSONValue, environmentID: String, label: String) throws {
        if value.objectValue?["_pathwayTransport"] != nil { return }
        let failures = try JSONDecoder().decode(
            [PathwayWorkspaceCleanupFailure].self, from: JSONEncoder().encode(value)
        )
        entriesByEnvironment[environmentID] = failures.map {
            PathwayWorkspaceCleanupEntry(environmentID: environmentID, environmentLabel: label, failure: $0)
        }
    }

    func observe(environments: [PathwayCompanyEnvironment], using connect: PathwayConnectClient) async {
        let ids = Set(environments.map { $0.environment.environmentId })
        entriesByEnvironment = entriesByEnvironment.filter { ids.contains($0.key) }
        await withTaskGroup(of: Void.self) { group in
            var observed: Set<String> = []
            for environment in environments where observed.insert(environment.environment.environmentId).inserted {
                group.addTask { await self.observe(environment: environment, using: connect) }
            }
        }
    }

    func retry(_ entry: PathwayWorkspaceCleanupEntry) async {
        guard canRetry(entry), let rpc = clients[entry.environmentID] else { return }
        retrying.insert(entry.id)
        defer { retrying.remove(entry.id) }
        do {
            _ = try await rpc.request("orchestration.retryWorkspaceCleanup", payload: .object([
                "effectId": .string(entry.failure.effectId)
            ]))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func observe(environment: PathwayCompanyEnvironment, using connect: PathwayConnectClient) async {
        let id = environment.environment.environmentId
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        clients[id] = rpc
        defer {
            if clients[id] === rpc { clients.removeValue(forKey: id) }
        }
        do {
            for try await value in await rpc.subscribe("orchestration.subscribeWorkspaceCleanup", payload: .object([:])) {
                guard !Task.isCancelled else { break }
                try apply(value, environmentID: id, label: environment.environment.label)
            }
        } catch {
            // Keep the last failure visible until a reconnected environment confirms cleanup.
        }
        await rpc.stop()
    }
}
