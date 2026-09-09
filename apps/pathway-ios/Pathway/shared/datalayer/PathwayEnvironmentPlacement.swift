import Foundation
import Observation

/// Placement preferences belong to this client; host weights do not change other devices.
@MainActor
@Observable
final class PathwayEnvironmentPlacementPreferences {
    static let shared = PathwayEnvironmentPlacementPreferences()
    static let weights = [0, 25, 50, 100]
    var enabled: Bool { didSet { defaults.set(enabled, forKey: "environmentPlacement.enabled") } }
    var avoidCriticalStorage: Bool { didSet { defaults.set(avoidCriticalStorage, forKey: "environmentPlacement.avoidCriticalStorage") } }
    private(set) var environmentWeights: [String: Int]
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: "environmentPlacement.enabled")
        avoidCriticalStorage = defaults.bool(forKey: "environmentPlacement.avoidCriticalStorage")
        environmentWeights = (defaults.dictionary(forKey: "environmentPlacement.weights") as? [String: Int] ?? [:])
            .filter { Self.weights.contains($0.value) }
    }

    func weight(for environmentID: String) -> Int { environmentWeights[environmentID] ?? 50 }
    func setWeight(_ weight: Int, for environmentID: String) {
        guard Self.weights.contains(weight) else { return }
        environmentWeights[environmentID] = weight
        defaults.set(environmentWeights, forKey: "environmentPlacement.weights")
    }
    static func label(_ weight: Int) -> String {
        switch weight {
        case 0: "Manual only"
        case 25: "Less often"
        case 100: "Prefer"
        default: "Normal"
        }
    }
}

struct PathwayHostResources: Decodable, Sendable {
    let sampledAt: Double
    let cpuUtilization: Double?
    let cpuCount: Int
    let availableMemoryBytes: Double
    let totalMemoryBytes: Double
    var storagePressure: String? = nil
    var storageSampledAt: Double? = nil

    var hasFreshCriticalStorage: Bool {
        guard storagePressure == "critical", let storageSampledAt else { return false }
        return storageSampledAt.isFinite && sampledAt - storageSampledAt >= -5_000 && sampledAt - storageSampledAt <= 60_000
    }

    /// Use receipt age because clocks on remote environments need not agree with this device.
    func score(weight: Int, receivedAt: Double, now: Double) -> Double? {
        guard weight > 0, sampledAt.isFinite, sampledAt >= 0,
              receivedAt.isFinite, now.isFinite, receivedAt <= now + 5, now - receivedAt <= 15,
              let cpuUtilization, cpuUtilization.isFinite, (0..<0.95).contains(cpuUtilization), cpuCount > 0, cpuCount <= 9_007_199_254_740_991,
              availableMemoryBytes.isFinite, totalMemoryBytes.isFinite, totalMemoryBytes > 0,
              availableMemoryBytes > 0, availableMemoryBytes <= totalMemoryBytes,
              availableMemoryBytes.rounded() == availableMemoryBytes, totalMemoryBytes.rounded() == totalMemoryBytes,
              totalMemoryBytes <= 9_007_199_254_740_991 else { return nil }
        let memory = availableMemoryBytes / totalMemoryBytes
        guard memory > 0.05 else { return nil }
        let score = Double(weight) * Double(cpuCount) * (1 - cpuUtilization) * memory
        return score.isFinite ? score : nil
    }
}

/// Instance identifiers are local to a server. Only a unique compatible local instance can match.
struct PathwayPlacementModelChoice: Sendable {
    let driver: String
    let model: String
    let options: [String: JSONValue]
    let interactionMode: String
    var runtimeMode: String = "full-access"

    func provider(in providers: [PathwayServerProvider]) -> PathwayServerProvider? {
        let matches = providers.filter { provider in
            guard provider.driver == driver, provider.unavailableReason == nil,
                  interactionMode == "default" || provider.showsInteractionMode,
                  let model = provider.models.first(where: { $0.id == self.model }) else { return false }
            return options.allSatisfy { id, value in
                guard let descriptor = model.optionDescriptors.first(where: { $0.id == id }) else { return false }
                switch descriptor.type {
                case "select": return descriptor.choices.contains { .string($0.id) == value }
                case "boolean": return value.boolValue != nil
                default: return false
                }
            }
        }
        return matches.count == 1 ? matches[0] : nil
    }
}

struct PathwayEnvironmentPlacementSnapshot: Sendable {
    let config: JSONValue
    let resources: JSONValue
    let receivedAt: Double
}

struct PathwayEnvironmentPlacementCandidate: Sendable {
    let bindingID: String
    let environmentID: String
    let resources: PathwayHostResources
    let receivedAt: Double
    let weight: Int
}

enum PathwayEnvironmentPlacement {
    static func select(_ candidates: [PathwayEnvironmentPlacementCandidate], now: Double) -> String? {
        var selected: (String, Double)?
        for candidate in candidates {
            guard let score = candidate.resources.score(weight: candidate.weight, receivedAt: candidate.receivedAt, now: now) else { continue }
            if score > (selected?.1 ?? 0) { selected = (candidate.bindingID, score) }
        }
        return selected?.0
    }

