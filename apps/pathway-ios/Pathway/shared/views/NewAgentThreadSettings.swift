import SwiftUI

struct NewAgentThreadSettings<Tools: View>: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayAgentThreadCreationModel
    @State private var showsModelSettings = false

    var title = "Thread Settings"
    @ViewBuilder var tools: () -> Tools

    var body: some View {
        NavigationStack {
            Form {
                tools()
                Section("Agent") {
                    Button {
                        showsModelSettings = true
                    } label: {
                        LabeledContent("Model and options", value: model.selectedModel?.name ?? "Choose model")
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

                    if !model.isConversation && !model.usesInternalWorkspace {
                        Picker("Workspace", selection: $model.workspaceMode) {
                            Text("Current checkout").tag("local")
                            Text("New worktree").tag("worktree")
                        }
                        .disabled(model.temporary)
                    }

                    if !model.isConversation && model.workspaceMode == "worktree" {
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
            .onChange(of: model.selectedProviderID) { _, _ in model.pinPlacement() }
            .onChange(of: model.selectedModelID) { _, _ in model.pinPlacement() }
            .onChange(of: model.optionValues) { _, _ in model.pinPlacement() }
            .onChange(of: model.workspaceMode) { _, _ in model.pinPlacement() }
            .onChange(of: model.baseReference) { _, _ in model.pinPlacement() }
            .onChange(of: model.branch) { _, _ in model.pinPlacement() }
            .onChange(of: model.runtimeMode) { _, _ in model.pinPlacement() }
            .onChange(of: model.interactionMode) { _, _ in model.pinPlacement() }
            .onChange(of: model.startFromOrigin) { _, _ in model.pinPlacement() }
            .sheet(isPresented: $showsModelSettings) {
                NewAgentModelSettingsSheet(model: model)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }


}

extension NewAgentThreadSettings where Tools == EmptyView {
    init(model: PathwayAgentThreadCreationModel) {
        self.init(model: model, tools: { EmptyView() })
    }
}
