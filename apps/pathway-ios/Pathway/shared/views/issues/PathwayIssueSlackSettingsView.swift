import SwiftUI

struct PathwayIssueSlackSettingsView: View {
    let model: PathwayIssuesModel
    let companyID: String
    let environmentID: String
    @State private var token = ""
    @State private var status: [String: JSONValue] = [:]
    @State private var watches: [PathwayIssueEntity] = []
    @State private var channels: [PathwayIssueEntity] = []
    @State private var editingWatch: PathwayIssueEntity?
    @State private var creating = false
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var removing: PathwayIssueEntity?
    @State private var disconnecting = false

    var body: some View {
        Form {
            Section("Slack connection") {
                LabeledContent("Workspace", value: status["workspaceName"]?.stringValue ?? (status["configured"]?.boolValue == true ? "Connected" : "Not connected"))
                if let error = status["lastError"]?.stringValue { Text(error).font(.caption).foregroundStyle(.red) }
                if let rawDate = status["lastPollAt"], let date = pathwayIssueDate(rawDate) {
                    LabeledContent("Last checked") { Text(date, style: .relative) }
                }
                SecureField("Bot token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(status["configured"]?.boolValue == true ? "Replace token" : "Connect Slack") {
                    perform { try await setToken(token) }
                }.disabled(token.isEmpty || token.count > 512)
                if status["configured"]?.boolValue == true {
                    Button("Disconnect Slack", role: .destructive) { disconnecting = true }
                }
            }
            Section {
                ForEach(watches) { watch in
                    Button { editingWatch = watch } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("#\(watch.fields["channelName"]?.stringValue ?? "Channel")").foregroundStyle(.primary)
                            Text(triggerSummary(watch)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions { Button("Delete", role: .destructive) { removing = watch } }
                }
                Button("Watch a channel", systemImage: "plus") {
                    perform {
                        let response = try await request("issues.slackListChannels")
                        channels = entities(response.objectValue?["channels"], kind: "slackChannel")
                        creating = true
                    }
                }.disabled(status["configured"]?.boolValue != true)
            } header: { Text("Watched channels") } footer: {
                Text("Each channel controls which messages become triage tasks. Reaction routes run in the order shown.")
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
        }
        .navigationTitle("Slack intake").navigationBarTitleDisplayMode(.inline)
        .disabled(busy)
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } } } }
        .task(id: environmentID) { await refresh() }
        .onChange(of: model.environmentState(companyID: companyID, environmentID: environmentID)) { _, state in
            if let nextStatus = state["slackStatus"]?.objectValue { status = nextStatus }
            if let nextWatches = state["slackWatches"] { watches = entities(nextWatches, kind: "slackWatch") }
        }
        .sheet(isPresented: $creating) { editor(nil) }
        .sheet(item: $editingWatch) { editor($0) }
        .confirmationDialog("Delete this channel watch?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Delete watch", role: .destructive) {
                guard let watch = removing else { return }
                perform {
                    let response = try await request("issues.slackWatchDelete", ["watchId": .string(watch.id)])
                    watches = entities(response.objectValue?["watches"], kind: "slackWatch")
                    removing = nil
                }
            }
        }
        .confirmationDialog("Disconnect Slack?", isPresented: $disconnecting, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { perform { try await setToken("") } }
        } message: { Text("Intake stops until another token is connected. Your channel rules stay saved.") }
    }

    private func editor(_ watch: PathwayIssueEntity?) -> some View {
        PathwayIssueSlackWatchEditor(model: model, companyID: companyID, environmentID: environmentID,
                                    watch: watch, channels: channels.filter { channel in !watches.contains { $0.fields["channelId"]?.stringValue == channel.id } }) { next in
            watches = next
        }
    }
    private func refresh() async {
        busy = true
        defer { busy = false }
        do {
            let response = try await request("issues.slackGetStatus")
            status = response.objectValue?["status"]?.objectValue ?? [:]
            let fields = model.environmentState(companyID: companyID, environmentID: environmentID)
            watches = entities(fields["slackWatches"], kind: "slackWatch")
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
    private func setToken(_ value: String) async throws {
        let response = try await request("issues.slackSetToken", ["token": .string(value)])
        status = response.objectValue?["status"]?.objectValue ?? [:]
        token = ""
    }
    private func request(_ method: String, _ fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await pathwayIssueSettingsRequest(model: model, companyID: companyID, environmentID: environmentID, method: method, fields: fields)
    }
    private func entities(_ value: JSONValue?, kind: String) -> [PathwayIssueEntity] {
        (value?.arrayValue ?? []).compactMap { $0.objectValue }.map { .init(companyId: companyID, kind: kind, fields: $0) }
    }
    private func triggerSummary(_ watch: PathwayIssueEntity) -> String {
        let trigger = watch.fields["trigger"]?.objectValue ?? [:]
        var parts: [String] = []
        if trigger["everyMessage"]?.boolValue == true { parts.append("Every message") }
        if trigger["botMention"]?.boolValue == true { parts.append("Bot mentions") }
        let count = trigger["reactionRoutes"]?.arrayValue?.count ?? 0
        if count > 0 { parts.append("\(count) reaction rules") }
        return parts.isEmpty ? "Paused" : parts.joined(separator: " · ")
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await action(); errorMessage = nil } catch { errorMessage = error.localizedDescription } }
    }
}

