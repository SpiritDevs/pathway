import SwiftUI

struct PathwayIssueAutomationView: View {
    let model: PathwayIssuesModel
    let companyID: String
    let environmentID: String
    let providers: [JSONValue]
    let initial: JSONValue
    @State private var draft: [String: JSONValue] = [:]
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false
    @State private var loaded = false
    @State private var enabled = false
    @State private var revision: JSONValue = .null
    @State private var savedDraft: JSONValue = .null

    var body: some View {
        Form {
            Section("Company automation") {
                LabeledContent("State", value: enabled ? "Enabled" : "Paused")
                Button(enabled ? "Pause automation" : "Enable automation") { setEnabled(!enabled) }
                    .disabled(saving || !loaded || revision == .null || savedDraft != .object(draft))
                if revision == .null || savedDraft != .object(draft) {
                    Text("Save the configuration before changing the automation state.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Assignment model") {
                if providers.isEmpty {
                    Text("Select an environment in Issue settings to discover available models. Saved selections are retained.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                PathwayIssueModelSelectionPicker(selection: value("routingModelSelection"), providers: providers)
            }
            Section("Routing rules") {
                ruleLinks("routingRules", audit: false)
                Button("Add routing rule") { addRule("routingRules", audit: false) }
                    .disabled(rows("routingRules").count >= 25)
            }
            Section("Fallback") {
                Toggle("Assign when no rule matches", isOn: Binding(get: {
                    draft["fallbackModelSelection"] != nil && draft["fallbackModelSelection"] != .null
                }, set: { draft["fallbackModelSelection"] = $0 ? draft["routingModelSelection"] : .null }))
                if draft["fallbackModelSelection"] != nil && draft["fallbackModelSelection"] != .null {
                    PathwayIssueModelSelectionPicker(selection: value("fallbackModelSelection"), providers: providers)
                }
            }
            Section("Audit policies") {
                ruleLinks("auditRules", audit: true)
                Button("Add audit policy") { addRule("auditRules", audit: true) }
                    .disabled(rows("auditRules").count >= 25)
            }
            Section("Review workers") {
                ForEach(rows("reviewWorkers")) { worker in
                    NavigationLink {
                        Form {
                            PathwayIssueModelSelectionPicker(selection: nestedValue("reviewWorkers", id: worker.id, key: "modelSelection"), providers: providers)
                            Button("Remove worker", role: .destructive) { remove("reviewWorkers", id: worker.id) }
                        }.navigationTitle("Review worker")
                    } label: {
                        Text(worker.fields["modelSelection"]?.objectValue?["model"]?.stringValue ?? "Select a model")
                    }
                }
                .onMove { source, destination in move("reviewWorkers", source: source, destination: destination) }
                .onDelete { offsets in delete("reviewWorkers", offsets: offsets) }
                Button("Add review worker") {
                    append("reviewWorkers", fields: ["id": .string(UUID().uuidString.lowercased()),
                        "modelSelection": draft["routingModelSelection"] ?? .null])
                }.disabled(rows("reviewWorkers").count >= 5)
                Stepper("Remediation cycles: \(draft["maxRemediationCycles"]?.intValue ?? 0)", value: Binding(get: {
                    draft["maxRemediationCycles"]?.intValue ?? 0
                }, set: { draft["maxRemediationCycles"] = .number(Double($0)) }), in: 0...10)
            }
            Section("Status transitions") {
                transition("Work started", key: "workStartedStatusId")
                transition("Work finished", key: "workFinishedStatusId")
                transition("Audit passed", key: "auditPassedStatusId")
                transition("Changes requested", key: "auditChangesRequestedStatusId")
            }
            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Reload saved settings") { Task { await load() } }.disabled(saving)
                }
            }
            if saved { Text("Saved").foregroundStyle(.secondary) }
        }
        .navigationTitle("Automation")
        .toolbar {
            EditButton()
            Button("Save") { save() }.disabled(saving || draft.isEmpty || !loaded)
        }
        .task(id: companyID) { await load() }
    }

    @ViewBuilder
    private func ruleLinks(_ key: String, audit: Bool) -> some View {
        ForEach(rows(key)) { rule in
            NavigationLink {
                PathwayIssueAutomationRuleEditor(rule: rowBinding(key, id: rule.id), providers: providers, audit: audit)
            } label: {
                VStack(alignment: .leading) {
                    Text(rule.fields["name"]?.stringValue ?? "New rule")
                    Text(rule.fields["condition"]?.stringValue ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .onMove { source, destination in move(key, source: source, destination: destination) }
        .onDelete { offsets in delete(key, offsets: offsets) }
    }
    private func transition(_ title: String, key: String) -> some View {
        Picker(title, selection: Binding(get: {
            draft["statusTransitions"]?.objectValue?[key]?.stringValue ?? ""
        }, set: { selected in
            var transitions = draft["statusTransitions"]?.objectValue ?? [:]
            transitions[key] = selected.isEmpty ? .null : .string(selected)
            draft["statusTransitions"] = .object(transitions)
        })) {
            Text("Automatic").tag("")
            ForEach(model.statuses.filter { $0.companyId == companyID }) { Text($0.name).tag($0.id) }
        }
    }
    private func addRule(_ key: String, audit: Bool) {
        var fields: [String: JSONValue] = ["id": .string(UUID().uuidString.lowercased()),
            "name": .string("New rule"), "condition": .string("")]
        if audit {
            fields["auditors"] = .array([.object(["id": .string(UUID().uuidString.lowercased()),
                "modelSelection": draft["routingModelSelection"] ?? .null])])
        } else { fields["modelSelection"] = draft["routingModelSelection"] ?? .null }
        append(key, fields: fields)
    }
    private func rows(_ key: String) -> [AutomationRow] {
        (draft[key]?.arrayValue ?? []).compactMap { value in
            guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
            return AutomationRow(id: id, fields: fields)
        }
    }
    private func append(_ key: String, fields: [String: JSONValue]) { draft[key] = .array((draft[key]?.arrayValue ?? []) + [.object(fields)]) }
    private func remove(_ key: String, id: String) { draft[key] = .array((draft[key]?.arrayValue ?? []).filter { $0.objectValue?["id"]?.stringValue != id }) }
    private func move(_ key: String, source: IndexSet, destination: Int) {
        var values = draft[key]?.arrayValue ?? []; values.move(fromOffsets: source, toOffset: destination); draft[key] = .array(values)
    }
    private func delete(_ key: String, offsets: IndexSet) {
        var values = draft[key]?.arrayValue ?? []; values.remove(atOffsets: offsets); draft[key] = .array(values)
    }
    private func value(_ key: String) -> Binding<JSONValue> { Binding(get: { draft[key] ?? .null }, set: { draft[key] = $0 }) }
    private func rowBinding(_ key: String, id: String) -> Binding<JSONValue> {
        Binding(get: { (draft[key]?.arrayValue ?? []).first { $0.objectValue?["id"]?.stringValue == id } ?? .null }, set: { next in
            draft[key] = .array((draft[key]?.arrayValue ?? []).map { $0.objectValue?["id"]?.stringValue == id ? next : $0 })
        })
    }
    private func nestedValue(_ key: String, id: String, key field: String) -> Binding<JSONValue> {
        let row = rowBinding(key, id: id)
        return Binding(get: { row.wrappedValue.objectValue?[field] ?? .null }, set: {
            var fields = row.wrappedValue.objectValue ?? [:]; fields[field] = $0; row.wrappedValue = .object(fields)
        })
    }
    private func load() async {
        saving = true; saved = false; loaded = false
        defer { saving = false }
        do {
            guard let request = model.cloudRequest else { throw PathwayIssueWriteError(message: "Connect to the company to manage automation.") }
            let result = try await request("query", "issueAutomation:getSettings", .object(["companyId": .string(companyID)]))
            guard !Task.isCancelled else { return }
            let record = result.objectValue
            draft = record?["settings"]?.objectValue ?? initial.objectValue ?? [:]
            draft["schemaVersion"] = .number(1)
            for key in ["routingRules", "auditRules", "reviewWorkers"] where draft[key] == nil { draft[key] = .array([]) }
            draft["fallbackModelSelection"] = draft["fallbackModelSelection"] ?? .null
            draft["maxRemediationCycles"] = draft["maxRemediationCycles"] ?? .number(3)
            draft["statusTransitions"] = draft["statusTransitions"] ?? .object([
                "workStartedStatusId": .null, "workFinishedStatusId": .null,
                "auditPassedStatusId": .null, "auditChangesRequestedStatusId": .null
            ])
            revision = record?["revision"] ?? .null
            enabled = record?["enabled"]?.boolValue ?? false
            savedDraft = .object(draft)
            loaded = true; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func setEnabled(_ value: Bool) {
        saving = true; saved = false
        Task {
            defer { saving = false }
            do {
                guard let request = model.cloudRequest else { throw PathwayIssueWriteError(message: "Connect to the company to manage automation.") }
                let result = try await request("mutation", "issueAutomation:setEnabled", .object([
                    "companyId": .string(companyID), "enabled": .bool(value)
                ]))
                enabled = result.objectValue?["enabled"]?.boolValue ?? value
                revision = result.objectValue?["revision"] ?? revision
                saved = true; error = nil
            } catch { self.error = error.localizedDescription }
        }
    }

    private func save() {
        let routing = rows("routingRules")
        let audits = rows("auditRules")
        let workers = rows("reviewWorkers")
        let rules = routing + audits
        guard rules.allSatisfy({ row in
            ["name", "condition"].allSatisfy { !(row.fields[$0]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }) else { error = "Add a name and condition to every rule before saving."; return }
        var selections = [draft["routingModelSelection"] ?? .null]
        if let fallback = draft["fallbackModelSelection"], fallback != .null { selections.append(fallback) }
        selections += (routing + workers).map { $0.fields["modelSelection"] ?? .null }
        for audit in audits {
            let auditors = audit.fields["auditors"]?.arrayValue ?? []
            guard (1...5).contains(auditors.count) else { error = "Choose one to five auditors for each audit policy."; return }
            selections += auditors.map { $0.objectValue?["modelSelection"] ?? .null }
        }
        guard selections.allSatisfy(pathwayIssueModelSelectionIsValid) else {
            error = "Choose a provider and model for every configured worker."; return
        }
        let statusIDs = Set(model.statuses.filter { $0.companyId == companyID }.map(\.id))
        let transitions = draft["statusTransitions"]?.objectValue ?? [:]
        guard transitions.values.allSatisfy({ $0 == .null || $0.stringValue.map(statusIDs.contains) == true }) else {
            error = "Choose current company statuses for the transitions."; return
        }
        let snapshot = draft
        let expectedRevision = revision
        saving = true; saved = false
        Task {
            defer { saving = false }
            do {
                guard let request = model.cloudRequest else { throw PathwayIssueWriteError(message: "Connect to the company to manage automation.") }
                let result = try await request("mutation", "issueAutomation:saveSettings", .object([
                    "companyId": .string(companyID), "settings": .object(snapshot), "expectedRevision": expectedRevision
                ]))
                revision = result.objectValue?["revision"] ?? revision
                enabled = result.objectValue?["enabled"]?.boolValue ?? enabled
                savedDraft = .object(snapshot)
                saved = true; error = nil
            } catch { self.error = error.localizedDescription }
        }
    }
    private struct AutomationRow: Identifiable { let id: String; let fields: [String: JSONValue] }
}

private struct PathwayIssueAutomationRuleEditor: View {
    @Binding var rule: JSONValue
    let providers: [JSONValue]
    let audit: Bool
    private var fields: [String: JSONValue] { rule.objectValue ?? [:] }
    private var auditors: [String] { (fields["auditors"]?.arrayValue ?? []).compactMap { $0.objectValue?["id"]?.stringValue } }
    var body: some View {
        Form {
            TextField("Name", text: text("name"))
            TextField("When should this rule match?", text: text("condition"), axis: .vertical).lineLimit(3...8)
            if audit {
                ForEach(auditors, id: \.self) { id in
                    Section("Auditor") {
                        PathwayIssueModelSelectionPicker(selection: auditor(id), providers: providers)
                        Button("Remove auditor", role: .destructive) {
                            set("auditors", .array((fields["auditors"]?.arrayValue ?? []).filter { $0.objectValue?["id"]?.stringValue != id }))
                        }.disabled(auditors.count <= 1)
                    }
                }
                Button("Add auditor") {
                    let selection = fields["auditors"]?.arrayValue?.first?.objectValue?["modelSelection"] ?? .null
                    set("auditors", .array((fields["auditors"]?.arrayValue ?? []) + [.object([
                        "id": .string(UUID().uuidString.lowercased()), "modelSelection": selection])]))
                }.disabled(auditors.count >= 5)
            } else {
                PathwayIssueModelSelectionPicker(selection: Binding(get: { fields["modelSelection"] ?? .null }, set: { set("modelSelection", $0) }), providers: providers)
            }
        }
        .navigationTitle(audit ? "Audit policy" : "Routing rule")
    }
    private func set(_ key: String, _ value: JSONValue) { var updated = fields; updated[key] = value; rule = .object(updated) }
    private func text(_ key: String) -> Binding<String> { Binding(get: { fields[key]?.stringValue ?? "" }, set: { set(key, .string($0)) }) }
    private func auditor(_ id: String) -> Binding<JSONValue> {
        Binding(get: { fields["auditors"]?.arrayValue?.first { $0.objectValue?["id"]?.stringValue == id }?.objectValue?["modelSelection"] ?? .null }, set: { selection in
            set("auditors", .array((fields["auditors"]?.arrayValue ?? []).map { value in
                guard var fields = value.objectValue, fields["id"]?.stringValue == id else { return value }
                fields["modelSelection"] = selection; return .object(fields)
            }))
        })
    }
}
