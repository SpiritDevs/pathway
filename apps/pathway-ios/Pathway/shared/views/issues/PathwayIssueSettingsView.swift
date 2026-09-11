import SwiftUI
import UniformTypeIdentifiers

struct PathwayIssueSettingsView: View {
    let model: PathwayIssuesModel
    let companyID: String

    var body: some View {
        List {
            Section("Workflow") {
                ForEach([PathwayIssueCatalogKind.status, .label]) { kind in
                    NavigationLink(kind.title) { PathwayIssueCatalogView(model: model, companyID: companyID, kind: kind) }
                }
                NavigationLink("Milestones and cycles") { PathwayIssuePlanningView(model: model, companyID: companyID) }
            }
            Section("Environment") {
                NavigationLink("Intake, investigation and automation") {
                    PathwayIssueEnvironmentSettingsView(model: model, companyID: companyID)
                }
                NavigationLink("Import CSV") { PathwayIssueImportView(model: model, companyID: companyID) }
            }
        }
        .navigationTitle("Task settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// All environment-specific controls pin their RPC to the selected environment.
struct PathwayIssueEnvironmentPicker: View {
    @Environment(PathwayAppModel.self) private var appModel
    let companyID: String
    @Binding var selection: String

    var body: some View {
        Picker("Environment", selection: $selection) {
            Text("Select environment").tag("")
            ForEach(appModel.cloud.environments.filter { $0.companyId == companyID && $0.environment.state == "active" }) {
                Text($0.environment.label).tag($0.environment.environmentId)
            }
        }
    }
}

@MainActor
func pathwayIssueSettingsRequest(
    model: PathwayIssuesModel, companyID: String, environmentID: String,
    method: String, fields: [String: JSONValue] = [:]
) async throws -> JSONValue {
    guard !environmentID.isEmpty, let request = model.environmentRequest else {
        throw PathwayIssueWriteError(message: "Select a connected environment first.")
    }
    var payload = fields
    payload["_environmentId"] = .string(environmentID)
    return try await request(companyID, nil, method, .object(payload))
}

private struct PathwayIssueImportView: View {
    let model: PathwayIssuesModel
    let companyID: String
    @State private var environmentID = ""
    @State private var csv = ""
    @State private var selectingFile = false
    @State private var busy = false
    @State private var result: JSONValue?
    @State private var error: String?

    var body: some View {
        Form {
            Section { PathwayIssueEnvironmentPicker(companyID: companyID, selection: $environmentID).disabled(busy) }
            Section("CSV") {
                Button("Choose CSV file", systemImage: "doc") { selectingFile = true }
                TextEditor(text: $csv).frame(minHeight: 180).accessibilityLabel("CSV contents")
                Text("Review the contents before importing. Existing tasks are kept.").font(.caption).foregroundStyle(.secondary)
                Button("Import tasks") {
                    busy = true
                    Task {
                        defer { busy = false }
                        do {
                            result = try await pathwayIssueSettingsRequest(model: model, companyID: companyID,
                                environmentID: environmentID, method: "issues.importCsv", fields: ["csvText": .string(csv)])
                            error = nil
                        } catch { self.error = error.localizedDescription }
                    }
                }
                .disabled(busy || environmentID.isEmpty || csv.isEmpty || csv.count > 5_000_000)
            }
            if let result, let fields = result.objectValue {
                Section("Import result") {
                    Text("\(fields["created"]?.intValue ?? 0) tasks imported")
                    ForEach((fields["skipped"]?.arrayValue ?? []).compactMap { $0.objectValue }.map {
                        ImportSkip(line: $0["line"]?.intValue ?? 0, reason: $0["reason"]?.stringValue ?? "Skipped")
                    }) { skip in Text("Line \(skip.line): \(skip.reason)").font(.caption) }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Import CSV")
        .fileImporter(isPresented: $selectingFile, allowedContentTypes: [.commaSeparatedText, .plainText]) { selection in
            do {
                let url = try selection.get()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 5_000_000 else { throw PathwayIssueWriteError(message: "Choose a CSV smaller than 5 MB.") }
                csv = try String(contentsOf: url, encoding: .utf8)
            } catch { self.error = error.localizedDescription }
        }
    }
    private struct ImportSkip: Identifiable { let line: Int; let reason: String; var id: Int { line } }
}

struct PathwayIssueEnvironmentSettingsView: View {
    let model: PathwayIssuesModel
    let companyID: String
    @State private var environmentID = ""
    @State private var config: [String: JSONValue] = [:]
    @State private var selection: JSONValue = .null
    @Environment(PathwayAppModel.self) private var appModel
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false

    var body: some View {
        Form {
            Section { PathwayIssueEnvironmentPicker(companyID: companyID, selection: $environmentID).disabled(busy) }
            Section("Company") {
                NavigationLink("Company automation") {
                    PathwayIssueAutomationView(model: model, companyID: companyID, environmentID: environmentID,
                        providers: config["providers"]?.arrayValue ?? [],
                        initial: config["settings"]?.objectValue?["issueAutomation"] ?? .object([:]))
                }
                LabeledContent("Task prefix", value: appModel.cloud.companies.first { $0.id == companyID }?.issueKeyPrefix ?? "—")
            }
            if !config.isEmpty {
                Section("Investigation") {
                    PathwayIssueModelSelectionPicker(selection: $selection, providers: config["providers"]?.arrayValue ?? [])
                    Text("The model used to investigate a task's project. Investigation does not edit the repository.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Save investigation model") { saveModel() }.disabled(busy || selection == .null)
                }
                Section {
                    NavigationLink("Slack intake") {
                        PathwayIssueSlackSettingsView(model: model, companyID: companyID, environmentID: environmentID)
                    }
                }

            }
            if busy { ProgressView() }
            if saved { Text("Saved").foregroundStyle(.secondary) }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Environment settings")
        .task(id: environmentID) {
            config = [:]; error = nil; saved = false; selection = .null
            guard !environmentID.isEmpty else { return }
            busy = true
            defer { busy = false }
            do {
                let result = try await pathwayIssueSettingsRequest(model: model, companyID: companyID,
                    environmentID: environmentID, method: "server.getConfig")
                guard !Task.isCancelled else { return }
                config = result.objectValue ?? [:]
                selection = config["settings"]?.objectValue?["issueEnrichmentModelSelection"] ?? .null
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }

    private func saveModel() {
        let selected = selection
        let targetEnvironment = environmentID
        guard pathwayIssueModelSelectionIsValid(selected) else {
            error = "Choose a provider and model before saving."; return
        }
        run {
            _ = try await pathwayIssueSettingsRequest(model: model, companyID: companyID, environmentID: targetEnvironment,
                method: "server.updateSettings", fields: ["patch": .object(["issueEnrichmentModelSelection": selected])])
        }
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true; saved = false
        Task {
            defer { busy = false }
            do { try await operation(); saved = true; error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}

func pathwayIssueModelSelectionIsValid(_ value: JSONValue) -> Bool {
    guard let fields = value.objectValue else { return false }
    return !(fields["instanceId"]?.stringValue ?? "").isEmpty && !(fields["model"]?.stringValue ?? "").isEmpty
}

struct PathwayIssueModelSelectionPicker: View {
    @Binding var selection: JSONValue
    let providers: [JSONValue]
    private var fields: [String: JSONValue] { selection.objectValue ?? [:] }
    private var instance: String { fields["instanceId"]?.stringValue ?? "" }
    private var modelID: String { fields["model"]?.stringValue ?? "" }
    private var models: [JSONValue] { models(for: instance) }
    private var descriptors: [OptionDescriptor] { options(instance: instance, model: modelID) }

    var body: some View {
        Picker("Provider", selection: Binding(get: { instance }, set: { value in
            let first = models(for: value).first?.objectValue?["slug"]?.stringValue ?? ""
            choose(instance: value, model: first)
        })) {
            Text("Select provider").tag("")
            if !instance.isEmpty && !providerRows.contains(where: { $0.id == instance }) {
                Text("\(instance) (unavailable)").tag(instance)
            }
            ForEach(providerRows) { Text($0.name).tag($0.id) }
        }
        Picker("Model", selection: Binding(get: { modelID }, set: { choose(instance: instance, model: $0) })) {
            Text("Select model").tag("")
            if !modelID.isEmpty && !modelRows.contains(where: { $0.id == modelID }) {
                Text("\(modelID) (unavailable)").tag(modelID)
            }
            ForEach(modelRows) { Text($0.name).tag($0.id) }
        }
        ForEach(descriptors) { descriptor in
            if descriptor.type == "boolean" {
                Toggle(descriptor.label, isOn: Binding(get: { optionValue(descriptor)?.boolValue ?? false },
                                                      set: { setOption(descriptor.id, value: .bool($0)) }))
            } else if descriptor.type == "select" {
                Picker(descriptor.label, selection: Binding(get: { optionValue(descriptor)?.stringValue ?? "" },
                                                           set: { setOption(descriptor.id, value: .string($0)) })) {
                    Text("Default").tag("")
                    ForEach(descriptor.choices) { Text($0.name).tag($0.id) }
                }
            }
        }
        if fields["options"]?.arrayValue?.isEmpty == false {
            Button("Use model defaults") {
                var updated = fields
                updated.removeValue(forKey: "options")
                selection = .object(updated)
            }
        }
    }
    private func models(for instance: String) -> [JSONValue] {
        providers.first { $0.objectValue?["instanceId"]?.stringValue == instance }?.objectValue?["models"]?.arrayValue ?? []
    }
    private func options(instance: String, model: String) -> [OptionDescriptor] {
        let item = models(for: instance).first { $0.objectValue?["slug"]?.stringValue == model }
        return (item?.objectValue?["capabilities"]?.objectValue?["optionDescriptors"]?.arrayValue ?? []).compactMap { value in
            guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
            let injected = Set(fields["promptInjectedValues"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            let choices = (fields["options"]?.arrayValue ?? []).compactMap { value -> Choice? in
                guard let fields = value.objectValue, let id = fields["id"]?.stringValue, !injected.contains(id) else { return nil }
                return Choice(id: id, name: fields["label"]?.stringValue ?? id)
            }
            return OptionDescriptor(id: id, label: fields["label"]?.stringValue ?? id,
                                    type: fields["type"]?.stringValue ?? "select", choices: choices, currentValue: fields["currentValue"])
        }
    }
    private func optionValue(_ descriptor: OptionDescriptor) -> JSONValue? {
        fields["options"]?.arrayValue?.first { $0.objectValue?["id"]?.stringValue == descriptor.id }?.objectValue?["value"]
            ?? descriptor.currentValue
    }
    private func setOption(_ id: String, value: JSONValue) {
        var updated = fields
        var choices = (updated["options"]?.arrayValue ?? []).filter { $0.objectValue?["id"]?.stringValue != id }
        if value != .string("") { choices.append(.object(["id": .string(id), "value": value])) }
        if choices.isEmpty { updated.removeValue(forKey: "options") } else { updated["options"] = .array(choices) }
        selection = .object(updated)
    }
    private func choose(instance: String, model: String) {
        if instance == self.instance && model == modelID { return }
        let allowed = options(instance: instance, model: model)
        let retained = (fields["options"]?.arrayValue ?? []).filter { option in
            guard let object = option.objectValue, let descriptor = allowed.first(where: { $0.id == object["id"]?.stringValue }) else { return false }
            if descriptor.type == "boolean" { return object["value"]?.boolValue != nil }
            return descriptor.choices.contains { $0.id == object["value"]?.stringValue }
        }
        var updated: [String: JSONValue] = ["instanceId": .string(instance), "model": .string(model)]
        if !retained.isEmpty { updated["options"] = .array(retained) }
        selection = .object(updated)
    }
    private var providerRows: [Choice] { providers.compactMap { value in
        guard let row = value.objectValue, let id = row["instanceId"]?.stringValue else { return nil }
        return Choice(id: id, name: row["displayName"]?.stringValue ?? id)
    } }
    private var modelRows: [Choice] { models.compactMap { value in
        guard let row = value.objectValue, let id = row["slug"]?.stringValue else { return nil }
        return Choice(id: id, name: row["name"]?.stringValue ?? id)
    } }
    private struct Choice: Identifiable { let id: String; let name: String }
    private struct OptionDescriptor: Identifiable {
        let id: String; let label: String; let type: String; let choices: [Choice]; let currentValue: JSONValue?
    }
}
