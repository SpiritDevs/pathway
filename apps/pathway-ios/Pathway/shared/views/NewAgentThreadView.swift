import SwiftUI

struct NewAgentThreadView: View {
    var onClose: (() -> Void)? = nil
    var initialPrompt: String = ""
    var threadDefaults: PathwayNewThreadDefaults? = nil
    var capturedDraft: PathwayCapturedDraft? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel

    @State private var selectedProjectID: String?
    @State private var selectedBindingID = ""
    @State private var model: PathwayAgentThreadCreationModel?
    @State private var appliedInitialPrompt = false
    @State private var appliedThreadSelection = false
    @State private var appliedThreadSettings = false
    @State private var appliedCapture = false
    @State private var selectionError: String?
    @State private var placementPreferences = PathwayEnvironmentPlacementPreferences.shared
    @State private var placementRequestID: UUID?
    @State private var isResolvingPlacement = false
    @State private var automaticBindingID: String?
    @State private var pendingPlacementChoice: PathwayPlacementModelChoice?
    @State private var placementMessage: String?
    @State private var placementUnavailable = false
    @State private var placementResetsPin = false

    var body: some View {
        NavigationStack {
            Group {
                if appModel.connect == nil {
                    unavailable(
                        title: "Pathway Connect unavailable",
                        message: "This build is missing its Pathway Connect configuration."
                    )
                } else if projectOptions.isEmpty {
                    unavailable(
                        title: "No connected environments",
                        message: "Connect an environment to start a conversation or project thread."
                    )
                } else if let selectedProject {
                    NewAgentThreadComposer(
                        project: selectedProject,
                        model: model,
                        selectedBindingID: $selectedBindingID,
                        automaticPlacementEnabled: placementPreferences.enabled,
                        isResolvingPlacement: isResolvingPlacement,
                        placementMessage: placementMessage,
                        placementUnavailable: placementUnavailable,
                        chooseAutomaticPlacement: { requestAutomaticPlacement(resetPin: true) },
                        chooseEnvironment: { id in
                            automaticBindingID = nil
                            pendingPlacementChoice = nil
                            model?.automaticModelChoice = nil
                            placementMessage = nil
                            placementUnavailable = false
                            model?.isAutomaticPlacement = false
                            selectedBindingID = id
                        },
                        chooseProject: { selectedProjectID = nil },
                        didLaunch: didLaunch
                    )
                    .disabled(isChangingBinding)
                } else {
                    PathwayNewThreadProjectPicker(
                        projects: projectOptions,
                        select: selectProject
                    )
                }
            }
            .navigationTitle(selectedProjectID == nil ? "Choose Project" : selectedProject?.isConversation == true ? "New Conversation" : "New Agent Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: close)
                        .disabled(isChangingBinding)
                }
                if capturedDraft != nil, !appliedCapture, let model, model.errorMessage != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Retry Import") { Task { await applyIncomingDraft() } }
                            .disabled(model.connectionState != .live || model.isImportingCapture || isChangingBinding)
                    }
                }
            }
        }
        .interactiveDismissDisabled(isChangingBinding)
        .task(id: "\(selectedBindingID):\(isResolvingPlacement)") {
            if !appliedThreadSelection, let defaults = threadDefaults {
                appliedThreadSelection = true
                if let option = bindingOptions.first(where: {
                    $0.environment.companyId == defaults.companyID
                        && $0.environment.environment.environmentId == defaults.environmentID
                        && $0.binding?.binding.localProjectId == defaults.projectID
                }), let project = projectOptions.first(where: { $0.bindings.contains { $0.id == option.id } }) {
                    selectedProjectID = project.id
                    selectedBindingID = option.id
                    return
                }
                selectionError = "This thread's project or environment is unavailable. Choose where to start the new thread."
            }
            await configureSelection()
        }
        .task(id: placementRequestID) {
            if placementRequestID != nil { await resolveAutomaticPlacement() }
        }
        .task(id: model?.connectionState) {
            await applyIncomingDraft()
        }
        .onDisappear {
            let departing = model
            Task { await departing?.stop() }
        }
        .alert("Couldn't configure new thread", isPresented: Binding(get: { selectionError != nil }, set: { if !$0 { selectionError = nil } })) {
            Button("OK", role: .cancel) { selectionError = nil }
        } message: { Text(selectionError ?? "") }
    }

    private var isChangingBinding: Bool {
        if isResolvingPlacement { return true }
        guard let model else { return false }
        return model.isTransferringDraft || model.bindingID != selectedBindingID
    }

    private var bindingOptions: [PathwayNewThreadBindingOption] {
        let projects: [PathwayNewThreadBindingOption] = appModel.cloud.environmentBindings.compactMap { binding in
            guard
                let environment = appModel.cloud.environments.first(where: {
                    $0.companyId == binding.companyId
                        && $0.environment.environmentId == binding.binding.environmentId
                }),
                let project = appModel.cloud.projects.first(where: {
                    $0.companyId == binding.companyId
                        && $0.project.id == binding.binding.cloudProjectId
                })
            else { return nil }
            return PathwayNewThreadBindingOption(
                binding: binding,
                environment: environment,
                projectID: project.project.id,
                projectName: project.project.name,
                companyName: appModel.cloud.companyName(for: binding.companyId) ?? "Pathway"
            )
        }.sorted {
            $0.label.localizedStandardCompare($1.label) == .orderedAscending
        }
        let conversations = appModel.cloud.environments.filter {
            $0.environment.descriptor.capabilities?["threadConversations"]?.boolValue == true
        }.map { environment in
            PathwayNewThreadBindingOption(binding: nil, environment: environment, projectID: nil,
                projectName: "Conversation", companyName: appModel.cloud.companyName(for: environment.companyId) ?? "Pathway")
        }
        return projects + conversations
    }

    private var projectOptions: [PathwayNewThreadProjectOption] {
        let groups = Dictionary(grouping: bindingOptions.filter { $0.projectID != nil }) { option in
            "\(option.environment.companyId):\(option.projectID ?? "")"
        }
        var projects: [PathwayNewThreadProjectOption] = groups.compactMap { id, bindings in
            guard let first = bindings.first else { return nil }
            return PathwayNewThreadProjectOption(
                id: id,
                name: first.projectName,
                companyName: first.companyName,
                bindings: bindings
            )
        }.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        let conversations = bindingOptions.filter { $0.projectID == nil }
        if !conversations.isEmpty {
            projects.append(PathwayNewThreadProjectOption(id: "conversation", name: "Conversation", companyName: "", bindings: conversations))
        }
        return projects
    }

    private var selectedProject: PathwayNewThreadProjectOption? {
        projectOptions.first { $0.id == selectedProjectID }
    }

    private func selectProject(_ project: PathwayNewThreadProjectOption) {
        automaticBindingID = nil
        pendingPlacementChoice = nil
        placementMessage = nil
        placementUnavailable = false
        selectedProjectID = project.id
        if !project.bindings.contains(where: { $0.id == selectedBindingID }) {
            selectedBindingID = project.bindings.first?.id ?? ""
        }
        if !project.isConversation, placementPreferences.enabled, project.bindings.count > 1 { requestAutomaticPlacement() }
    }

    private func requestAutomaticPlacement(resetPin: Bool = false) {
        guard selectedProject?.isConversation != true, model?.hasPendingLaunch != true, model?.isLaunching != true else { return }
        placementResetsPin = resetPin
        isResolvingPlacement = true
        placementMessage = nil
        placementRequestID = UUID()
    }

    private func resolveAutomaticPlacement() async {
        let requestID = placementRequestID
        let projectID = selectedProjectID
        let preferred = selectedBindingID
        guard let project = selectedProject else { isResolvingPlacement = false; return }
        if placementResetsPin, let model, model.bindingID == preferred {
            guard await model.prepareAutomaticPlacement() else {
                guard !Task.isCancelled, requestID == placementRequestID, projectID == selectedProjectID else { return }
                isResolvingPlacement = false
                return
            }
        }
        guard !Task.isCancelled, requestID == placementRequestID, projectID == selectedProjectID else { return }
        let choice = model?.bindingID == preferred ? model?.placementModelChoice : nil
        let hasSavedDraft = await PathwayEnvironmentPlacement.hasSavedDraft(bindingID: preferred, directory: appModel.localStorageDirectory)
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: project.bindings,
            preferredBindingID: preferred, choice: choice, preferences: placementPreferences,
            directory: appModel.localStorageDirectory) { environment in
                try await appModel.cloud.environmentPlacementSnapshot(environment: environment)
            }
        guard !Task.isCancelled, requestID == placementRequestID, projectID == selectedProjectID else { return }
        if let winner, let current = selectedProject?.bindings.first(where: { $0.id == winner }),
           (current.binding?.binding.status ?? current.environment.environment.state) == "active", placementPreferences.enabled,
           placementPreferences.weight(for: current.environment.environment.environmentId) > 0 {
            automaticBindingID = winner
            placementUnavailable = false
            pendingPlacementChoice = model?.bindingID == winner ? nil : choice
            selectedBindingID = winner
            if model?.bindingID == winner {
                model?.activateAutomaticPlacement(choice: choice)
            } else {
                model?.isAutomaticPlacement = false
            }
        } else {
            automaticBindingID = nil
            pendingPlacementChoice = nil
            model?.isAutomaticPlacement = false
            placementUnavailable = !hasSavedDraft && placementPreferences.enabled
            placementMessage = placementUnavailable ? "Auto could not find an available environment. Choose an environment manually to continue." : nil
        }
        isResolvingPlacement = false
    }

    private func configureSelection() async {
        guard !isResolvingPlacement, model?.bindingID != selectedBindingID else { return }
        let requestedBindingID = selectedBindingID
        let departing = model
        guard
            let option = bindingOptions.first(where: { $0.id == selectedBindingID }),
            let connect = appModel.connect
        else { return }
        let nextModel = PathwayAgentThreadCreationModel(
            binding: option.binding,
            environment: option.environment,
            connect: connect,
            storageDirectory: appModel.localStorageDirectory
        )
        nextModel.threadQueue = appModel.cloud.threadQueue
        if let departing, appliedInitialPrompt || appliedCapture {
            do { try await departing.transferIncomingDraft(to: nextModel) }
            catch {
                guard !Task.isCancelled, selectedBindingID == requestedBindingID else { return }
                selectionError = error.localizedDescription
                selectedBindingID = departing.bindingID
                if let previous = projectOptions.first(where: { $0.bindings.contains { $0.id == departing.bindingID } }) {
                    selectedProjectID = previous.id
                }
                return
            }
        }
        await departing?.stop()
        guard !Task.isCancelled, selectedBindingID == requestedBindingID else { return }
        nextModel.isAutomaticPlacement = automaticBindingID == requestedBindingID
        nextModel.automaticModelChoice = pendingPlacementChoice
        pendingPlacementChoice = nil
        let cloud = appModel.cloud
        let preferences = placementPreferences
        nextModel.validatePlacement = { [weak cloud, weak nextModel] in
            guard let cloud, let nextModel else { throw PathwayRPCError.disconnected }
            if let binding = option.binding {
                guard cloud.environmentBindings.contains(where: {
                    $0.id == binding.id && $0.binding.status == "active"
                        && $0.binding.localProjectId == binding.binding.localProjectId
                        && $0.binding.localWorkspaceRoot == binding.binding.localWorkspaceRoot
                }) else { throw PathwayThreadConversationError.message("This project is no longer available in the selected environment.") }
            } else {
                guard cloud.environments.contains(where: {
                    $0.id == option.environment.id && $0.environment.state == "active"
                        && $0.environment.descriptor.capabilities?["threadConversations"]?.boolValue == true
                }) else { throw PathwayThreadConversationError.message("Conversations are no longer available in the selected environment.") }
            }
            guard preferences.enabled else { return }
            let weight = preferences.weight(for: option.environment.environment.environmentId)
            let selection = nextModel.placementModelChoice
            let instanceID = nextModel.selectedProviderID
            let snapshot = try await cloud.environmentPlacementSnapshot(environment: option.environment)
            let providers = PathwayEnvironmentPlacement.availableProviders(snapshot.config).filter { $0.id == instanceID }
            guard selection?.provider(in: providers) != nil, nextModel.selectedProviderID == instanceID else {
                throw PathwayThreadConversationError.message("The selected account or model is no longer available. Choose a model manually to continue.")
            }
            let resources = try JSONDecoder().decode(PathwayHostResources.self, from: JSONEncoder().encode(snapshot.resources))
            let now = ProcessInfo.processInfo.systemUptime
            guard resources.score(weight: weight, receivedAt: snapshot.receivedAt, now: now) != nil else {
                throw PathwayThreadConversationError.message("The selected environment is busy or unavailable. Choose an environment manually to continue with this draft.")
            }
        }
        model = nextModel
        nextModel.start()
    }

    private func applyIncomingDraft() async {
        guard let model, model.connectionState == .live else { return }
        await model.restoreDraft()
        guard !Task.isCancelled, !isResolvingPlacement else { return }
        await model.attachments.prepareTransferredAttachments()
        guard !Task.isCancelled else { return }
        if !appliedThreadSettings, let defaults = threadDefaults {
            appliedThreadSettings = true
            do {
                try model.applyThreadDefaults(defaults)
                await model.persistDraftNow()
            } catch { selectionError = error.localizedDescription }
        }
        if !appliedInitialPrompt, !initialPrompt.isEmpty {
            let combined = [model.prompt, initialPrompt].filter { !$0.isEmpty }.joined(separator: "\n\n")
            if combined.count <= 120_000 {
                model.prompt = combined
                await model.persistDraftNow()
                appliedInitialPrompt = true
            }
        }
        if !appliedCapture, let capturedDraft, let store = PathwayCaptureInbox.shared.store {
            if await model.importCapturedDraft(capturedDraft, store: store) {
                appliedCapture = true
            }
        }
    }

    private func close() {
        if let onClose { onClose() } else { dismiss() }
    }

    private func didLaunch(threadID: String) {
        if appliedCapture, let capturedDraft {
            Task { await PathwayCaptureInbox.shared.remove(capturedDraft) }
        }
        if let option = bindingOptions.first(where: { $0.id == selectedBindingID }) {
            appModel.pendingThreadRoute = PathwayPendingThreadRoute(
                companyId: option.environment.companyId,
                environmentId: option.environment.environment.environmentId,
                threadId: threadID
            )
        }
        close()
    }

    private func unavailable(title: String, message: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: "network.slash")
        } description: {
            Text(message)
        } actions: {
            Button("Refresh") {
                Task { await appModel.cloud.retry() }
            }
        }
    }
}

