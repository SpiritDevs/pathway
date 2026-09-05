import Foundation
import Observation

struct PathwayThreadProvider: Equatable, Sendable {
    let driver: String
    let name: String

    var iconAssetName: String? {
        switch driver {
        case "codex": "provider-codex"
        case "claudeAgent": "provider-claude"
        case "cursor": "provider-cursor"
        case "grok": "provider-grok"
        case "opencode": "provider-opencode"
        default: nil
        }
    }
}

/// One config subscription per environment keeps instance branding current for every row.
@MainActor
@Observable
final class PathwayThreadProviders {
    private var providers: [String: [String: PathwayThreadProvider]] = [:]

    func provider(for thread: PathwayAgentThread) -> PathwayThreadProvider? {
        providers["\(thread.companyId):\(thread.environmentId)"]?[thread.shell.providerInstanceId]
    }

    func observe(environments: [PathwayCompanyEnvironment], using connect: PathwayConnectClient) async {
        providers = [:]
        await withTaskGroup(of: Void.self) { group in
            for environment in environments {
                group.addTask {
                    await self.observe(environment: environment, using: connect)
                }
            }
        }
    }

    func apply(_ value: JSONValue, environmentID: String) {
        guard let object = value.objectValue, let type = object["type"]?.stringValue else { return }
        let config: JSONValue?
        switch type {
        case "snapshot": config = object["config"]
        case "providerStatuses", "configUpdated": config = object["payload"]
        default: return
        }
        guard let entries = config?.objectValue?["providers"]?.arrayValue else { return }
        var updated: [String: PathwayThreadProvider] = [:]
        for entry in entries {
            guard let fields = entry.objectValue,
                  let id = fields["instanceId"]?.stringValue,
                  let driver = fields["driver"]?.stringValue
            else { continue }
            // Disabled or unavailable providers still identify existing threads.
            updated[id] = PathwayThreadProvider(
                driver: driver,
                name: fields["displayName"]?.stringValue ?? driver
            )
        }
        providers[environmentID] = updated
    }

    private func observe(environment: PathwayCompanyEnvironment, using connect: PathwayConnectClient) async {
        let rpc = PathwayRPCClient {
            try await connect.prepare(environment: environment).webSocketURL
        }
        do {
            let stream = await rpc.subscribe("subscribeServerConfig", payload: .object([:]))
            for try await value in stream {
                guard !Task.isCancelled else { break }
                apply(value, environmentID: environment.id)
            }
        } catch {
            // Keep the last known branding while this environment is disconnected.
        }
        await rpc.stop()
    }
}
