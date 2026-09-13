import CryptoKit
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
    var unavailableReason: String? = nil
}

@MainActor
@Observable
final class PathwayAgentThreadCreationModel {
    private(set) var connectionState: PathwayThreadConnectionState = .idle
    private(set) var providers: [PathwayServerProvider] = []
    private(set) var serverConfig: [String: JSONValue] = [:]
    let attachments: PathwayNewThreadAttachments
    var workspaceRoot: String { binding?.binding.localWorkspaceRoot ?? "" }
    var bindingID: String { binding?.id ?? Self.conversationDraftKey(environment) }
    var isConversation: Bool { binding == nil }
    var supportsConversations: Bool {
        serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue?["threadConversations"]?.boolValue == true
    }
    private(set) var isLaunching = false
    private(set) var isImportingCapture = false
    private(set) var isTransferringDraft = false
    private(set) var errorMessage: String?
    var placementPinned = false { didSet { saveDraft() } }
    var isAutomaticPlacement = false
    @ObservationIgnored var automaticModelChoice: PathwayPlacementModelChoice?
    @ObservationIgnored var validatePlacement: (@MainActor () async throws -> Void)?

    var hasPendingLaunch: Bool { launchAttempt?.attachments != nil }
    var usesAutomaticPlacement: Bool {
        isAutomaticPlacement && !placementPinned && initialImageUploads.isEmpty && attachments.drafts.isEmpty
    }
    var canAutomaticallyPlace: Bool {
        connectionState == .live && prompt.isEmpty && initialImageUploads.isEmpty && attachments.drafts.isEmpty
            && workspaceMode == "local" && branch.isEmpty && launchAttempt == nil
            && !isLaunching && !isImportingCapture && !isTransferringDraft
    }
    var placementModelChoice: PathwayPlacementModelChoice? {
        guard let selectedProvider, let selectedModel else { return nil }
        return PathwayPlacementModelChoice(driver: selectedProvider.driver, model: selectedModel.id,
            options: optionValues, interactionMode: interactionMode, runtimeMode: runtimeMode)
    }
    /// Explicit Auto can release an old manual choice only before this draft is tied to a host.
    func prepareAutomaticPlacement() async -> Bool {
        guard canAutomaticallyPlace else { return false }
        let wasPinned = placementPinned
        placementPinned = false
        do {
            try await persistDraftChecked()
            return true
        } catch {
            placementPinned = wasPinned
            errorMessage = "The placement preference could not be saved. " + error.localizedDescription
            return false
        }
    }
    func activateAutomaticPlacement(choice: PathwayPlacementModelChoice?) {
        isAutomaticPlacement = true
        automaticModelChoice = choice
        if choice == nil { selectedProviderID = "" }
        applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object(serverConfig)]))
    }
    func pinPlacement() {
        placementPinned = true
        isAutomaticPlacement = false
        automaticModelChoice = nil
    }

    /// Images are persisted in the launch namespace before the initial turn references them.
    var initialImageUploads: [JSONValue] = [] {
        didSet {
            if initialImageUploads != oldValue {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let encoded = (try? encoder.encode(initialImageUploads)) ?? Data()
                uploadsFingerprint = initialImageUploads.isEmpty ? "" : SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
            }
            saveDraft()
        }
    }
    var prompt = "" { didSet { saveDraft() } }
    var selectedProviderID = "" {
        didSet {
            guard selectedProviderID != oldValue else { return }
            if selectedProvider?.showsInteractionMode != true {
                interactionMode = "default"
            }
            selectDefaultModel()
            saveDraft()
        }
    }

    var selectedModelID = "" {
        didSet {
            guard selectedModelID != oldValue else { return }
            selectDefaultOptions()
            saveDraft()
        }
    }

    var optionValues: [String: JSONValue] = [:] { didSet { saveDraft() } }
    var runtimeMode = "full-access" { didSet { saveDraft() } }
    var interactionMode = "default" { didSet { saveDraft() } }
    var workspaceMode = "local" { didSet { saveDraft() } }
    var baseReference = "main" { didSet { saveDraft() } }
    var branch = "" { didSet { saveDraft() } }
    var startFromOrigin = true { didSet { saveDraft() } }
    var temporary = false {
        didSet {
            if temporary && !isConversation { workspaceMode = "worktree" }
            saveDraft()
        }
    }

    @ObservationIgnored private let binding: PathwayCompanyEnvironmentBinding?
    @ObservationIgnored private let environment: PathwayCompanyEnvironment
    typealias Request = @MainActor (String, JSONValue) async throws -> JSONValue
    typealias DraftSave = @MainActor (PathwayThreadCreationDraft, UInt64) async throws -> Void
    @ObservationIgnored let storageDirectory: URL?
    @ObservationIgnored private let draftStore: PathwayThreadCreationDraftStore?
    @ObservationIgnored private var draftWriteTask: Task<Void, Never>?
    @ObservationIgnored private var pendingDraft: PathwayThreadCreationDraft?
    @ObservationIgnored private var uploadsFingerprint = ""
    @ObservationIgnored private var sentAttachmentIDs: [String] = []
    @ObservationIgnored private var importedCaptureIDs: [UUID] = []
    @ObservationIgnored private var launchAttempt: PathwayThreadLaunchAttempt?
    @ObservationIgnored private var didRestoreDraft = false
    @ObservationIgnored private var hasConfiguredDefaults = false
    @ObservationIgnored private let injectedRequest: Request?
    @ObservationIgnored private let injectedDraftSave: DraftSave?
    @ObservationIgnored private let connect: PathwayConnectClient?
    @ObservationIgnored private var rpc: PathwayRPCClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?

    init(
        binding: PathwayCompanyEnvironmentBinding? = nil,
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient? = nil,
        storageDirectory: URL? = nil,
        request: Request? = nil,
        saveDraft: DraftSave? = nil
    ) {
        let draftKey = binding?.id ?? Self.conversationDraftKey(environment)
        attachments = PathwayNewThreadAttachments(directory: storageDirectory, key: draftKey)
        self.binding = binding
        self.environment = environment
        self.connect = connect
        self.storageDirectory = storageDirectory
        injectedRequest = request
        injectedDraftSave = saveDraft
        draftStore = storageDirectory.map { PathwayThreadCreationDraftStore(directory: $0, key: draftKey) }
        attachments.request = { [weak self] method, payload in
            guard let self else { throw PathwayRPCError.disconnected }
            return try await self.request(method, payload: payload)
        }
        attachments.uploadRequest = { [weak self] path in
            guard let self, let connect = self.connect else { throw PathwayRPCError.disconnected }
            return try await connect.authenticatedRequest(environment: self.environment, method: "PUT", path: path)
        }
    }

    deinit {
        streamTask?.cancel()
        draftWriteTask?.cancel()
        if let pendingDraft, let draftStore {
            let revision = DispatchTime.now().uptimeNanoseconds
            Task { try? await draftStore.save(pendingDraft, revision: revision) }
        }
        if let rpc {
            Task { await rpc.stop() }
        }
    }

    var selectedProvider: PathwayServerProvider? {
        providers.first { $0.id == selectedProviderID }
    }

    nonisolated static func conversationDraftKey(_ environment: PathwayCompanyEnvironment) -> String {
        "conversation:\(environment.id)"
    }

    var selectedModel: PathwayServerModel? {
        selectedProvider?.models.first { $0.id == selectedModelID }
    }

    var storageAllowsLaunch = true
    private var continuedDespiteCriticalStorage = false

    func continueDespiteCriticalStorage() {
        continuedDespiteCriticalStorage = true
        storageAllowsLaunch = true
    }

    /// Every launch entry point checks the destination before persisting attachments or starting work.
    func checkStorageBeforeLaunch() async -> Bool {
        guard connectionState == .live else {
            errorMessage = "Connect to the environment before starting work."
            return false
        }
        guard serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue?["storageManagement"]?.boolValue == true else { return true }
        do {
            let snapshot = try await request("storage.snapshot", payload: .object([:]))
            guard let fields = snapshot.objectValue, Self.storageMeasurementIsFresh(fields["sampledAt"]?.stringValue),
                  let volumes = fields["volumes"]?.arrayValue else { return true }
            let critical = volumes.contains {
                $0.objectValue?["pressure"]?.stringValue == "critical"
                    && Self.storageMeasurementIsFresh($0.objectValue?["sampledAt"]?.stringValue)
            }
            if !critical { continuedDespiteCriticalStorage = false }
            guard !critical || continuedDespiteCriticalStorage else {
                storageAllowsLaunch = false
                errorMessage = "This environment is critically low on storage. Free up space or choose Continue anyway before starting work."
                return false
            }
            return true
        } catch {
            // Missing telemetry is advisory; the storage notice exposes unavailable readings.
            return true
        }
    }

    private static func storageMeasurementIsFresh(_ value: String?) -> Bool {
        guard let value else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let measured = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return false }
        let age = Date().timeIntervalSince(measured)
        return age >= -5 && age <= 120
    }

    var canLaunch: Bool {
        (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !initialImageUploads.isEmpty || !attachments.drafts.isEmpty)
            && prompt.count <= 120_000 && attachments.isReady && initialImageUploads.count + attachments.drafts.count <= 8
            && automaticModelChoice == nil
            && selectedProvider != nil
            && selectedModel != nil
            && (!(isConversation || temporary) || supportsConversations)
            && connectionState == .live
            && storageAllowsLaunch
            && !isLaunching && !isImportingCapture && !isTransferringDraft
            && (isConversation || (workspaceMode != "worktree" && !temporary)
                || !baseReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func start() {
        guard streamTask == nil, let connect else { return }
        connectionState = .connecting
        let environment = environment
        let rpc = PathwayRPCClient {
            try await connect.prepare(environment: environment).threadOperationWebSocketURL()
        }
        self.rpc = rpc
        streamTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await restoreDraft()
            guard !Task.isCancelled else { return }
            do {
                let stream = await rpc.subscribe("subscribeServerConfig", payload: .object([:]))
                for try await value in stream {
                    guard !Task.isCancelled else { return }
                    applySubscriptionValue(value)
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
        connectionState = .idle
        attachments.isConnected = false
        await attachments.persist()
        await persistDraftNow()
        await rpc?.stop()
        rpc = nil
    }

    func launch() async -> String? {
        guard canLaunch, storageAllowsLaunch, rpc != nil || injectedRequest != nil, let selectedProvider, let selectedModel else { return nil }
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
            if usesAutomaticPlacement, launchAttempt == nil { try await validatePlacement?() }
            try Task.checkCancellation()
            guard await checkStorageBeforeLaunch() else { return nil }
            try Task.checkCancellation()
            let userUploads = attachments.uploads
            let selectedAttachmentIDs = Set(attachments.drafts.map(\.id))
            let initialUploads = initialImageUploads
            let uploads = initialUploads + userUploads
            let draft = PathwayThreadLaunchDraft(
                projectID: binding?.binding.localProjectId,
                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                modelSelection: selection, runtimeMode: runtimeMode, interactionMode: interactionMode,
                workspaceMode: workspaceMode, baseReference: baseReference, branch: branch,
                startFromOrigin: startFromOrigin, temporary: temporary,
                conversationCompanyID: isConversation ? environment.companyId : nil
            )
            var fingerprint = PathwayAgentThreadCommands.launchThread(draft, identifier: "draft").objectValue ?? [:]
            fingerprint["uploadsFingerprint"] = .object(["initial": .string(uploadsFingerprint), "files": .array(userUploads)])
            let signature = JSONValue.object(fingerprint)
            try await attachments.revalidatePendingUploads(
                preservingPreparedUploadIDs: launchAttempt?.fingerprint == signature ? claimedUploadIDs : [])
            guard attachments.isReady else {
                throw PathwayThreadConversationError.message("An attachment upload has expired. Tap retry to upload its saved bytes again.")
            }
            if launchAttempt?.fingerprint != signature {
                launchAttempt = PathwayThreadLaunchAttempt(fingerprint: signature)
            }
            guard let attempt = launchAttempt else { return nil }
            await persistDraftNow()
            if attempt.attachments == nil {
                let attachments: [JSONValue]
                if uploads.isEmpty { attachments = [] }
                else {
                    let persisted = try await request("assets.persistChatAttachments", payload: .object([
                        "threadId": .string(attempt.threadID), "messageId": .string(attempt.identifier),
                        "attachments": .array(uploads)
                    ]))
                    guard let result = persisted.objectValue?["attachments"]?.arrayValue,
                          result.count == uploads.count else {
                        throw PathwayRPCError.protocolViolation("The attachments could not be prepared for this thread.")
                    }
                    attachments = result
                }
                launchAttempt?.attachments = attachments
                await persistDraftNow()
            }
            guard let prepared = launchAttempt else { return nil }
            let result = try await request("orchestration.launchThread", payload: prepared.launchPayload())
            guard let threadID = result.objectValue?["threadId"]?.stringValue else {
                throw PathwayRPCError.protocolViolation(
                    "Pathway created the thread without returning its identifier."
                )
            }
            // A user may have edited the next draft while this request was in flight.
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines) == draft.prompt { prompt = "" }
            if initialImageUploads == initialUploads { initialImageUploads = [] }
            launchAttempt = nil
            placementPinned = false
            sentAttachmentIDs = Array(selectedAttachmentIDs)
            // Record accepted attachment IDs before clearing their separate local byte store.
            // Relaunch can finish this cleanup without exposing already-sent files as a new draft.
            await persistDraftNow()
            await attachments.didSend(ids: selectedAttachmentIDs)
            sentAttachmentIDs = []
            await persistDraftNow()
            continuedDespiteCriticalStorage = false
            return threadID
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func setOption(_ descriptor: PathwayProviderOptionDescriptor, value: JSONValue) {
        optionValues[descriptor.id] = value
    }

    func applySubscriptionValue(_ value: JSONValue) {
        guard let object = value.objectValue else { return }
        if object["_pathwayTransport"] != nil { connectionState = .connecting; attachments.isConnected = false; return }
        guard let type = object["type"]?.stringValue else { return }
        let providerValues: [JSONValue]
        switch type {
        case "snapshot":
            serverConfig = object["config"]?.objectValue ?? [:]
            applyAttachmentCapabilities()
            providerValues = serverConfig["providers"]?.arrayValue ?? []
            applySettings(object["config"]?.objectValue?["settings"])
        case "providerStatuses", "configUpdated":
            for (key, value) in object["payload"]?.objectValue ?? [:] { serverConfig[key] = value }
            applyAttachmentCapabilities()
            providerValues = serverConfig["providers"]?.arrayValue ?? []
            applySettings(object["payload"]?.objectValue?["settings"])
        case "settingsUpdated":
            applySettings(object["payload"]?.objectValue?["settings"])
            return
        default:
            return
        }

        providers = isAutomaticPlacement ? PathwayEnvironmentPlacement.availableProviders(.object(serverConfig))
            : providerValues.compactMap(PathwayAgentThreadModel.provider).filter { $0.unavailableReason == nil && !$0.models.isEmpty }
        if let choice = automaticModelChoice {
            if let provider = choice.provider(in: providers) {
                selectedProviderID = provider.id
                selectedModelID = choice.model
                optionValues = choice.options
                interactionMode = choice.interactionMode
                runtimeMode = choice.runtimeMode
                automaticModelChoice = nil
                errorMessage = nil
            } else {
                errorMessage = "The requested model is no longer available. Choose an environment or model manually."
            }
        } else if !isAutomaticPlacement || selectedProviderID.isEmpty {
            preserveOrSelectDefaults()
        }
        connectionState = .live
        attachments.isConnected = true
    }

    private func applyAttachmentCapabilities() {
        let capabilities = serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue ?? [:]
        attachments.supportsUploads = capabilities["attachmentUploads"]?.boolValue == true
        attachments.maximumFileBytes = capabilities["fileAttachments"]?.objectValue?["maxUploadBytes"]?.intValue
    }

    func request(_ method: String, payload: JSONValue) async throws -> JSONValue {
        guard connectionState == .live else { throw PathwayRPCError.disconnected }
        if let injectedRequest { return try await injectedRequest(method, payload) }
        guard let rpc else { throw PathwayRPCError.disconnected }
        return try await rpc.request(method, payload: payload, requiresSubscription: true, waitForSubscription: false)
    }

    func restoreDraft() async {
        guard !didRestoreDraft else { return }
        didRestoreDraft = true
        var sentIDs: [String] = []
        if let draftStore, let stored = await draftStore.load(), prompt.isEmpty, initialImageUploads.isEmpty {
            hasConfiguredDefaults = true
            importedCaptureIDs = stored.importedCaptureIDs ?? []
            prompt = stored.prompt; initialImageUploads = stored.initialImageUploads
            selectedProviderID = stored.selectedProviderID; selectedModelID = stored.selectedModelID
            optionValues = stored.optionValues; runtimeMode = stored.runtimeMode; interactionMode = stored.interactionMode
            workspaceMode = stored.workspaceMode; baseReference = stored.baseReference
            temporary = stored.temporary ?? false
            branch = stored.branch; startFromOrigin = stored.startFromOrigin; launchAttempt = stored.attempt
            placementPinned = stored.placementPinned ?? false
            sentIDs = stored.sentAttachmentIDs ?? []
        }
        // The byte store needs the launch receipt before deciding whether an old upload is reusable.
        await attachments.restore(preservingPreparedUploadIDs: claimedUploadIDs)
        if !sentIDs.isEmpty { await attachments.didSend(ids: Set(sentIDs)) }
    }

    private var claimedUploadIDs: Set<String> {
        guard let launchAttempt, launchAttempt.attachments != nil else { return [] }
        return Set((launchAttempt.fingerprint.objectValue?["uploadsFingerprint"]?.objectValue?["files"]?.arrayValue ?? [])
            .compactMap { $0.objectValue?["id"]?.stringValue })
    }

    /// Move editable incoming content only after the empty destination has durably accepted it.
    /// Upload handles and launch receipts remain tied to their original environment.
    func transferIncomingDraft(to destination: PathwayAgentThreadCreationModel) async throws {
        guard !isLaunching, !isImportingCapture, !isTransferringDraft, launchAttempt?.attachments == nil else {
            throw PathwayThreadConversationError.message("This draft has a pending launch or import. Finish it in the current project before switching.")
        }
        guard storageDirectory == destination.storageDirectory, initialImageUploads.isEmpty else {
            throw PathwayThreadConversationError.message("This draft cannot be moved to that project. Keep it in the current project.")
        }
        isTransferringDraft = true
        defer { isTransferringDraft = false }
        await destination.restoreDraft()
        guard destination.prompt.isEmpty, destination.initialImageUploads.isEmpty,
              destination.attachments.drafts.isEmpty, destination.launchAttempt == nil else {
            throw PathwayThreadConversationError.message("That project already has an unsent draft. Finish or clear it separately before moving this draft.")
        }
        try Task.checkCancellation()
        let movingPrompt = prompt
        let movingAttachments = attachments.drafts
        try await destination.attachments.stageTransfer(drafts: movingAttachments, bytes: attachments.bytes)
        destination.prompt = movingPrompt
        destination.temporary = temporary
        destination.importedCaptureIDs = importedCaptureIDs
        try await destination.persistDraftChecked()
        try Task.checkCancellation()
        guard !isLaunching, !isImportingCapture, launchAttempt?.attachments == nil,
              prompt == movingPrompt, attachments.drafts == movingAttachments else {
            throw PathwayThreadConversationError.message("The draft changed during the move. Your latest edits remain in the original project.")
        }
        // The destination is saved. Clearing local source bytes must not delete remote uploads.
        prompt = ""
        launchAttempt = nil
        importedCaptureIDs = []
        await persistDraftNow()
        await attachments.didSend(ids: Set(movingAttachments.map(\.id)))
    }

    private func draftSnapshot() -> PathwayThreadCreationDraft {
        PathwayThreadCreationDraft(prompt: prompt, initialImageUploads: initialImageUploads,
            selectedProviderID: selectedProviderID, selectedModelID: selectedModelID, optionValues: optionValues,
            runtimeMode: runtimeMode, interactionMode: interactionMode, workspaceMode: workspaceMode,
            baseReference: baseReference, branch: branch, startFromOrigin: startFromOrigin, attempt: launchAttempt, sentAttachmentIDs: sentAttachmentIDs.isEmpty ? nil : sentAttachmentIDs, importedCaptureIDs: importedCaptureIDs.isEmpty ? nil : importedCaptureIDs, placementPinned: placementPinned ? true : nil, temporary: temporary)
    }

    private func saveDraft() {
        guard draftStore != nil else { return }
        pendingDraft = draftSnapshot()
        guard draftWriteTask == nil else { return }
        draftWriteTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await self?.persistDraftNow()
        }
    }

    func persistDraftNow() async {
        do { try await persistDraftChecked() }
        catch { errorMessage = "The draft could not be saved on this device. " + error.localizedDescription }
    }

    private func persistDraftChecked() async throws {
        draftWriteTask?.cancel(); draftWriteTask = nil
        guard didRestoreDraft || pendingDraft != nil else { return }
        pendingDraft = nil
        let revision = DispatchTime.now().uptimeNanoseconds
        if let injectedDraftSave { try await injectedDraftSave(draftSnapshot(), revision) }
        else if let draftStore { try await draftStore.save(draftSnapshot(), revision: revision) }
    }

    func importCapturedDraft(_ draft: PathwayCapturedDraft, store: PathwayCaptureStore) async -> Bool {
        guard !isLaunching, !isImportingCapture, !isTransferringDraft, storageDirectory?.lastPathComponent == draft.accountKey else { return false }
        isImportingCapture = true
        defer { isImportingCapture = false }
        do {
            await restoreDraft()
            guard try await store.activeAccount() == draft.accountKey else { throw PathwayCaptureError.accountChanged }
            if importedCaptureIDs.contains(draft.id) { try await persistDraftChecked(); return true }
            let combined = [prompt, draft.prompt].filter { !$0.isEmpty }.joined(separator: "\n\n")
            guard combined.count <= 120_000 else { throw PathwayCaptureError.invalidInput }
            for file in draft.attachments {
                try Task.checkCancellation()
                let original = try await store.data(for: file, in: draft)
                let image = try await PathwayImageUpload.prepare(data: original, name: file.name, mimeType: file.mimeType)
                let data = image.data
                if !attachments.drafts.contains(where: { $0.name == image.name && $0.mimeType == image.mimeType && attachments.bytes[$0.id] == data }) {
                    await attachments.add(data: data, name: image.name, mimeType: image.mimeType)
                }
                guard attachments.drafts.contains(where: { $0.name == image.name && $0.mimeType == image.mimeType && attachments.bytes[$0.id] == data }) else {
                    throw PathwayThreadConversationError.message(attachments.errorMessage ?? "The shared attachment could not be imported.")
                }
            }
            try Task.checkCancellation()
            guard try await store.activeAccount() == draft.accountKey else { throw PathwayCaptureError.accountChanged }
            try await attachments.persistChecked()
            // Prompt and import receipt share one atomic manifest. Retrying after a crash cannot append twice.
            importedCaptureIDs.append(draft.id)
            prompt = combined
            try await persistDraftChecked()
            return true
        } catch is CancellationError { return false }
        catch { errorMessage = error.localizedDescription; return false }
    }

    private func applySettings(_ value: JSONValue?) {
        guard !hasConfiguredDefaults, let settings = value?.objectValue else { return }
        hasConfiguredDefaults = true
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
