import SwiftUI

struct PathwayEmailAutomationView: View {
    @Bindable var model: PathwayEmailModel
    let environment: PathwayCompanyEnvironment
    let projectID: String
    @State private var rules: [PathwayCalendarRecord] = []
    @State private var firings: [PathwayCalendarRecord] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var editor: PathwayCalendarRecord?
    @State private var deleting: PathwayCalendarRecord?
    var body: some View {
        List {
            Section("Trigger rules") {
                if loading && rules.isEmpty { ProgressView("Loading trigger rules…") }
                ForEach(rules) { rule in
                    Button { editor = rule } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(rule.string("name")).font(.headline)
                            Text(rule.fields["enabled"]?.boolValue == true ? "Enabled · \(rule.fields["maxTriggersPerHour"]?.intValue ?? 0) per hour" : rule.string("autoDisabledAt").isEmpty ? "Paused" : "Automatically disabled").font(.caption)
                            if !rule.string("autoDisabledReason").isEmpty { Text(rule.string("autoDisabledReason")).font(.caption).foregroundStyle(.red) }
                        }
                    }.foregroundStyle(.primary)
                    .swipeActions { Button("Delete", role: .destructive) { deleting = rule } }
                    .contextMenu { Button("Delete rule", role: .destructive) { deleting = rule } }
                }
                Button("New trigger rule", systemImage: "plus") {
                    editor = .init(companyID: environment.companyId, kind: "trigger", fields: ["id": .string(UUID().uuidString.lowercased()), "isNew": .bool(true)])
                }
            }
            Section("Firing history") {
                ForEach(firings) { firing in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(firing.string("status").replacingOccurrences(of: "-", with: " ").capitalized).font(.headline)
                        Text(firing.string("firedAt")).font(.caption).foregroundStyle(.secondary)
                        LabeledContent("Thread", value: firing.string("threadId")).font(.caption).textSelection(.enabled)
                        LabeledContent("Message", value: firing.string("messageId")).font(.caption).textSelection(.enabled)
                        if !firing.string("error").isEmpty { Text(firing.string("error")).font(.caption).foregroundStyle(.red) }
                        if !firing.string("loopMessageId").isEmpty { LabeledContent("Loop message", value: firing.string("loopMessageId")).font(.caption) }
                    }
                }
                if cursor != nil { Button("Load more") { Task { await refresh(append: true) } }.disabled(loading) }
                if !loading && firings.isEmpty { Text("No trigger firings yet.").foregroundStyle(.secondary) }
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Email triggers")
        .task { await refresh() }
        .refreshable { await refresh() }
        .sheet(item: $editor, onDismiss: { Task { await refresh() } }) { rule in PathwayEmailTriggerEditor(model: model, environment: environment, projectID: projectID, rule: rule) }
        .confirmationDialog("Delete this trigger rule?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let rule = deleting { Button("Delete rule", role: .destructive) { Task { if await model.perform({ _ = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.triggerRules.delete", fields: ["projectId": .string(projectID), "ruleId": .string(rule.entityID)]) }) { deleting = nil; await refresh() } } } }
        }
    }
    private func refresh(append: Bool = false) async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            if !append {
                let value = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.triggerRules.list", fields: ["projectId": .string(projectID)])
                rules = (value.objectValue?["rules"]?.arrayValue ?? []).compactMap(\.objectValue).map { .init(companyID: environment.companyId, kind: "trigger", fields: $0) }
            }
            var args: [String: JSONValue] = ["projectId": .string(projectID), "limit": .number(50)]
            if append, let cursor { args["cursor"] = .string(cursor) }
            let value = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.triggerFirings.list", fields: args)
            let rows = (value.objectValue?["firings"]?.arrayValue ?? []).compactMap(\.objectValue).map { PathwayCalendarRecord(companyID: environment.companyId, kind: "firing", fields: $0) }
            let existing = Set(append ? firings.map(\.id) : [])
            firings = append ? firings + rows.filter { !existing.contains($0.id) } : rows
            cursor = value.objectValue?["nextCursor"]?.stringValue
        } catch { if !append { rules = []; firings = [] }; model.errorMessage = error.localizedDescription }
    }
}

private struct PathwayEmailTriggerEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayEmailModel
    let environment: PathwayCompanyEnvironment
    let projectID: String
    let rule: PathwayCalendarRecord
    @State private var name = ""
    @State private var enabled = false
    @State private var sender = ""
    @State private var subject = ""
    @State private var recipient = ""
    @State private var prompt = ""
    @State private var hourlyCap = 5
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    Toggle("Enabled", isOn: $enabled)
                    TextField("Maximum triggers per hour", value: $hourlyCap, format: .number).keyboardType(.numberPad)
                }
                Section {
                    TextField("Sender", text: $sender).textInputAutocapitalization(.never)
                    TextField("Subject contains", text: $subject)
                    TextField("Recipient", text: $recipient).textInputAutocapitalization(.never)
                } header: { Text("Match incoming mail") } footer: { Text("Choose at least one condition. All supplied conditions must match.") }
                Section {
                    TextField("Prompt template", text: $prompt, axis: .vertical).lineLimit(6...16)
                } header: { Text("Agent work") } footer: { Text("Variables: {{sender}}, {{subject}}, {{body}}, {{code}}, {{messageId}}. New rules start paused. Enable a rule when it is ready to start agent work.") }
                if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(rule.fields["isNew"]?.boolValue == true ? "New email trigger" : "Edit email trigger")
            .onAppear {
                name = rule.string("name"); enabled = rule.fields["enabled"]?.boolValue ?? false
                let matcher = rule.fields["matcher"]?.objectValue ?? [:]
                sender = matcher["sender"]?.stringValue ?? ""; subject = matcher["subject"]?.stringValue ?? ""; recipient = matcher["recipient"]?.stringValue ?? ""
                prompt = rule.string("promptTemplate"); hourlyCap = rule.fields["maxTriggersPerHour"]?.intValue ?? 5
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { if await model.perform({
                            let args = try PathwayEmailTriggerDraft(id: rule.entityID, projectID: projectID, name: name, enabled: enabled, sender: sender, subject: subject, recipient: recipient, prompt: prompt, hourlyCap: hourlyCap).payload()
                            _ = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.triggerRules.upsert", fields: args)
                        }) { dismiss() } }
                    }.disabled(model.isWriting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hourlyCap < 1)
                }
            }
        }
    }
}
