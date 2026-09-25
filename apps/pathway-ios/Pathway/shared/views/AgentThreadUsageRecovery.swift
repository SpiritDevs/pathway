import SwiftUI

/// The environment owns recovery; this view only subscribes and edits its persisted timer.
struct AgentThreadUsageRecovery: View {
    let model: PathwayAgentThreadModel
    @State private var result: [String: JSONValue] = [:]
    @State private var error: String?
    @State private var isBusy = false
    @State private var editor: RecoveryEditor?

    private struct RecoveryEditor: Identifiable {
        let id = UUID()
        let sourceRunID: String
        let date: Date
    }

    private var supported: Bool {
        model.serverConfig["usageRecovery"]?.boolValue == true
    }
    private var recovery: [String: JSONValue] { result["recovery"]?.objectValue ?? [:] }
    private var eligibility: [String: JSONValue]? { result["eligibility"]?.objectValue }
    private var status: String? { recovery["status"]?.stringValue }
    private var inherited: Bool { recovery["threadId"]?.stringValue.map { $0 != model.threadID } ?? false }
    private var scheduled: Bool { status == "scheduled" }
    private var monitoring: Bool { status == "monitoring" }
    private var paused: Bool { recovery["reason"]?.stringValue == "pause" && !inherited }
    /// A pause still waiting for its run to finish the current step.
    private var pausing: Bool { paused && scheduled && recovery["pausedAt"]?.stringValue == nil }
    private var resumeDate: Date? { recovery["resumeAt"]?.stringValue.flatMap(pathwayDate(from:)) }
    private var resetDate: Date? { eligibility?["resetAt"]?.stringValue.flatMap(pathwayDate(from:)) }

    /// Once the reported reset has passed there is nothing to wait for, so offer to resume now.
    private func canResumeNow(at now: Date) -> Bool {
        guard !scheduled, !monitoring, !inherited, let resetDate else { return false }
        return resetDate <= now
    }

    var body: some View {
        Group {
            if supported && (eligibility != nil || scheduled || monitoring || status == "failed" || error != nil) {
                TimelineView(.everyMinute) { context in
                    content(resumeNow: canResumeNow(at: context.date))
                }
            }
        }
        .task(id: "\(model.threadID):\(supported):\(model.connectionState == .live)") {
            guard supported, model.connectionState == .live, let rpc = model.rpc else { return }
            do {
                for try await value in await rpc.subscribe("usageRecovery.subscribe", payload: .object(["threadId": .string(model.threadID)])) {
                    guard !Task.isCancelled else { return }
                    result = value.objectValue ?? [:]
                    error = nil
                }
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
        .sheet(item: $editor) { selection in
            RecoverySheet(model: model, sourceRunID: selection.sourceRunID, initialDate: selection.date)
        }
    }

    private func content(resumeNow: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(resumeNow ? "Usage allowance reset" : title, systemImage: paused ? "pause.circle" : "alarm").font(.subheadline.weight(.medium))
            Text(error ?? (resumeNow ? "Resume this thread and its unfinished children now, with their context." : recovery["message"]?.stringValue ?? "Resume this thread and its unfinished children after the allowance resets."))
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if paused && scheduled && !pausing, let sourceRunID = recovery["sourceRunId"]?.stringValue {
                    Button(isBusy ? "Resuming…" : "Resume now") {
                        Task { await schedule(sourceRunID: sourceRunID) }
                    }
                }
                if !monitoring && !inherited, let sourceRunID = eligibility?["sourceRunId"]?.stringValue {
                    if resumeNow {
                        Button(isBusy ? "Resuming…" : "Resume now") {
                            Task { await schedule(sourceRunID: sourceRunID) }
                        }
                    } else {
                        Button(scheduled ? "Change time" : "Resume after reset") {
                            let suggested = eligibility?["suggestedResumeAt"]?.stringValue.flatMap(pathwayDate(from:))
                            editor = RecoveryEditor(sourceRunID: sourceRunID, date: max((scheduled ? resumeDate : suggested) ?? Date().addingTimeInterval(60), Date().addingTimeInterval(60)))
                        }
                    }
                }
                if (scheduled || monitoring) && !inherited {
                    Button(paused ? "Cancel pause" : "Cancel recovery", role: .cancel) {
                        Task { await cancel() }
                    }
                }
            }
            .buttonStyle(.bordered).controlSize(.small).disabled(isBusy || model.connectionState != .live)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("agent-thread-usage-recovery")
    }

    private var title: String {
        if inherited { return "Included in the parent thread’s recovery" }
        if pausing { return "Pausing after the current step" }
        if paused && scheduled, let resumeDate { return "Paused until \(resumeDate.formatted(date: .abbreviated, time: .shortened))" }
        if paused && monitoring { return "Resuming paused work · attempt \(recovery["attempts"]?.intValue ?? 1) of 3" }
        if scheduled, let resumeDate { return "Resume thread + children \(resumeDate.formatted(date: .abbreviated, time: .shortened))" }
        if monitoring { return "Resuming thread + children · attempt \(recovery["attempts"]?.intValue ?? 1) of 3" }
        if status == "failed" { return "Automatic recovery needs attention" }
        return "Usage limit reached"
    }

    /// The environment starts a recovery whose time has already passed on its next tick.
    private func schedule(sourceRunID: String) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await model.request("usageRecovery.schedule", payload: .object([
                "commandId": .string(UUID().uuidString), "threadId": .string(model.threadID),
                "sourceRunId": .string(sourceRunID), "resumeAt": .string(Date().ISO8601Format()),
            ]), reportsErrors: false)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func cancel() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            result = try await model.request("usageRecovery.cancel", payload: .object(["threadId": .string(model.threadID)]), reportsErrors: false).objectValue ?? [:]
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct RecoverySheet: View {
    let model: PathwayAgentThreadModel
    let sourceRunID: String
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var isBusy = false
    @State private var error: String?

    init(model: PathwayAgentThreadModel, sourceRunID: String, initialDate: Date) {
        self.model = model
        self.sourceRunID = sourceRunID
        _date = State(initialValue: initialDate)
    }

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Resume at", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                Text("When a reset time is available, the suggestion includes a one-minute margin. Otherwise, choose the reset time yourself. Recovery allows up to three attempts and includes unfinished children. Your environment must be running; if it is offline, recovery starts when it returns.")
                    .font(.caption).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Resume after reset")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(isBusy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isBusy ? "Scheduling…" : "Schedule") { Task { await schedule() } }.disabled(isBusy || model.connectionState != .live)
                }
            }
        }
        .interactiveDismissDisabled(isBusy)
    }

    private func schedule() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await model.request("usageRecovery.schedule", payload: .object([
                "commandId": .string(UUID().uuidString), "threadId": .string(model.threadID),
                "sourceRunId": .string(sourceRunID), "resumeAt": .string(date.ISO8601Format()),
            ]), reportsErrors: false)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
