import SwiftUI

struct PathwayEmailSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayEmailModel
    let companyID: String
    let environments: [PathwayCompanyEnvironment]
    @State private var tagName = ""
    @State private var tagColor = "#3b82f6"
    @State private var tagID = UUID().uuidString.lowercased()
    @State private var sender = ""
    var body: some View {
        Form {
            Section("Capture environments") {
                ForEach(environments) { environment in
                    NavigationLink(environment.environment.label) {
                        PathwayEmailCaptureSettingsView(model: model, environment: environment)
                    }
                }
                if environments.isEmpty { Text("No environments are available in this workspace.").foregroundStyle(.secondary) }
            }
            Section("Tags") {
                ForEach(model.tags.filter { $0.companyID == companyID }) { tag in
                    NavigationLink(tag.string("name")) { PathwayEmailTagEditor(model: model, tag: tag) }
                }
                TextField("New tag name", text: $tagName)
                Picker("Color", selection: $tagColor) {
                    Text("Blue").tag("#3b82f6"); Text("Green").tag("#22c55e"); Text("Orange").tag("#f97316"); Text("Purple").tag("#a855f7"); Text("Red").tag("#ef4444")
                }
                Button("Create tag") {
                    Task { if await model.perform({ _ = try await model.cloud("emailTags:create", companyID: companyID, fields: ["id": .string(tagID), "name": .string(tagName), "color": .string(tagColor)]) }) { tagName = ""; tagID = UUID().uuidString.lowercased() } }
                }.disabled(model.isWriting || tagName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || companyID.isEmpty)
            }
            Section("Trusted senders") {
                ForEach(model.trustedSenders.filter { $0.companyID == companyID }) { trusted in
                    HStack {
                        Text(trusted.string("address"))
                        Spacer()
                        Button("Remove", role: .destructive) { Task { _ = await model.perform { _ = try await model.cloud("trustedEmailSenders:remove", companyID: companyID, fields: ["trustedSenderId": .string(trusted.entityID)]) } } }.disabled(model.isWriting)
                    }
                }
                TextField("Sender email", text: $sender).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                Button("Trust sender") {
                    Task { if await model.perform({ _ = try await model.cloud("trustedEmailSenders:trust", companyID: companyID, fields: ["id": .string(UUID().uuidString.lowercased()), "address": .string(sender)]) }) { sender = "" } }
                }.disabled(model.isWriting || !sender.contains("@"))
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Email settings")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}

private struct PathwayEmailTagEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayEmailModel
    let tag: PathwayCalendarRecord
    @State private var name = ""
    @State private var color = ""
    @State private var deleting = false
    var body: some View {
        Form {
            TextField("Name", text: $name)
            TextField("Color (hex)", text: $color).textInputAutocapitalization(.never)
            Button("Save") {
                Task { if await model.perform({ _ = try await model.cloud("emailTags:update", companyID: tag.companyID, fields: ["tagId": .string(tag.entityID), "name": .string(name), "color": .string(color)]) }) { dismiss() } }
            }.disabled(model.isWriting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Delete tag", role: .destructive) { deleting = true }.disabled(model.isWriting)
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Edit tag")
        .onAppear { name = tag.string("name"); color = tag.string("color") }
        .confirmationDialog("Delete this tag from all messages?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete tag", role: .destructive) { Task { if await model.perform({ _ = try await model.cloud("emailTags:remove", companyID: tag.companyID, fields: ["tagId": .string(tag.entityID)]) }) { dismiss() } } }
        }
    }
}

private struct PathwayEmailCaptureSettingsView: View {
    @Bindable var model: PathwayEmailModel
    let environment: PathwayCompanyEnvironment
    @State private var snapshot: [String: JSONValue]?
    @State private var enabled = true
    @State private var bindAddress = ""
    @State private var port = 1025
    @State private var maxMessages = 500
    @State private var maxAgeDays = 7
    @State private var toastsEnabled = true
    @State private var loading = true
    var body: some View {
        Form {
            if loading { ProgressView("Loading capture settings…") }
            if let snapshot {
                Section("SMTP listener") {
                    Toggle("Enabled", isOn: $enabled)
                    TextField("Bind address", text: $bindAddress).textInputAutocapitalization(.never)
                    TextField("Port", value: $port, format: .number).keyboardType(.numberPad)
                    if let status = snapshot["listenerStatus"]?.objectValue {
                        LabeledContent("Status", value: status["state"]?.stringValue ?? "Unknown")
                        if let error = status["error"]?.stringValue { Text(error).foregroundStyle(.red) }
                    }
                }
                Section("Reports") { NavigationLink("Capture analytics") { PathwayEmailAnalyticsView(model: model, environment: environment) } }
                Section {
                    TextField("Maximum messages", value: $maxMessages, format: .number).keyboardType(.numberPad)
                    TextField("Maximum age in days", value: $maxAgeDays, format: .number).keyboardType(.numberPad)
                    Toggle("Desktop capture banners", isOn: $toastsEnabled)
                } header: { Text("Retention") } footer: { Text("Capture banners appear in the desktop app. Captured email notifications are not yet supported on this device.") }
                Section("Project capture") {
                    ForEach((snapshot["settings"]?.objectValue?["projects"]?.arrayValue ?? []).compactMap(\.objectValue).map { PathwayCalendarRecord(companyID: environment.companyId, kind: "projectCapture", fields: $0.merging(["id": $0["projectId"] ?? .string("")]) { _, next in next }) }) { project in
                        NavigationLink(project.string("mailSlug")) { PathwayEmailProjectCaptureView(model: model, environment: environment, original: project) }
                    }
                }
                Button("Save capture settings") {
                    Task {
                        _ = await model.perform {
                            // Refresh before replacing the full document so other project settings are retained.
                            let current = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.getSettings")
                            guard var settings = current.objectValue?["settings"]?.objectValue else { throw PathwayIssueWriteError(message: "Capture settings are unavailable.") }
                            settings["listener"] = .object(["enabled": .bool(enabled), "bindAddress": .string(bindAddress), "port": .number(Double(port))])
                            settings["retention"] = .object(["maxMessages": .number(Double(maxMessages)), "maxAgeDays": .number(Double(maxAgeDays))])
                            settings["toastsEnabled"] = .bool(toastsEnabled)
                            self.snapshot = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.updateSettings", fields: ["settings": .object(settings)]).objectValue
                        }
                    }
                }.disabled(model.isWriting || !(1...65535).contains(port) || maxMessages < 1 || maxAgeDays < 1 || bindAddress.isEmpty)
            } else if !loading { Button("Retry") { Task { await load() } } }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .accessibilityIdentifier("email-capture-settings")
        .navigationTitle(environment.environment.label)
        .task { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            snapshot = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.getSettings").objectValue
            let settings = snapshot?["settings"]?.objectValue ?? [:]
            let listener = settings["listener"]?.objectValue ?? [:]
            enabled = listener["enabled"]?.boolValue ?? true; bindAddress = listener["bindAddress"]?.stringValue ?? "0.0.0.0"; port = listener["port"]?.intValue ?? 1025
            maxMessages = settings["retention"]?.objectValue?["maxMessages"]?.intValue ?? 500
            maxAgeDays = settings["retention"]?.objectValue?["maxAgeDays"]?.intValue ?? 7
            toastsEnabled = settings["toastsEnabled"]?.boolValue ?? true
        } catch { model.errorMessage = error.localizedDescription }
    }
}

private struct PathwayEmailProjectCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayEmailModel
    let environment: PathwayCompanyEnvironment
    let original: PathwayCalendarRecord
    @State private var slug = ""
    @State private var password = ""
    @State private var muted = false
    @State private var codeRegex = ""
    @State private var retentionMessages = ""
    @State private var retentionDays = ""
    @State private var clearing = false
    var body: some View {
        Form {
            TextField("Mail slug", text: $slug).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("SMTP routing password (optional)", text: $password).textInputAutocapitalization(.never).autocorrectionDisabled()
            Toggle("Mute this project's desktop banners", isOn: $muted)
            TextField("Code extraction pattern (optional)", text: $codeRegex).textInputAutocapitalization(.never).autocorrectionDisabled()
            Section {
                TextField("Maximum messages (inherit if empty)", text: $retentionMessages).keyboardType(.numberPad)
                TextField("Maximum age in days (inherit if empty)", text: $retentionDays).keyboardType(.numberPad)
            } header: { Text("Retention overrides") } footer: { Text("Leave a value empty to use the environment's retention policy.") }
            Section {
                NavigationLink("Trigger rules and firing history") { PathwayEmailAutomationView(model: model, environment: environment, projectID: original.entityID) }
                NavigationLink("Project capture analytics") { PathwayEmailAnalyticsView(model: model, environment: environment, projectID: original.entityID) }
                Button("Clear project inbox", role: .destructive) { clearing = true }.disabled(model.isWriting)
            }
            Button("Save project capture") {
                Task {
                    if await model.perform({
                        let current = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.getSettings")
                        guard var settings = current.objectValue?["settings"]?.objectValue,
                              var projects = settings["projects"]?.arrayValue,
                              let index = projects.firstIndex(where: { $0.objectValue?["projectId"]?.stringValue == original.entityID }), var project = projects[index].objectValue else {
                            throw PathwayIssueWriteError(message: "This project capture configuration no longer exists.")
                        }
                        project["mailSlug"] = .string(slug); project["capturePassword"] = password.isEmpty ? .null : .string(password)
                        project["toastMuted"] = .bool(muted); project["twoFactorCodeRegex"] = codeRegex.isEmpty ? .null : .string(codeRegex)
                        project["retention"] = .object(["maxMessages": try PathwayEmailRetentionOverride.parse(retentionMessages), "maxAgeDays": try PathwayEmailRetentionOverride.parse(retentionDays)])
                        projects[index] = .object(project); settings["projects"] = .array(projects)
                        _ = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.updateSettings", fields: ["settings": .object(settings)])
                    }) { dismiss() }
                }
            }.disabled(model.isWriting || slug.isEmpty)
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Project capture")
        .onAppear {
            slug = original.string("mailSlug"); password = original.string("capturePassword"); muted = original.fields["toastMuted"]?.boolValue ?? false; codeRegex = original.string("twoFactorCodeRegex")
            retentionMessages = original.fields["retention"]?.objectValue?["maxMessages"]?.intValue.map(String.init) ?? ""
            retentionDays = original.fields["retention"]?.objectValue?["maxAgeDays"]?.intValue.map(String.init) ?? ""
        }
        .confirmationDialog("Clear all captured mail in this project inbox?", isPresented: $clearing, titleVisibility: .visible) {
            Button("Clear inbox", role: .destructive) { Task { _ = await model.perform { _ = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.clearInbox", fields: ["scope": .object(["type": .string("project"), "projectId": .string(original.entityID)])]) } } }
        }
    }
}
