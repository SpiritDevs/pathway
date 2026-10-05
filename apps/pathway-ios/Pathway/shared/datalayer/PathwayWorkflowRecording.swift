import Foundation

/// Record a skill, as the server reports it for one thread. The recording runs on the
/// environment's Mac; this device only reads status and sends start, stop, and cancel.
/// Captured content never crosses the wire, only the server-built prompt that points at it.
struct PathwayWorkflowRecordingStatus: Equatable {
    let supported: Bool
    let phase: String
    let recordingID: String?
    let startedAt: Date?
    let eventCount: Int
    let endReason: String?
    let message: String?
    let targetName: String?
    /// Set by the server for completed recordings only.
    let skillPrompt: String?

    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let phase = fields["phase"]?.stringValue else { return nil }
        supported = fields["supported"]?.boolValue == true
        self.phase = phase
        recordingID = fields["recordingId"]?.stringValue
        startedAt = fields["startedAt"]?.stringValue.flatMap(pathwayDate(from:))
        eventCount = fields["eventCount"]?.intValue ?? 0
        endReason = fields["endReason"]?.stringValue
        message = fields["message"]?.stringValue
        targetName = fields["targetName"]?.stringValue
        skillPrompt = phase == "completed" ? fields["skillPrompt"]?.stringValue : nil
    }

    /// The native helper is live and the status changes on its own.
    var isActive: Bool { ["awaiting-confirmation", "recording", "stopping"].contains(phase) }
}

/// Draft edits for the hand-off. The prompt is recognized by exact text, so a reload never
/// appends it twice and Discard or a new recording takes back only that prompt.
enum PathwayWorkflowSkillPrompt {
    static func append(_ prompt: String, to draft: String) -> String {
        guard !draft.contains(prompt) else { return draft }
        let kept = String(draft.reversed().drop(while: \.isWhitespace).reversed())
        return kept.isEmpty ? prompt : "\(kept)\n\n\(prompt)"
    }

    static func remove(_ prompt: String, from draft: String) -> String {
        guard draft.contains(prompt) else { return draft }
        let separated = "\n\n\(prompt)"
        let next = draft.contains(separated)
            ? draft.replacingOccurrences(of: separated, with: "")
            : draft.replacingOccurrences(of: prompt, with: "")
        return next.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : next
    }
}

@MainActor
@Observable
final class PathwayWorkflowRecordingModel {
    enum Command: String { case start, stop, cancel }

    private(set) var status: PathwayWorkflowRecordingStatus?
    private(set) var error: String?
    private(set) var pending: Command?
    /// Bumped around every command, so a read that raced one is dropped.
    @ObservationIgnored private var version = 0
    /// The read in flight, if any. Only that read may release it.
    @ObservationIgnored private var reading: UUID?

    /// How often to re-read: every second while live, slowly while another thread records or a
    /// saved recording waits, so its hand-off never points at files another device deleted.
    var pollInterval: Duration? {
        if status?.isActive == true { return .seconds(1) }
        return status?.phase == "busy" || status?.phase == "completed" ? .seconds(5) : nil
    }

    func clearError() { error = nil }

    func refresh(_ thread: PathwayAgentThreadModel) async {
        guard reading == nil else { return }
        let read = UUID()
        let current = version
        reading = read
        defer { if reading == read { reading = nil } }
        do {
            let value = try await thread.request("computer.recording.status", payload: Self.payload(thread), reportsErrors: false)
            guard current == version else { return }
            status = PathwayWorkflowRecordingStatus(value)
            error = nil
        } catch is CancellationError {
        } catch {
            // Keep the last known status so live Stop and Cancel stay reachable.
            guard current == version else { return }
            self.error = error.localizedDescription
        }
    }

    /// Reads once, then keeps reading while `pollInterval` asks for it. The caller restarts this
    /// when the scene returns to the foreground or the interval changes.
    func watch(_ thread: PathwayAgentThreadModel) async {
        await refresh(thread)
        while let interval = pollInterval {
            do { try await Task.sleep(for: interval) } catch { return }
            await refresh(thread)
        }
    }

    func perform(_ command: Command, thread: PathwayAgentThreadModel) async {
        version += 1
        reading = nil
        let current = version
        pending = command
        error = nil
        do {
            let value = try await thread.request("computer.recording.\(command.rawValue)", payload: Self.payload(thread), reportsErrors: false)
            guard current == version else { return }
            version += 1
            pending = nil
            status = PathwayWorkflowRecordingStatus(value)
        } catch {
            guard current == version else { return }
            version += 1
            pending = nil
            if !(error is CancellationError) { self.error = error.localizedDescription }
            await refresh(thread)
        }
    }

    private static func payload(_ thread: PathwayAgentThreadModel) -> JSONValue {
        .object(["threadId": .string(thread.threadID)])
    }
}

extension PathwayAgentThreadModel {
    /// Recording needs the environment's Mac, a thread the server knows, and Computer access.
    var offersWorkflowRecording: Bool {
        serverConfig["environment"]?.objectValue?["platform"]?.objectValue?["os"]?.stringValue == "darwin"
            && isSubscriptionReady && workflowRecording.status?.supported == true && !computerAccessDenied
    }

    /// Another recording on the Mac, or one already starting here.
    var workflowRecordingBlocked: Bool {
        let recording = workflowRecording
        return recording.pending != nil || recording.status?.isActive == true || recording.status?.phase == "busy"
    }

    var workflowRecordingTargetName: String { workflowRecording.status?.targetName ?? environmentLabel }

    var workflowSkillPromptAdded: Bool {
        workflowRecording.status?.skillPrompt.map(draft.contains) ?? false
    }

    /// The one start path for the Add menu and `/record-skill`. A new recording replaces this
    /// thread's saved one, so the exact prompt pointing at it leaves the draft first.
    func startWorkflowRecording() async {
        withdrawWorkflowSkillPrompt()
        await workflowRecording.perform(.start, thread: self)
    }

    /// Deletes a saved recording and takes its unedited prompt back out of the draft.
    func discardWorkflowRecording() async {
        withdrawWorkflowSkillPrompt()
        await workflowRecording.perform(.cancel, thread: self)
    }

    /// Adds the server-built prompt after the draft. Never sends.
    func appendWorkflowSkillPrompt() {
        guard let prompt = workflowRecording.status?.skillPrompt else { return }
        let next = PathwayWorkflowSkillPrompt.append(prompt, to: draft)
        if next != draft { draft = next }
    }

    /// Takes an unedited hand-off back out of the draft: before Discard or a new recording here,
    /// or after another device discarded or replaced the saved recording.
    func withdrawWorkflowSkillPrompt(_ prompt: String? = nil) {
        guard let prompt = prompt ?? workflowRecording.status?.skillPrompt else { return }
        let next = PathwayWorkflowSkillPrompt.remove(prompt, from: draft)
        if next != draft { draft = next }
    }
}
