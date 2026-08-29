import Foundation
import Observation

struct PathwayProviderOptionChoice: Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let isDefault: Bool
}

struct PathwayProviderOptionDescriptor: Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let type: String
    let choices: [PathwayProviderOptionChoice]
    let currentValue: JSONValue?
}

struct PathwayServerModel: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let isDefault: Bool
    let optionDescriptors: [PathwayProviderOptionDescriptor]
}

struct PathwayServerProvider: Equatable, Identifiable, Sendable {
    let id: String
    let driver: String
    let name: String
    let models: [PathwayServerModel]
    let showsInteractionMode: Bool
}

@MainActor
@Observable
final class PathwayAgentThreadCreationModel {
    private(set) var connectionState: PathwayThreadConnectionState = .idle
    private(set) var providers: [PathwayServerProvider] = []
    private(set) var isLaunching = false
    private(set) var errorMessage: String?

    var prompt = ""
    var selectedProviderID = "" {
        didSet {
            guard selectedProviderID != oldValue else { return }
            if selectedProvider?.showsInteractionMode != true {
                interactionMode = "default"
            }
            selectDefaultModel()
        }
    }

    var selectedModelID = "" {
        didSet {
            guard selectedModelID != oldValue else { return }
            selectDefaultOptions()
        }
    }

    var optionValues: [String: JSONValue] = [:]
    var runtimeMode = "full-access"
    var interactionMode = "default"
    var workspaceMode = "local"
    var baseReference = "main"
    var branch = ""
    var startFromOrigin = true

    @ObservationIgnored private let binding: PathwayCompanyEnvironmentBinding
    @ObservationIgnored private let environment: PathwayCompanyEnvironment
    @ObservationIgnored private let connect: PathwayConnectClient
    @ObservationIgnored private var rpc: PathwayRPCClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?

    init(
        binding: PathwayCompanyEnvironmentBinding,
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient
    ) {
        self.binding = binding
        self.environment = environment
        self.connect = connect
    }

    deinit {
        streamTask?.cancel()
        if let rpc {
            Task { await rpc.stop() }
        }
    }

    var selectedProvider: PathwayServerProvider? {
        providers.first { $0.id == selectedProviderID }
    }

    var selectedModel: PathwayServerModel? {
        selectedProvider?.models.first { $0.id == selectedModelID }
    }