    @MainActor
    static func availableProviders(_ config: JSONValue) -> [PathwayServerProvider] {
        (config.objectValue?["providers"]?.arrayValue ?? []).filter { value in
            let provider = value.objectValue ?? [:]
            let status = provider["status"]?.stringValue
            return provider["auth"]?.objectValue?["status"]?.stringValue == "authenticated"
                && status != "error" && status != "disabled"
        }.compactMap(PathwayAgentThreadModel.provider).filter { $0.unavailableReason == nil && !$0.models.isEmpty }
    }

    @MainActor
    static func hasSavedDraft(bindingID: String, directory: URL?) async -> Bool {
        guard let directory else { return false }
        if let draft = await PathwayThreadCreationDraftStore(directory: directory, key: bindingID).load(),
           !draft.prompt.isEmpty || !draft.initialImageUploads.isEmpty || draft.attempt != nil || draft.placementPinned == true {
            return true
        }
        let attachments = PathwayConversationDraftStore(directory: directory.appending(path: "InitialAttachments"), key: bindingID)
        return await attachments.load()?.attachments.isEmpty == false
    }

    /// Probe registered workspaces within the selected company before the composer uploads files.
    @MainActor
    static func resolve(
        bindings: [PathwayNewThreadBindingOption], preferredBindingID: String,
        choice: PathwayPlacementModelChoice?, preferences: PathwayEnvironmentPlacementPreferences,
        directory: URL?, request: @escaping @MainActor @Sendable (PathwayCompanyEnvironment) async throws -> PathwayEnvironmentPlacementSnapshot
    ) async -> String? {
        guard preferences.enabled, bindings.count > 1,
              !(await hasSavedDraft(bindingID: preferredBindingID, directory: directory)) else { return nil }
        guard let origin = bindings.first(where: { $0.id == preferredBindingID }), origin.projectID != nil else { return nil }
        let projectBindings = bindings.filter {
            $0.environment.companyId == origin.environment.companyId
                && $0.projectID == origin.projectID
                && ($0.binding?.binding.status ?? $0.environment.environment.state) == "active"
                && $0.environment.environment.state == "active"
                && ($0.projectID != nil || $0.environment.environment.descriptor.capabilities?["threadConversations"]?.boolValue == true)
        }
        let byEnvironment = Dictionary(grouping: projectBindings) { $0.environment.environment.environmentId }
        let eligible = projectBindings.filter { candidate in
            let environmentID = candidate.environment.environment.environmentId
            if environmentID == origin.environment.environment.environmentId { return candidate.id == origin.id }
            guard let copies = byEnvironment[environmentID], let first = copies.first,
                  copies.allSatisfy({
                      $0.binding?.binding.localProjectId == first.binding?.binding.localProjectId
                          && $0.binding?.binding.localWorkspaceRoot == first.binding?.binding.localWorkspaceRoot
                  }) else { return false }
            return candidate.id == first.id
        }
        let weights = preferences.environmentWeights
        let candidates = await withTaskGroup(of: PathwayEnvironmentPlacementCandidate?.self) { group in
            for option in eligible {
                let weight = weights[option.environment.environment.environmentId] ?? 50
                guard weight > 0 else { continue }
                group.addTask {
                    await sample(option: option, choice: choice, weight: weight, directory: directory, request: request)
                }
            }
            var result: [PathwayEnvironmentPlacementCandidate] = []
            for await candidate in group { if let candidate { result.append(candidate) } }
            return result
        }
        guard !Task.isCancelled else { return nil }
        let ordered = bindings.compactMap { option in candidates.first { $0.bindingID == option.id } }
        let alternatives = preferences.avoidCriticalStorage ? ordered.filter { !$0.resources.hasFreshCriticalStorage } : ordered
        return select(alternatives, now: ProcessInfo.processInfo.systemUptime)
            ?? select(ordered, now: ProcessInfo.processInfo.systemUptime)
    }

    @MainActor
    private static func sample(
        option: PathwayNewThreadBindingOption, choice: PathwayPlacementModelChoice?, weight: Int, directory: URL?,
        request: @escaping @MainActor @Sendable (PathwayCompanyEnvironment) async throws -> PathwayEnvironmentPlacementSnapshot
    ) async -> PathwayEnvironmentPlacementCandidate? {
        guard !Task.isCancelled,
              !(await hasSavedDraft(bindingID: option.id, directory: directory)) else { return nil }
        do {
            let snapshot = try await request(option.environment)
            let providers = availableProviders(snapshot.config)
            guard !providers.isEmpty, choice == nil || choice?.provider(in: providers) != nil else { return nil }
            let resources = try JSONDecoder().decode(PathwayHostResources.self, from: JSONEncoder().encode(snapshot.resources))
            return PathwayEnvironmentPlacementCandidate(bindingID: option.id,
                environmentID: option.environment.environment.environmentId, resources: resources,
                receivedAt: snapshot.receivedAt, weight: weight)
        } catch { return nil }
    }

}
