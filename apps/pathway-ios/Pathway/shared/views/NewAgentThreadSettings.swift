import SwiftUI

struct NewAgentThreadSettings: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayAgentThreadCreationModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
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
                        Text("Current checkout").tag("local")
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
            }
            .navigationTitle("Thread Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
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