private struct PathwayIssueSlackWatchEditor: View {
    let model: PathwayIssuesModel
    let companyID: String
    let environmentID: String
    let watch: PathwayIssueEntity?
    let channels: [PathwayIssueEntity]
    let onSaved: ([PathwayIssueEntity]) -> Void
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var channelID = ""
    @State private var channelName = ""
    @State private var projectID = ""
    @State private var cycleID = ""
    @State private var everyMessage = false
    @State private var botMention = false
    @State private var autoInvestigate = false
    @State private var autoAssign = false
    @State private var routes: [PathwaySlackReactionDraft] = []
    @State private var loaded = false
    @State private var busy = false
    @State private var errorMessage: String?

    private var projects: [PathwayCompanyEnvironmentBinding] {
        appModel.cloud.environmentBindings.filter { $0.companyId == companyID && $0.binding.environmentId == environmentID && $0.binding.status == "active" }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Channel") {
                    if watch == nil && !channels.isEmpty {
                        Picker("Channel", selection: $channelID) {
                            Text("Choose a channel").tag("")
                            ForEach(channels) { Text("#\($0.name)").tag($0.id) }
                        }.onChange(of: channelID) { _, id in channelName = channels.first { $0.id == id }?.name ?? channelName }
                    }
                    if watch == nil {
                        TextField("Channel ID", text: $channelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    TextField("Channel name", text: $channelName).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("Triggers") {
                    Toggle("Every message", isOn: $everyMessage)
                    Toggle("Bot mentions", isOn: $botMention)
                    Text("Turn off both triggers and remove reaction routes to pause this watch.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Channel defaults") {
                    projectPicker("Project", selection: $projectID, none: "No project")
                    Picker("Cycle", selection: $cycleID) {
                        Text("No cycle").tag("")
                        ForEach(model.cycles.filter { $0.companyId == companyID }) { Text($0.name).tag($0.id) }
                    }
                    Toggle("Investigate automatically", isOn: $autoInvestigate)
                    Toggle("Assign agent automatically", isOn: $autoAssign)
                }
                Section {
                    ForEach($routes) { $route in
                        DisclosureGroup(route.emoji.isEmpty ? "New reaction" : ":\(route.emoji):") {
                            TextField("Reaction name, e.g. ticket", text: $route.emoji).textInputAutocapitalization(.never).autocorrectionDisabled()
                            projectPicker("Project", selection: $route.projectID, none: "Use channel default")
                            Picker("Investigate", selection: $route.investigate) {
                                Text("Use channel default").tag("inherit")
                                Text("On").tag("on")
                                Text("Off").tag("off")
                            }
                        }
                    }
                    .onDelete { routes.remove(atOffsets: $0) }
                    .onMove { routes.move(fromOffsets: $0, toOffset: $1) }
                    Button("Add reaction route", systemImage: "plus") { routes.append(.init()) }.disabled(routes.count >= 20)
                } header: { Text("Reaction routes") } footer: { Text("The first matching reaction wins. Drag to set the order.") }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(watch == nil ? "Watch channel" : "Edit channel watch").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(busy || channelID.isEmpty || channelName.isEmpty) }
            }
            .interactiveDismissDisabled(busy)
            .task { load() }
        }
    }
    private func projectPicker(_ title: String, selection: Binding<String>, none: String) -> some View {
        Picker(title, selection: selection) {
            Text(none).tag("")
            ForEach(projects) { binding in
                Text(appModel.cloud.projects.first { $0.companyId == companyID && $0.project.id == binding.binding.cloudProjectId }?.project.name ?? binding.binding.localWorkspaceRoot)
                    .tag(binding.binding.localProjectId)
            }
        }
    }
    private func load() {
        guard !loaded else { return }; loaded = true
        guard let watch else { return }
        channelID = watch.fields["channelId"]?.stringValue ?? ""
        channelName = watch.fields["channelName"]?.stringValue ?? ""
        projectID = watch.fields["projectId"]?.stringValue ?? ""
        cycleID = watch.fields["cycleId"]?.stringValue ?? ""
        autoInvestigate = watch.fields["autoInvestigate"]?.boolValue ?? false
        autoAssign = watch.fields["autoAssign"]?.boolValue ?? false
        let trigger = watch.fields["trigger"]?.objectValue ?? [:]
        everyMessage = trigger["everyMessage"]?.boolValue ?? false
        botMention = trigger["botMention"]?.boolValue ?? false
        routes = (trigger["reactionRoutes"]?.arrayValue ?? []).compactMap { value in
            guard let fields = value.objectValue else { return nil }
            return PathwaySlackReactionDraft(emoji: fields["emoji"]?.stringValue ?? "", projectID: fields["projectId"]?.stringValue ?? "",
                                             investigate: fields["autoInvestigate"]?.boolValue.map { $0 ? "on" : "off" } ?? "inherit")
        }
    }
    private func save() async {
        let names = routes.map { $0.emoji.trimmingCharacters(in: CharacterSet(charactersIn: ":").union(.whitespacesAndNewlines)).lowercased() }
        guard names.allSatisfy({ !$0.isEmpty && $0.range(of: "^[a-z0-9_+-]+$", options: .regularExpression) != nil }), Set(names).count == names.count else {
            errorMessage = "Use a different Slack reaction name for each route, such as ticket or eyes."; return
        }
        busy = true
        defer { busy = false }
        let routeValues = zip(routes, names).map { route, name in
            JSONValue.object(["emoji": .string(name), "projectId": route.projectID.isEmpty ? .null : .string(route.projectID),
                              "autoInvestigate": route.investigate == "inherit" ? .null : .bool(route.investigate == "on")])
        }
        var patch: [String: JSONValue] = ["channelName": .string(channelName.trimmingCharacters(in: CharacterSet(charactersIn: "#").union(.whitespacesAndNewlines))),
            "projectId": projectID.isEmpty ? .null : .string(projectID), "cycleId": cycleID.isEmpty ? .null : .string(cycleID),
            "autoInvestigate": .bool(autoInvestigate), "autoAssign": .bool(autoAssign),
            "trigger": .object(["everyMessage": .bool(everyMessage), "botMention": .bool(botMention), "reactionRoutes": .array(routeValues)])]
        let fields: [String: JSONValue]
        if let watch { fields = ["watchId": .string(watch.id), "patch": .object(patch)] }
        else { patch["channelId"] = .string(channelID); fields = patch }
        do {
            let response = try await pathwayIssueSettingsRequest(model: model, companyID: companyID, environmentID: environmentID,
                                                                 method: watch == nil ? "issues.slackWatchCreate" : "issues.slackWatchUpdate", fields: fields)
            onSaved((response.objectValue?["watches"]?.arrayValue ?? []).compactMap { $0.objectValue }.map {
                PathwayIssueEntity(companyId: companyID, kind: "slackWatch", fields: $0)
            })
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct PathwaySlackReactionDraft: Identifiable {
    let id = UUID()
    var emoji = ""
    var projectID = ""
    var investigate = "inherit"
}
