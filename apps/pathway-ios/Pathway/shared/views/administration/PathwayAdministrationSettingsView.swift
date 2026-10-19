import SwiftUI

struct PathwayAdministrationSettingsView: View {
    let client: PathwayAdministrationClient
    var sourceControl = false
    @State private var draft: PathwayAdministrationSettingsDraft?
    @State private var providers: [PathwayAdministrationProvider] = []
    @State private var error: String?
    @State private var notice: String?
    @State private var busy = false

    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Text(notice).foregroundStyle(.secondary) }
            if draft != nil {
                if sourceControl {
                    NavigationLink { PathwaySourceControlDiscoveryView(client: client) } label: {
                        Label("Git tools & hosting accounts", systemImage: "arrow.triangle.branch")
                    }
                    PathwaySourceControlPolicyFields(draft: draftBinding, providers: providers)
                } else {
                    PathwayGeneralSettingsFields(draft: draftBinding, providers: providers)
                }
                PathwayBackgroundSettingsFields(draft: draftBinding)
                Section {
                    Button("Save settings") { Task { await save() } }.disabled(draft?.hasChanges != true)
                    Button("Reload saved settings") { Task { await load() } }.disabled(draft?.hasChanges == true)
                } footer: {
                    Text("These preferences apply to \(client.environment.environment.label) and its connected clients. Save changes before leaving this screen.")
                }
            } else if !busy {
                Button("Retry") { Task { await load() } }
            }
        }
        .navigationTitle(sourceControl ? "Source control settings" : "Environment preferences")
        .disabled(busy)
        .overlay { if busy { ProgressView() } }
        .task { if draft == nil { await load() } }
    }

    private var draftBinding: Binding<PathwayAdministrationSettingsDraft> {
        Binding(get: { draft ?? .init(.object([:])) }, set: { draft = $0; notice = nil })
    }
    private func load() async {
        busy = true; defer { busy = false }
        do {
            let settings = try await client.run("server.getSettings")
            try Task.checkCancellation()
            draft = .init(settings); error = nil; notice = nil
            do {
                let config: PathwayAdministrationConfig = try await client.call("server.getConfig")
                try Task.checkCancellation(); providers = config.providers
            } catch is CancellationError { throw CancellationError() }
            catch { self.error = "Settings loaded, but model choices could not be refreshed: \(error.localizedDescription)" }
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    private func save() async {
        guard let draft else { return }
        busy = true; defer { busy = false }
        do {
            let latest = draft.hostOverrides.isEmpty ? nil : try await client.run("server.getSettings")
            let patch = try draft.patch(latest: latest)
            guard !patch.isEmpty else { return }
            let saved = try await client.run("server.updateSettings", ["patch": .object(patch)])
            try Task.checkCancellation()
            self.draft = .init(saved); error = nil; notice = "Settings saved."
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

private struct PathwayGeneralSettingsFields: View {
    @Binding var draft: PathwayAdministrationSettingsDraft
    let providers: [PathwayAdministrationProvider]
    var body: some View {
        Section("New threads & projects") {
            Picker("Default workspace", selection: $draft.workspaceMode) {
                Text("Local checkout").tag("local"); Text("New worktree").tag("worktree")
            }
            Toggle("Start new worktrees from origin", isOn: $draft.startFromOrigin)
            TextField("Add-project base directory", text: $draft.baseDirectory)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        Section("Provider maintenance") {
            Toggle("Check provider CLI updates", isOn: $draft.updateChecks)
        }
        Section("Generated text") {
            PathwaySettingsModelPicker(title: "Titles & generated text", selection: $draft.textModel, providers: providers)
            PathwaySettingsModelPicker(title: "Context compaction", selection: $draft.compactionModel, providers: providers)
        }
    }
}

private struct PathwaySourceControlPolicyFields: View {
    @Binding var draft: PathwayAdministrationSettingsDraft
    let providers: [PathwayAdministrationProvider]
    var body: some View {
        Section("Generated change descriptions") {
            Picker("Writing style", selection: $draft.writingMode) {
                Text("Repository conventions").tag("repo_conventions")
                Text("Conventional Commits").tag("conventional_commits")
                Text("Custom instructions").tag("custom")
            }
            if draft.writingMode == "custom" {
                TextField("Writing instructions", text: $draft.writingInstructions, axis: .vertical).lineLimit(3...10)
            }
            Toggle("Follow change request templates", isOn: $draft.followTemplates)
            PathwaySettingsModelPicker(title: "Source-control writer", selection: $draft.writerModel,
                providers: providers, allowsInherited: true)
        }
    }
}

private struct PathwayBackgroundSettingsFields: View {
    @Binding var draft: PathwayAdministrationSettingsDraft
    var body: some View {
        Section {
            Picker("Host background policy", selection: Binding(get: { draft.backgroundProfile }, set: { draft.selectBackgroundProfile($0) })) {
                Text("Balanced").tag("balanced")
                Text("Performance").tag("performance")
                Text("Battery saver").tag("battery-saver")
                if draft.backgroundProfile == "custom" { Text("Custom").tag("custom") }
            }
            HStack {
                Text("Git fetch interval (seconds)")
                TextField("Seconds", value: $draft.gitFetchSeconds, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            }
            HStack {
                Text("Provider health interval (seconds)")
                TextField("Seconds", value: $draft.providerHealthSeconds, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            }
            DisclosureGroup("Advanced host policy") {
                ForEach(PathwayBackgroundHostField.allCases) { field in
                    if field.isInterval {
                        HStack {
                            Text(field.title)
                            TextField("Seconds", value: Binding(get: {
                                if case let .number(value) = draft.hostValue(field) { return value / 1000 }; return 0
                            }, set: { draft.setHostValue(field, value: .number($0 * 1000)) }), format: .number)
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                    } else {
                        Toggle(field.title, isOn: Binding(get: { draft.hostValue(field).boolValue ?? false },
                            set: { draft.setHostValue(field, value: .bool($0)) }))
                    }
                }
            }
        } header: { Text("Background activity") } footer: {
            Text("Policies run on the environment host. Zero disables a refresh timer. Custom intervals preserve other host-power and idle settings. Selecting a preset restores its complete policy.")
        }
    }
}

private struct PathwaySettingsModelPicker: View {
    let title: String
    @Binding var selection: JSONValue
    let providers: [PathwayAdministrationProvider]
    var allowsInherited = false
    private var instanceID: String { selection.objectValue?["instanceId"]?.stringValue ?? "" }
    private var modelID: String { selection.objectValue?["model"]?.stringValue ?? "" }
    private var models: [PathwayAdministrationProvider.Model] { providers.first { $0.id == instanceID }?.models ?? [] }
    var body: some View {
        NavigationLink {
            Form {
                if allowsInherited {
                    Toggle("Use general text model", isOn: Binding(get: { selection == .null }, set: { inherited in
                        if inherited { selection = .null }
                        else if let provider = providers.first(where: { !$0.models.isEmpty }), let model = provider.models.first {
                            selection = .object(["instanceId": .string(provider.id), "model": .string(model.id)])
                        }
                    })).disabled(selection == .null && providers.allSatisfy { $0.models.isEmpty })
                }
                if !allowsInherited || selection != .null {
                    Picker("Provider", selection: Binding(get: { instanceID }, set: { id in
                        guard id != instanceID else { return }
                        selection = .object(["instanceId": .string(id), "model": .string(providers.first { $0.id == id }?.models.first?.id ?? "")])
                    })) {
                        if !providers.contains(where: { $0.id == instanceID }) { Text(instanceID.isEmpty ? "Choose provider" : instanceID).tag(instanceID) }
                        ForEach(providers) { Text($0.name).tag($0.id) }
                    }
                    Picker("Model", selection: Binding(get: { modelID }, set: { id in
                        guard id != modelID else { return }
                        selection = .object(["instanceId": .string(instanceID), "model": .string(id)])
                    })) {
                        if !models.contains(where: { $0.id == modelID }) { Text(modelID.isEmpty ? "Choose model" : modelID).tag(modelID) }
                        ForEach(models) { Text($0.name).tag($0.id) }
                    }
                }
                Text("Existing provider options are preserved until you choose a different provider or model. Save on the settings screen to apply your choice.").font(.footnote).foregroundStyle(.secondary)
            }.navigationTitle(title)
        } label: {
            LabeledContent(title, value: selection == .null ? "General text model" : modelID)
        }
    }
}
