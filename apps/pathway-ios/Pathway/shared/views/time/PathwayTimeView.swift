import SwiftUI

struct PathwayTimeView: View {
    @Bindable var model: PathwayTimeModel
    let accountID: String
    var projects: [PathwayCompanyProject] = []
    var initialFilter = "all"
    @Environment(\.scenePhase) private var scenePhase
    @State private var period = "all"
    @State private var description = ""
    @State private var projectID = ""
    @State private var retry = 0
    @State private var deleting: PathwayTrackedSession?
    @State private var discard = false
    private var windowStart: Date? {
        if period == "today" { return Calendar.current.startOfDay(for: .now) }
        if period == "month" { return Calendar.current.date(byAdding: .day, value: -29, to: Calendar.current.startOfDay(for: .now)) }
        if period == "this-week" { var calendar = Calendar.current; calendar.firstWeekday = 2; return calendar.dateInterval(of: .weekOfYear, for: .now)?.start }
        return nil
    }
    private var displayedEntries: [PathwayTrackedSession] { model.entries.filter { entry in windowStart.map { (entry.stoppedAt.flatMap(pathwayDate) ?? entry.start) >= $0 } ?? true } }
    private var total: Double { displayedEntries.reduce(0) { $0 + $1.durationMs } }
    private var agentSessions: [PathwayActiveTrackedSession] { model.activeSessions.filter { $0.source == "agent" } }
    var body: some View {
        List {
            if model.hasPendingCommand {
                Section("Pending timer change") {
                    Text("A previous timer change has not been confirmed. Retry it with the same identity, or discard it after checking the current timer.")
                    Button("Retry change") { run { try await model.retryPending() } }.disabled(model.writing)
                    Button("Discard pending change", role: .destructive) { discard = true }.disabled(model.writing)
                }
            }
            Section("Manual timer") {
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
                            try await model.start(description: description, project: projects.first { $0.id == projectID })
                            description = ""
                        }
                    }.disabled(model.writing || model.loading || model.hasPendingCommand || accountID.isEmpty || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if !agentSessions.isEmpty {
                Section("Tracking now") {
                    PathwayActiveTimeRows(sessions: agentSessions)
                    if !model.activeSessionsComplete { Text("Showing a limited set of active sessions.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if let error = model.activeSessionsError { Section { Text("Active timers unavailable: \(error)").foregroundStyle(.secondary) } }
            Section("Work overview") {
                Picker("Period", selection: $period) { Text("Today").tag("today"); Text("This week").tag("this-week"); Text("Last 30 days").tag("month"); Text("All sessions").tag("all") }
                if period == "all" { Text("Analytics show this week. History includes all sessions.").font(.caption).foregroundStyle(.secondary) }
                if let overview = model.totals, overview.complete {
                    PathwayTimeSummaryRows(totals: overview.totals)
                } else if model.totals?.complete == false {
                    Text("This period has too many sessions to summarize. Choose a shorter period. All sessions remain in history.").foregroundStyle(.secondary)
                } else if let error = model.totalsError {
                    Text("Analytics unavailable: \(error)").foregroundStyle(.secondary)
                } else { ProgressView("Loading analytics…") }
            }
            if let overview = model.totals, overview.complete {
                if !overview.projects.isEmpty {
                    Section("By project") {
                        ForEach(overview.projects) { project in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(project.projectName).font(.headline)
                                LabeledContent("Combined work", value: formattedTime(project.workMs))
                                LabeledContent("Elapsed activity", value: formattedTime(project.elapsedMs)).foregroundStyle(.secondary)
                            }.font(.caption)
                        }
                    }
                }
                if overview.days.contains(where: { $0.workMs > 0 }) {
                    Section("Daily activity") {
                        ForEach(overview.days) { day in
                            LabeledContent(day.date, value: formattedTime(day.workMs)).monospacedDigit()
                        }
                    }
                }
            }
            Section("Sessions") {
                LabeledContent("Loaded sessions total", value: formattedTime(total))
                if model.loading { ProgressView("Loading tracked time…") }
                ForEach(displayedEntries) { entry in
                    HStack {
                        VStack(alignment: .leading) { Text(entry.description); Text(entry.projectName).font(.caption).foregroundStyle(.secondary); Text(entry.source == "agent" ? "Agent" : entry.source == "issue" ? "Task creation" : "Manual").font(.caption2).foregroundStyle(.secondary); Text(entry.start, format: .dateTime.day().month().hour().minute()).font(.caption) }
                        Spacer()
                        Text(Duration.milliseconds(entry.durationMs).formatted(.time(pattern: .hourMinute))).monospacedDigit()
                    }
                    .swipeActions { Button("Delete", role: .destructive) { deleting = entry } }
                    .contextMenu { Button("Delete session", role: .destructive) { deleting = entry } }
                }
            }
            if model.hasMore {
                Section { Button(model.loadingMore ? "Loading…" : "Load more sessions") { run { try await model.loadMore() } }.disabled(model.loadingMore) }
            }
            if let error = model.errorMessage { Section { Text(error).foregroundStyle(.red); Button("Reconnect") { retry += 1 } } }
        }
        .navigationTitle("Time Tracker")
        .onChange(of: initialFilter, initial: true) { period = initialFilter }
        .task(id: "\(accountID):\(period):\(retry)") { await model.observe(accountID: accountID, since: windowStart) }
        .refreshable { retry += 1 }
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in
            if scenePhase == .active, model.active != nil || model.activeSessions.contains(where: { $0.state == "running" }) {
                Task { await model.refreshAnalytics() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in retry += 1 }
        .onChange(of: scenePhase) { _, phase in if phase == .active { retry += 1 } }
        .confirmationDialog("Delete this tracked session?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let entry = deleting { Button("Delete session", role: .destructive) { run { try await model.remove(entry); deleting = nil } } }
        }
        .confirmationDialog("Discard this pending command?", isPresented: $discard, titleVisibility: .visible) {
            Button("Discard command", role: .destructive) { model.discardPending() }
        } message: { Text("This removes the local retry. A timer change already accepted by the server is not undone.") }
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) { Task { _ = await model.perform(operation) } }
}

private func formattedTime(_ milliseconds: Double) -> String {
    Duration.milliseconds(milliseconds).formatted(.time(pattern: .hourMinute))
}

private struct PathwayTimeSummaryRows: View {
    let totals: PathwayTimeTotals
    var body: some View {
        LabeledContent("Combined work", value: formattedTime(totals.workMs)).font(.headline)
        LabeledContent("Elapsed activity", value: formattedTime(totals.elapsedMs))
        LabeledContent("Agent work", value: formattedTime(totals.agentMs))
        LabeledContent("Your work", value: formattedTime(totals.manualMs + totals.issueMs))
        Text("Each concurrent session adds to combined work. Elapsed activity counts overlaps once. Paused agent time is excluded.").font(.caption).foregroundStyle(.secondary)
    }
}

private struct PathwayActiveTimeRows: View {
    let sessions: [PathwayActiveTrackedSession]
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        if scenePhase == .active, sessions.contains(where: { $0.state == "running" }) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                rows(at: context.date)
            }
        } else {
            rows(at: .now)
        }
    }
    private func rows(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sessions) { session in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.description).font(.headline)
                        Text(session.projectName).font(.caption).foregroundStyle(.secondary)
                        Text(session.status(at: now)).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(Duration.milliseconds(session.duration(at: now)).formatted(.time(pattern: .hourMinuteSecond))).monospacedDigit()
                }.accessibilityElement(children: .combine)
            }
        }
    }
}
