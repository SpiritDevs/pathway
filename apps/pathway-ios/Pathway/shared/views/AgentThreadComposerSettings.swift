import SwiftUI

struct AgentThreadComposerSettings: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayAgentThreadModel
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var provider: PathwayServerProvider? {
        model.providers.first { $0.id == model.currentModelSelection.instanceId }
    }
    private var selectedModel: PathwayServerModel? {
        provider?.models.first { $0.id == model.currentModelSelection.model }
    }

    var body: some View {
        NavigationStack {
            Form {
                if model.isConfigurationLocked {
                    Section {
                        Text(model.configurationLockReason ?? "This thread's configuration can't be changed right now.")
                            .foregroundStyle(.secondary)
                    }
                } else if model.providers.isEmpty {
                    Section {
                        Text("Connect to the environment to load its models and options.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Models") {
                    NavigationLink("Favourite models") {
                        PathwayModelFavouritesSettings(
                            providers: model.modelCatalog.isEmpty ? model.providers : model.modelCatalog,
                            environmentID: model.thread.environmentId
                        )
                    }
                }
                Section("How it should work") {
                    if provider?.showsInteractionMode == true {
                        Picker("Mode", selection: Binding(get: { model.interactionMode }, set: { value in
                            save { try await model.setInteractionMode(value) }
                        })) {
                            Text("Chat").tag("default")
                            Text("Plan").tag("plan")
                        }
                        .accessibilityIdentifier("agent-thread-interaction-mode")
                    }
                    Picker("Access", selection: Binding(get: { model.runtimeMode }, set: { value in
                        save { try await model.setRuntimeMode(value) }
                    })) {
                        Text("Supervised").tag("approval-required")
                        Text("Auto-accept edits").tag("auto-accept-edits")
                        Text("Auto").tag("auto")
                        Text("Full access").tag("full-access")
                    }
                    .accessibilityIdentifier("agent-thread-runtime-mode")
                }
                .disabled(isSaving || model.isConfigurationLocked || model.providers.isEmpty)
                if let selectedModel, !selectedModel.optionDescriptors.isEmpty {
                    Section(selectedModel.name) {
                        ForEach(selectedModel.optionDescriptors) { descriptor in
                            optionControl(descriptor)
                        }
                    }
                    .disabled(isSaving || model.isConfigurationLocked)
                }
            }
            .navigationTitle("Composer options")
            .task { await model.refreshServerConfig() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .overlay { if isSaving { ProgressView().padding().background(.regularMaterial, in: .rect(cornerRadius: 12)) } }
            .alert("Couldn't update options", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }

    @ViewBuilder private func optionControl(_ descriptor: PathwayProviderOptionDescriptor) -> some View {
        if descriptor.type == "boolean" {
            Toggle(descriptor.label, isOn: Binding(
                get: { optionValue(descriptor)?.boolValue ?? false },
                set: { setOption(descriptor, value: .bool($0)) }
            ))
        } else if !descriptor.choices.isEmpty {
            Picker(descriptor.label, selection: Binding(
                get: { optionValue(descriptor)?.stringValue ?? descriptor.choices.first(where: \.isDefault)?.id ?? "" },
                set: { setOption(descriptor, value: .string($0)) }
            )) {
                ForEach(descriptor.choices) { choice in Text(choice.label).tag(choice.id) }
            }
        }
    }

    private func optionValue(_ descriptor: PathwayProviderOptionDescriptor) -> JSONValue? {
        model.currentModelSelection.options?.first { $0.id == descriptor.id }?.value ?? descriptor.currentValue
    }

    private func setOption(_ descriptor: PathwayProviderOptionDescriptor, value: JSONValue) {
        let current = model.currentModelSelection
        var options = current.options ?? []
        options.removeAll { $0.id == descriptor.id }
        options.append(.init(id: descriptor.id, value: value))
        save { try await model.changeModelSelection(.init(instanceId: current.instanceId, model: current.model, options: options)) }
    }

    private func save(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !isSaving else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do { try await operation() }
            catch { errorMessage = error.localizedDescription }
        }
    }
}