    var canLaunch: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && selectedProvider != nil
            && selectedModel != nil
            && connectionState == .live
            && !isLaunching
            && (workspaceMode != "worktree"
                || !baseReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func start() {
        guard streamTask == nil else { return }
        connectionState = .connecting
        let connect = connect
        let environment = environment
        let rpc = PathwayRPCClient {
            try await connect.prepare(environment: environment).webSocketURL
        }
        self.rpc = rpc
        streamTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let stream = await rpc.subscribe("subscribeServerConfig", payload: .object([:]))
                for try await value in stream {
                    guard !Task.isCancelled else { return }
                    apply(value)
                }
            } catch is CancellationError {
                return
            } catch {
                connectionState = .failed(error.localizedDescription)
                errorMessage = error.localizedDescription
            }
        }
    }

    func stop() async {
        streamTask?.cancel()
        streamTask = nil
        await rpc?.stop()
        rpc = nil
    }

    func launch() async -> String? {
        guard canLaunch, let rpc, let selectedProvider, let selectedModel else { return nil }
        isLaunching = true
        errorMessage = nil
        defer { isLaunching = false }

        let options = selectedModel.optionDescriptors.compactMap { descriptor -> PathwayModelOption? in
            guard let value = optionValues[descriptor.id] else { return nil }
            return PathwayModelOption(id: descriptor.id, value: value)
        }
        let selection = PathwayModelSelection(
            instanceId: selectedProvider.id,
            model: selectedModel.id,
            options: options.isEmpty ? nil : options
        )
        do {
            let result = try await rpc.request(
                "orchestration.launchThread",
                payload: PathwayAgentThreadCommands.launchThread(
                    PathwayThreadLaunchDraft(
                        projectID: binding.binding.localProjectId,
                        prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                        modelSelection: selection,
                        runtimeMode: runtimeMode,
                        interactionMode: interactionMode,
                        workspaceMode: workspaceMode,
                        baseReference: baseReference,
                        branch: branch,
                        startFromOrigin: startFromOrigin
                    )
                )
            )
            guard let threadID = result.objectValue?["threadId"]?.stringValue else {
                throw PathwayRPCError.protocolViolation(
                    "Pathway created the thread without returning its identifier."
                )
            }
            prompt = ""
            return threadID
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func setOption(_ descriptor: PathwayProviderOptionDescriptor, value: JSONValue) {
        optionValues[descriptor.id] = value
    }

    private func apply(_ value: JSONValue) {
        guard let object = value.objectValue, let type = object["type"]?.stringValue else { return }
        let providerValues: [JSONValue]
        switch type {
        case "snapshot":
            providerValues = object["config"]?.objectValue?["providers"]?.arrayValue ?? []
            applySettings(object["config"]?.objectValue?["settings"])
        case "providerStatuses", "configUpdated":
            providerValues = object["payload"]?.objectValue?["providers"]?.arrayValue ?? []
            applySettings(object["payload"]?.objectValue?["settings"])
        case "settingsUpdated":
            applySettings(object["payload"]?.objectValue?["settings"])
            return
        default:
            return
        }

        providers = providerValues.compactMap(Self.provider).filter { !$0.models.isEmpty }
        preserveOrSelectDefaults()
        connectionState = .live
    }

    private func applySettings(_ value: JSONValue?) {
        guard let settings = value?.objectValue else { return }
        // SwiftFormat places this brace on the next line for the wrapped condition.
        // swiftlint:disable opening_brace
        if let mode = settings["defaultThreadEnvMode"]?.stringValue,
           ["local", "worktree"].contains(mode)
        {
            workspaceMode = mode
        }
        // swiftlint:enable opening_brace
        if let value = settings["newWorktreesStartFromOrigin"]?.boolValue {
            startFromOrigin = value
        }
    }

    private func preserveOrSelectDefaults() {
        if !providers.contains(where: { $0.id == selectedProviderID }) {
            selectedProviderID = providers.first?.id ?? ""
            return
        }
        selectDefaultModelIfNeeded()
    }

    private func selectDefaultModel() {
        selectedModelID = selectedProvider?.models.first(where: \.isDefault)?.id
            ?? selectedProvider?.models.first?.id
            ?? ""
    }

    private func selectDefaultModelIfNeeded() {
        guard selectedProvider?.models.contains(where: { $0.id == selectedModelID }) != true else {
            return
        }
        selectDefaultModel()
    }

    private func selectDefaultOptions() {
        optionValues = [:]
        for descriptor in selectedModel?.optionDescriptors ?? [] {
            let defaultChoice = descriptor.choices.first(where: \.isDefault)
                ?? descriptor.choices.first(where: { $0.id == "medium" })
                ?? descriptor.choices.first
            if let value = descriptor.currentValue {
                optionValues[descriptor.id] = value
            } else if let choice = defaultChoice {
                optionValues[descriptor.id] = .string(choice.id)
            } else if descriptor.type == "boolean" {
                optionValues[descriptor.id] = .bool(false)
            }
        }
    }
}

private extension PathwayAgentThreadCreationModel {
    private static func provider(_ value: JSONValue) -> PathwayServerProvider? {
        guard
            let object = value.objectValue,
            let id = object["instanceId"]?.stringValue,
            let driver = object["driver"]?.stringValue,
            object["enabled"]?.boolValue == true,
            object["installed"]?.boolValue == true,
            object["availability"]?.stringValue != "unavailable"
        else { return nil }
        return PathwayServerProvider(
            id: id,
            driver: driver,
            name: object["displayName"]?.stringValue ?? displayName(for: driver),
            models: (object["models"]?.arrayValue ?? []).compactMap(model),
            showsInteractionMode: object["showInteractionModeToggle"]?.boolValue ?? false
        )
    }

    private static func model(_ value: JSONValue) -> PathwayServerModel? {
        guard
            let object = value.objectValue,
            let slug = object["slug"]?.stringValue,
            let name = object["name"]?.stringValue
        else { return nil }
        let descriptors = object["capabilities"]?.objectValue?["optionDescriptors"]?.arrayValue ?? []
        return PathwayServerModel(
            id: slug,
            name: name,
            isDefault: object["isDefault"]?.boolValue ?? false,
            optionDescriptors: descriptors.compactMap(optionDescriptor)
        )
    }

    private static func optionDescriptor(_ value: JSONValue) -> PathwayProviderOptionDescriptor? {
        guard
            let object = value.objectValue,
            let id = object["id"]?.stringValue,
            let label = object["label"]?.stringValue,
            let type = object["type"]?.stringValue
        else { return nil }
        let choices: [PathwayProviderOptionChoice] = (object["options"]?.arrayValue ?? [])
            .compactMap { value -> PathwayProviderOptionChoice? in
                guard
                    let choice = value.objectValue,
                    let id = choice["id"]?.stringValue,
                    let label = choice["label"]?.stringValue
                else { return nil }
                return PathwayProviderOptionChoice(
                    id: id,
                    label: label,
                    isDefault: choice["isDefault"]?.boolValue ?? false
                )
            }
        return PathwayProviderOptionDescriptor(
            id: id,
            label: label,
            type: type,
            choices: choices,
            currentValue: object["currentValue"]
        )
    }

    private static func displayName(for driver: String) -> String {
        switch driver {
        case "codex": "Codex"
        case "claudeAgent": "Claude"
        case "cursor": "Cursor"
        case "grok": "Grok"
        case "opencode": "OpenCode"
        default: driver
        }
    }
}
