import SwiftUI

struct PathwayAdministrationSchedulesView: View {
    let client: PathwayAdministrationClient
    @State private var tasks: [PathwayAdministrationSchedule] = []
    @State private var busy = false
    @State private var error: String?
    @State private var pendingIDs = Set<String>()
    @State private var selected: PathwayAdministrationSchedule?
    @State private var confirmation: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if busy { ProgressView("Loading scheduled tasks…") }
            ForEach(tasks) { task in
                NavigationLink {
                    PathwayAdministrationScheduleEditor(client: client, task: task)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                        Text("\(task.enabled ? "Enabled" : "Paused") · \(task.lastRunStatus) · \(task.runCount) runs").font(.caption).foregroundStyle(.secondary)
                        if let next = task.nextRunAt { Text("Next: \(next)").font(.caption) }
                        if let error = task.lastRunError { Text(error).font(.caption).foregroundStyle(.red) }
                    }
                }
                .disabled(pendingIDs.contains(task.id))
                .swipeActions {
                    Button(task.enabled ? "Pause" : "Enable") { Task { await toggle(task) } }.tint(.orange)
                    Button("Delete", role: .destructive) { selected = task; confirmation = "delete" }
                }
                .contextMenu {
                    Button("Run now") { selected = task; confirmation = "run" }
                    Button(task.enabled ? "Pause" : "Enable") { Task { await toggle(task) } }
                }
            }
            if tasks.isEmpty && !busy { Text("No scheduled tasks") }
        }.navigationTitle("Scheduled tasks")
            .toolbar { NavigationLink { PathwayAdministrationScheduleEditor(client: client) } label: { Image(systemName: "plus") }.accessibilityLabel("Add scheduled task") }
            .task { await load() }.refreshable { await load() }
            .confirmationDialog(confirmation == "delete" ? "Delete scheduled task?" : "Run scheduled task now?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
                Button(confirmation == "delete" ? "Delete" : "Run now", role: confirmation == "delete" ? .destructive : nil) {
                    if let selected, let confirmation { self.confirmation = nil; Task { await act(selected, action: confirmation) } }
                }
                Button("Cancel", role: .cancel) { confirmation = nil }
            }
    }
    private func load() async {
        busy = true; defer { busy = false }
        do { let result: PathwayAdministrationScheduleList = try await client.call("scheduledTasks.list"); tasks = result.tasks; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func toggle(_ task: PathwayAdministrationSchedule) async {
        guard pendingIDs.insert(task.id).inserted else { return }; defer { pendingIDs.remove(task.id) }
        do { _ = try await client.run("scheduledTasks.setEnabled", ["id": .string(task.id), "enabled": .bool(!task.enabled)]); await load() }
        catch { self.error = error.localizedDescription }
    }
    private func act(_ task: PathwayAdministrationSchedule, action: String) async {
        guard pendingIDs.insert(task.id).inserted else { return }; defer { pendingIDs.remove(task.id) }
        do { _ = try await client.run(action == "delete" ? "scheduledTasks.delete" : "scheduledTasks.runNow", ["id": .string(task.id)]); await load() }
        catch { self.error = error.localizedDescription }
    }
}

struct PathwayAdministrationScheduleEditor: View {
    let client: PathwayAdministrationClient
    var task: PathwayAdministrationSchedule?
    @Environment(\.dismiss) private var dismiss
    @State private var draft = PathwayAdministrationScheduleDraft()
    @State private var projects: [PathwayAdministrationProject] = []
    @State private var providers: [PathwayAdministrationProvider] = []
    @State private var error: String?
    @State private var busy = false
    @State private var initialized = false
    private var models: [PathwayAdministrationProvider.Model] { providers.first { $0.id == draft.instanceID }?.models ?? [] }
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            Section("Task") {
                TextField("Title", text: $draft.title)
                TextField("Instructions", text: $draft.prompt, axis: .vertical).lineLimit(4...12)
                Toggle("Enabled", isOn: $draft.enabled)
                Picker("Project", selection: $draft.projectID) {
                    Text("Choose project").tag("")
                    ForEach(projects) { Text($0.title).tag($0.id) }
                }
                TextField("Existing thread ID (optional)", text: $draft.threadID).autocorrectionDisabled().textInputAutocapitalization(.never)
            }
            Section {
                Picker("Schedule", selection: $draft.scheduleType) { Text("Interval").tag("interval"); Text("Time of day").tag("fixed_time") }
                if draft.scheduleType == "interval" { Stepper("Every \(draft.intervalMinutes.formatted()) minutes", value: $draft.intervalMinutes, in: 1...525_600) }
                else {
                    TextField("24-hour time (HH:MM)", text: $draft.timeOfDay)
                    ForEach(0..<7, id: \.self) { day in
                        Toggle(Calendar.current.weekdaySymbols[day], isOn: Binding(get: { draft.weekdays.contains(day) }, set: { if $0 { draft.weekdays.insert(day) } else { draft.weekdays.remove(day) } }))
                    }
                }
            } footer: { Text("Time-of-day schedules use the environment's local time zone. No selected weekdays means every day.") }
            Section("Execution") {
                Picker("Provider", selection: Binding(get: { draft.instanceID }, set: { value in
                    if value != draft.instanceID { draft.instanceID = value; draft.model = "" }
                })) { Text("Choose provider").tag(""); ForEach(providers) { Text($0.name).tag($0.id) } }
                Picker("Model", selection: $draft.model) { Text("Choose model").tag(""); ForEach(models) { Text($0.name).tag($0.slug) } }
                Picker("Access", selection: $draft.runtimeMode) {
                    Text("Ask for approval").tag("approval-required"); Text("Accept edits").tag("auto-accept-edits"); Text("Automatic").tag("auto"); Text("Full access").tag("full-access")
                }
                Picker("Interaction", selection: $draft.interactionMode) { Text("Default").tag("default"); Text("Plan").tag("plan") }
                Picker("Workspace", selection: $draft.workspaceType) { Text("New worktree").tag("worktree"); Text("Project root").tag("root"); Text("Existing worktree").tag("existing_worktree") }
                if draft.workspaceType == "worktree" { TextField("Base branch", text: $draft.baseRef).autocorrectionDisabled().textInputAutocapitalization(.never) }
                if draft.workspaceType == "existing_worktree" { TextField("Worktree path", text: $draft.worktreePath).autocorrectionDisabled().textInputAutocapitalization(.never) }
            }
            if let task {
                Section("Latest run") {
                    LabeledContent("Status", value: task.lastRunStatus)
                    LabeledContent("Run count", value: "\(task.runCount)")
                    if let date = task.lastRunAt { Text(date) }
                    if let error = task.lastRunError { Text(error).foregroundStyle(.red) }
                    Text("Earlier run history is not exposed by this environment's scheduled-task contract.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Button("Save task") { Task { await save() } }.disabled(busy || !draft.isValid)
        }.navigationTitle(task == nil ? "New scheduled task" : "Edit scheduled task")
            .disabled(busy)
            .task {
                guard !initialized else { return }; initialized = true
                draft = .init(task: task); busy = true; defer { busy = false }
                do { projects = try await client.projects(); let config: PathwayAdministrationConfig = try await client.call("server.getConfig"); providers = config.providers }
                catch { self.error = error.localizedDescription }
            }
    }
    private func save() async {
        busy = true; defer { busy = false }
        do { _ = try await client.run("scheduledTasks.upsert", try draft.payload()); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}