private struct NewAgentThreadComposer: View {
    @Environment(PathwayAppModel.self) private var appModel
    let project: PathwayNewThreadProjectOption
    let model: PathwayAgentThreadCreationModel?
    @Binding var selectedBindingID: String
    let automaticPlacementEnabled: Bool
    let isResolvingPlacement: Bool
    let placementMessage: String?
    let placementUnavailable: Bool
    let chooseAutomaticPlacement: () -> Void
    let chooseEnvironment: (String) -> Void
    let chooseProject: () -> Void
    let didLaunch: (String) -> Void

    @FocusState private var promptFocused: Bool
    @State private var showsOptions = false
    @State private var showsBranches = false

    var body: some View {
        ZStack {
            Color.clear

            VStack(spacing: 12) {
                Spacer(minLength: 54)

                Text(project.isConversation ? "What’s on your mind" : "What should we build")
                    .font(.largeTitle.weight(.regular))

                Button(action: chooseProject) {
                    HStack(spacing: 5) {
                        Text(project.isConversation ? "Conversation" : "in \(project.name)?")
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.bold))
                    }
                    .font(.largeTitle.weight(.regular))
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .disabled(model?.isLaunching == true || model?.hasPendingLaunch == true)
                .accessibilityLabel("Choose project")
                .accessibilityValue(project.name)

                environmentPicker

                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 4) {
                if let model {
                    if let selectedBinding, let connect = appModel.connect {
                        PathwayConversationStorageNotice(environment: selectedBinding.environment, connect: connect,
                            chooseEnvironment: chooseProject, onContinueAnyway: { model.continueDespiteCriticalStorage() }, onAvailabilityChanged: { model.storageAllowsLaunch = $0 }).id(selectedBinding.id)
                    }
                    if !model.isConversation { workspaceSummary(model) }
                    composer(model).disabled(model.isImportingCapture || isResolvingPlacement || placementUnavailable)
                } else {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Connecting to \(selectedBinding?.label ?? "environment")…")
                    }
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 110)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .background(.background)
        }
        .sheet(isPresented: $showsBranches) {
            if let model { NewAgentThreadBranchPicker(model: model).presentationDetents([.medium, .large]) }
        }
    }

    private var selectedBinding: PathwayNewThreadBindingOption? {
        project.bindings.first { $0.id == selectedBindingID }
    }

    private var environmentPicker: some View {
        Menu {
            if automaticPlacementEnabled && !project.isConversation {
                Button("Auto", action: chooseAutomaticPlacement)
                    .disabled(model?.canAutomaticallyPlace == false)
                if model?.placementPinned == true, model?.canAutomaticallyPlace == true {
                    Text("Auto may choose a compatible account on another machine.")
                }
            }
            Section(project.isConversation ? "Environments" : "Project environments") {
                ForEach(project.bindings) { binding in
                    Button {
                        chooseEnvironment(binding.id)
                    } label: {
                        if binding.id == selectedBindingID {
                            Label(binding.label, systemImage: "checkmark")
                        } else {
                            Text(binding.label)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "desktopcomputer")
                Text(isResolvingPlacement ? "Choosing environment…"
                    : "\(model?.usesAutomaticPlacement == true && automaticPlacementEnabled ? "Auto · " : "")\(selectedBinding?.label ?? "Choose environment")")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(isResolvingPlacement || model?.isLaunching == true || model?.hasPendingLaunch == true)
        .accessibilityLabel("Choose environment")
        .accessibilityValue(selectedBinding?.label ?? "Not selected")
        .accessibilityHint("Chooses where the new thread will run")
    }

    private func workspaceSummary(_ model: PathwayAgentThreadCreationModel) -> some View {
        HStack(spacing: 14) {
            Button {
                model.pinPlacement()
                model.workspaceMode = model.workspaceMode == "local" ? "worktree" : "local"
            } label: {
                Label(
                    model.usesInternalWorkspace ? "Pathway workspace" : model.workspaceMode == "worktree" ? "New worktree" : "Current checkout",
                    systemImage: model.workspaceMode == "worktree"
                        ? "arrow.triangle.branch"
                        : "folder"
                )
            }
            .disabled(model.temporary || model.usesInternalWorkspace)
            .accessibilityHint("Changes the workspace used for the new thread")

            if model.workspaceMode == "worktree" {
                Button {
                    showsBranches = true
                } label: {
                    Label(model.baseReference, systemImage: "arrow.triangle.branch")
                }
            }

            Spacer(minLength: 0)
        }
        .buttonStyle(.plain)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .frame(minHeight: 44)
        .padding(.horizontal, 8)
        .disabled(model.isLaunching)
    }

    private func composer(_ model: PathwayAgentThreadCreationModel) -> some View {
        return VStack(spacing: 12) {
            NewAgentThreadMessageEditor(model: model, isFocused: $promptFocused, showsOptions: $showsOptions)
                .disabled(model.isLaunching)

            HStack(spacing: 10) {
                Button("Composer options", systemImage: "plus") {
                    promptFocused = false
                    showsOptions = true
                }
                .disabled(model.isLaunching)
                .labelStyle(.iconOnly)
                .font(.title3)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
                .buttonStyle(.plain)
                .accessibilityIdentifier("new-agent-thread-options")

                Text(model.selectedModel?.name ?? "Choose model")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)

                Spacer(minLength: 0)

                Button {
                    launch(model)
                } label: {
                    if model.isLaunching {
                        ProgressView()
                            .frame(width: 20, height: 20)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.headline)
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(!model.canLaunch)
                .accessibilityLabel("Start agent thread")
            }

            if model.isImportingCapture { ProgressView("Importing shared draft…").font(.caption) }
            if let statusMessage = statusMessage(model) {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(model.errorMessage == nil ? Color.secondary : Color.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 26).fill(.regularMaterial)
                .overlay { RoundedRectangle(cornerRadius: 26).strokeBorder(.primary.opacity(0.10), lineWidth: 0.5) }
        }
    }

    private func statusMessage(_ model: PathwayAgentThreadCreationModel) -> String? {
        if let error = model.errorMessage { return error }
        if let placementMessage { return placementMessage }
        switch model.connectionState {
        case .connecting: return "Loading agents and models…"
        case let .failed(message): return message
        default: return nil
        }
    }

    private func launch(_ model: PathwayAgentThreadCreationModel) {
        promptFocused = false
        Task {
            if let threadID = await model.launch() {
                didLaunch(threadID)
            }
        }
    }
}
