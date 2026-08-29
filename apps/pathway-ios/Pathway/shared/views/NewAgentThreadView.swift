import SwiftUI

struct NewAgentThreadView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(PathwayAppModel.self) private var appModel

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
                } else if bindingOptions.isEmpty {
                    unavailable(
                        title: "No connected projects",
                        message: "A project must be available in a Pathway Connect environment before you can start a thread."
                    )
                } else if let model {
                    NewAgentThreadForm(
                        model: model,
                        bindingOptions: bindingOptions,
                        selectedBindingID: $selectedBindingID,
                        didLaunch: close
                    )
                } else {
                    ProgressView("Connecting to the environment…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("New Agent Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: close)
                }
            }
        }
        .task {
            if selectedBindingID.isEmpty {
                selectedBindingID = bindingOptions.first?.id ?? ""
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
                projectName: project.project.name,
                companyName: appModel.cloud.companyName(for: binding.companyId) ?? "Pathway"
            )
        }.sorted {
            $0.label.localizedStandardCompare($1.label) == .orderedAscending
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
        #if os(visionOS)
            dismissWindow(id: PathwayWindow.agentOrchestrator.rawValue)
        #else
            dismiss()
        #endif
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

@MainActor
private struct PathwayNewThreadDraft {
    let prompt: String
    let runtimeMode: String
    let interactionMode: String
    let workspaceMode: String
    let baseReference: String
    let branch: String
    let startFromOrigin: Bool

    init(model: PathwayAgentThreadCreationModel) {
        prompt = model.prompt
        runtimeMode = model.runtimeMode
        interactionMode = model.interactionMode
        workspaceMode = model.workspaceMode
        baseReference = model.baseReference
        branch = model.branch
        startFromOrigin = model.startFromOrigin
    }

    func apply(to model: PathwayAgentThreadCreationModel) {
        model.prompt = prompt
        model.runtimeMode = runtimeMode
        model.interactionMode = interactionMode
        model.workspaceMode = workspaceMode
        model.baseReference = baseReference
        model.branch = branch
        model.startFromOrigin = startFromOrigin
    }
}

private struct PathwayNewThreadBindingOption: Identifiable {
    let binding: PathwayCompanyEnvironmentBinding
    let environment: PathwayCompanyEnvironment
    let projectName: String
    let companyName: String

    var id: String { binding.id }
    var label: String { "\(projectName) · \(environment.environment.label)" }
}

private struct NewAgentThreadForm: View {
    @Bindable var model: PathwayAgentThreadCreationModel
    let bindingOptions: [PathwayNewThreadBindingOption]
    @Binding var selectedBindingID: String
    let didLaunch: () -> Void

    var body: some View {
        Form {
            Section("Where") {
                Picker("Project and environment", selection: $selectedBindingID) {
                    ForEach(bindingOptions) { option in
                        Text("\(option.label) — \(option.companyName)")
                            .tag(option.id)
                    }
                }
            }

            Section("What should the agent do?") {
                TextField("Describe the work", text: $model.prompt, axis: .vertical)
                    .lineLimit(4 ... 12)
            }

            Section("Agent") {
                switch model.connectionState {
                case .connecting:
                    HStack {
                        ProgressView()
                        Text("Loading agents and models…")
                    }
                case let .failed(message):
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                default:
                    EmptyView()
                }

                Picker("Provider", selection: $model.selectedProviderID) {
                    ForEach(model.providers) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }

                Picker("Model", selection: $model.selectedModelID) {
                    ForEach(model.selectedProvider?.models ?? []) { availableModel in
                        Text(availableModel.name).tag(availableModel.id)
                    }
                }

                ForEach(model.selectedModel?.optionDescriptors ?? []) { descriptor in
                    optionControl(descriptor)
                }
            }

            Section("How it should work") {
                Picker("Access", selection: $model.runtimeMode) {
                    Text("Ask before changes").tag("approval-required")
                    Text("Accept file edits").tag("auto-accept-edits")
                    Text("Automatic").tag("auto")
                    Text("Full access").tag("full-access")
                }

                if model.selectedProvider?.showsInteractionMode == true {
                    Picker("Mode", selection: $model.interactionMode) {
                        Text("Work").tag("default")
                        Text("Plan").tag("plan")
                    }
                }

                Picker("Workspace", selection: $model.workspaceMode) {
                    Text("Current project").tag("local")
                    Text("New worktree").tag("worktree")
                }

                if model.workspaceMode == "worktree" {
                    TextField("Base branch or ref", text: $model.baseReference)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("New branch (optional)", text: $model.branch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("Start from origin", isOn: $model.startFromOrigin)
                }
            }

            if let errorMessage = model.errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task {
                        if await model.launch() != nil {
                            didLaunch()
                        }
                    }
                } label: {
                    HStack {
                        Spacer()
                        if model.isLaunching {
                            ProgressView()
                        } else {
                            Label("Start Agent Thread", systemImage: "arrow.up.circle.fill")
                        }
                        Spacer()
                    }
                }
                .disabled(!model.canLaunch)
            } footer: {
                Text("The thread runs on the selected environment through Pathway Connect.")
            }
        }
    }

    @ViewBuilder
    private func optionControl(_ descriptor: PathwayProviderOptionDescriptor) -> some View {
        if descriptor.type == "boolean" {
            Toggle(
                descriptor.label,
                isOn: Binding(
                    get: { model.optionValues[descriptor.id]?.boolValue ?? false },
                    set: { model.setOption(descriptor, value: .bool($0)) }
                )
            )
        } else {
            Picker(
                descriptor.label,
                selection: Binding(
                    get: { model.optionValues[descriptor.id]?.stringValue ?? "" },
                    set: { model.setOption(descriptor, value: .string($0)) }
                )
            ) {
                ForEach(descriptor.choices) { choice in
                    Text(choice.label).tag(choice.id)
                }
            }
        }
    }
}
