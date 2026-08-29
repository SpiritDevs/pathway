import SwiftUI

struct NewAgentThreadView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel

    @State private var selectedProjectID: String?
    @State private var selectedBindingID = ""
    @State private var model: PathwayAgentThreadCreationModel?

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
                        title: "No connected projects",
                        message: "A project must be available in a Pathway Connect environment before you can start a thread."
                    )
                } else if let selectedProject {
                    NewAgentThreadComposer(
                        project: selectedProject,
                        model: model,
                        selectedBindingID: $selectedBindingID,
                        chooseProject: { selectedProjectID = nil },
                        didLaunch: close
                    )
                } else {
                    PathwayNewThreadProjectPicker(
                        projects: projectOptions,
                        select: selectProject
                    )
                }
            }
            .navigationTitle(selectedProjectID == nil ? "Choose Project" : "New Agent Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: close)
                }
            }
        }
        .task(id: selectedBindingID) {
            await configureSelection()
        }
        .onDisappear {
            Task { await model?.stop() }
        }
    }

    private var bindingOptions: [PathwayNewThreadBindingOption] {
        appModel.cloud.environmentBindings.compactMap { binding in
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
    }

    private var projectOptions: [PathwayNewThreadProjectOption] {
        let groups = Dictionary(grouping: bindingOptions) { option in
            "\(option.binding.companyId):\(option.projectID)"
        }
        return groups.compactMap { id, bindings in
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
    }

    private var selectedProject: PathwayNewThreadProjectOption? {
        projectOptions.first { $0.id == selectedProjectID }
    }

    private func selectProject(_ project: PathwayNewThreadProjectOption) {
        selectedProjectID = project.id
        if !project.bindings.contains(where: { $0.id == selectedBindingID }) {
            selectedBindingID = project.bindings.first?.id ?? ""
        }
    }

    private func configureSelection() async {
        let previous = model.map(PathwayNewThreadDraft.init(model:))
        await model?.stop()
        model = nil
        guard
            let option = bindingOptions.first(where: { $0.id == selectedBindingID }),
            let connect = appModel.connect
        else { return }
        let nextModel = PathwayAgentThreadCreationModel(
            binding: option.binding,
            environment: option.environment,
            connect: connect
        )
        previous?.apply(to: nextModel)
        model = nextModel
        nextModel.start()
    }

    private func close() {
        dismiss()
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
    let project: PathwayNewThreadProjectOption
    let model: PathwayAgentThreadCreationModel?
    @Binding var selectedBindingID: String
    let chooseProject: () -> Void
    let didLaunch: () -> Void

    @FocusState private var promptFocused: Bool
    @State private var showsSettings = false

    var body: some View {
        ZStack {
            Color.clear

            VStack(spacing: 12) {
                Spacer(minLength: 54)

                Text("What should we build")
                    .font(.largeTitle.weight(.regular))

                Button(action: chooseProject) {
                    HStack(spacing: 5) {
                        Text("in \(project.name)?")
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.bold))
                    }
                    .font(.largeTitle.weight(.regular))
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
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
                    workspaceSummary(model)
                    composer(model)
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
        .sheet(isPresented: $showsSettings) {
            if let model {
                NewAgentThreadSettings(model: model)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private var selectedBinding: PathwayNewThreadBindingOption? {
        project.bindings.first { $0.id == selectedBindingID }
    }

    private var environmentPicker: some View {
        Menu {
            ForEach(project.bindings) { binding in
                Button {
                    selectedBindingID = binding.id
                } label: {
                    if binding.id == selectedBindingID {
                        Label(binding.label, systemImage: "checkmark")
                    } else {
                        Text(binding.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "desktopcomputer")
                Text(selectedBinding?.label ?? "Choose environment")
                    .lineLimit(1)
                if project.bindings.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(project.bindings.count < 2)
        .accessibilityLabel("Environment")
        .accessibilityValue(selectedBinding?.label ?? "Not selected")
    }

    private func workspaceSummary(_ model: PathwayAgentThreadCreationModel) -> some View {
        HStack(spacing: 14) {
            Button {
                model.workspaceMode = model.workspaceMode == "local" ? "worktree" : "local"
            } label: {
                Label(
                    model.workspaceMode == "worktree" ? "New worktree" : "Current checkout",
                    systemImage: model.workspaceMode == "worktree"
                        ? "arrow.triangle.branch"
                        : "folder"
                )
            }
            .accessibilityHint("Changes the workspace used for the new thread")

            if model.workspaceMode == "worktree" {
                Button {
                    showsSettings = true
                } label: {
                    Label(model.baseReference, systemImage: "arrow.triangle.branch")
                }
            }

            Spacer(minLength: 0)
        }
        .buttonStyle(.plain)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .frame(minHeight: 40)
        .padding(.horizontal, 8)
    }

    private func composer(_ model: PathwayAgentThreadCreationModel) -> some View {
        @Bindable var model = model
        return VStack(spacing: 12) {
            TextField("Ask anything…", text: $model.prompt, axis: .vertical)
                .lineLimit(3 ... 8)
                .focused($promptFocused)
                .textFieldStyle(.plain)

            HStack(spacing: 10) {
                Button("Thread settings", systemImage: "slider.horizontal.3") {
                    showsSettings = true
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)

                modelPicker(model)

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

            if let statusMessage = statusMessage(model) {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(model.errorMessage == nil ? Color.secondary : Color.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28))
    }

    private func modelPicker(_ model: PathwayAgentThreadCreationModel) -> some View {
        Menu {
            ForEach(model.providers) { provider in
                Section(provider.name) {
                    ForEach(provider.models) { availableModel in
                        Button {
                            model.selectedProviderID = provider.id
                            model.selectedModelID = availableModel.id
                        } label: {
                            let isSelected = provider.id == model.selectedProviderID
                                && availableModel.id == model.selectedModelID
                            if isSelected {
                                Label(availableModel.name, systemImage: "checkmark")
                            } else {
                                Text(availableModel.name)
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                Text(model.selectedModel?.name ?? "Choose model")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.primary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(model.providers.isEmpty || model.isLaunching)
        .accessibilityLabel("Model")
        .accessibilityValue(model.selectedModel?.name ?? "Not selected")
    }

    private func statusMessage(_ model: PathwayAgentThreadCreationModel) -> String? {
        if let error = model.errorMessage { return error }
        switch model.connectionState {
        case .connecting: return "Loading agents and models…"
        case let .failed(message): return message
        default: return nil
        }
    }

    private func launch(_ model: PathwayAgentThreadCreationModel) {
        promptFocused = false
        Task {
            if await model.launch() != nil {
                didLaunch()
            }
        }
    }
}
