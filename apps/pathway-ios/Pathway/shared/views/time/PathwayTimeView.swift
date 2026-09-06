import SwiftUI

struct PathwayTimeView: View {
    @Bindable var model: PathwayTimeModel
    let accountID: String
    var projects: [PathwayCompanyProject] = []
    var initialFilter = "all"
    @State private var period = "all"
    @State private var description = ""
    @State private var projectID = ""
    @State private var retry = 0
    @State private var deleting: PathwayTrackedSession?
    @State private var discard = false
    private var windowStart: Date? {
        if period == "today" { return Calendar.current.startOfDay(for: .now) }
        if period == "this-week" { var calendar = Calendar.current; calendar.firstWeekday = 2; return calendar.dateInterval(of: .weekOfYear, for: .now)?.start }
        return nil
    }
    private var displayedEntries: [PathwayTrackedSession] { model.entries.filter { entry in windowStart.map { (entry.stoppedAt.flatMap(pathwayDate) ?? entry.start) >= $0 } ?? true } }
    private var total: Double { displayedEntries.reduce(0) { sum, entry in
        let start = max(entry.start, windowStart ?? .distantPast)
        let end = entry.stoppedAt.flatMap(pathwayDate) ?? entry.start
        return sum + max(0, end.timeIntervalSince(start) * 1_000)
    } }
    var body: some View {
        List {
            if model.hasPendingCommand {
                Section("Pending timer change") {
                    Text("A previous timer change has not been confirmed. Retry it with the same identity, or discard it after checking the current timer.")
                    Button("Retry change") { run { try await model.retryPending() } }.disabled(model.writing)
                    Button("Discard pending change", role: .destructive) { discard = true }.disabled(model.writing)
                }
            }
            Section("Current timer") {
                if let active = model.active {
                    Text(active.description).font(.headline)
                    Text(active.projectName).foregroundStyle(.secondary)
                    Text(active.start, style: .timer).monospacedDigit().font(.title)
                    Button("Stop timer", systemImage: "stop.fill") { run { try await model.stop(active) } }.disabled(model.writing || model.hasPendingCommand)
                } else {
                    TextField("What are you working on?", text: $description)
                    Picker("Project", selection: $projectID) {
                        Text("No project").tag("")
                        ForEach(projects) { Text($0.project.name).tag($0.id) }
                    }
                    Button("Start timer", systemImage: "play.fill") {
                        run {
                            try await model.start(description: description, projectKey: projectID, projectName: projects.first { $0.id == projectID }?.project.name ?? "No project")
                            description = ""
                        }
                    }.disabled(model.writing || model.loading || model.hasPendingCommand || accountID.isEmpty || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            Section("Sessions") {
                Picker("Period", selection: $period) { Text("Today").tag("today"); Text("This week").tag("this-week"); Text("All sessions").tag("all") }
                LabeledContent("Total", value: Duration.milliseconds(total).formatted(.time(pattern: .hourMinute)))
                if model.loading { ProgressView("Loading tracked time…") }
                ForEach(displayedEntries) { entry in
                    HStack {
                        VStack(alignment: .leading) { Text(entry.description); Text(entry.projectName).font(.caption).foregroundStyle(.secondary); Text(entry.start, format: .dateTime.day().month().hour().minute()).font(.caption) }
                        Spacer()
                        Text(Duration.milliseconds(entry.durationMs).formatted(.time(pattern: .hourMinute))).monospacedDigit()
                    }
                    .swipeActions { Button("Delete", role: .destructive) { deleting = entry } }
                    .contextMenu { Button("Delete session", role: .destructive) { deleting = entry } }
                }
            }
            if let error = model.errorMessage { Section { Text(error).foregroundStyle(.red); Button("Reconnect") { retry += 1 } } }
        }
        .navigationTitle("Time Tracker")
        .onChange(of: initialFilter, initial: true) { period = initialFilter }
        .task(id: "\(accountID):\(retry)") { await model.observe(accountID: accountID) }
        .confirmationDialog("Delete this tracked session?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let entry = deleting { Button("Delete session", role: .destructive) { run { try await model.remove(entry); deleting = nil } } }
        }
        .confirmationDialog("Discard this pending command?", isPresented: $discard, titleVisibility: .visible) {
            Button("Discard command", role: .destructive) { model.discardPending() }
        } message: { Text("This removes the local retry. A timer change already accepted by the server is not undone.") }
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) { Task { _ = await model.perform(operation) } }
}
