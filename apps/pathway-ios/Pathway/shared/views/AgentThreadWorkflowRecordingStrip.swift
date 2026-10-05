import SwiftUI

/// Record a skill above the composer: confirmation pending on the Mac, live recording with
/// Stop and Cancel, then the hand-off into an editable prompt. It controls the environment's
/// Mac, never this device.
struct AgentThreadWorkflowRecordingStrip: View {
    let model: PathwayAgentThreadModel
    @State private var dismissedFailure: String?

    private var recording: PathwayWorkflowRecordingModel { model.workflowRecording }
    private var target: String { model.workflowRecordingTargetName }
    private var busy: Bool { recording.pending != nil }

    var body: some View {
        if let status = recording.status, isVisible(status) {
            HStack(spacing: 8) {
                content(status)
            }
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("agent-thread-workflow-recording")
        } else if let error = recording.error {
            HStack(spacing: 8) { errorRow(error) }
                .font(.caption)
                .padding(.horizontal, 20)
        }
    }

    private func isVisible(_ status: PathwayWorkflowRecordingStatus) -> Bool {
        switch status.phase {
        case "awaiting-confirmation", "recording", "stopping", "busy", "completed": true
        case "failed": dismissedFailure != (status.recordingID ?? status.phase)
        default: recording.error != nil
        }
    }

    @ViewBuilder
    private func content(_ status: PathwayWorkflowRecordingStatus) -> some View {
        switch status.phase {
        case "awaiting-confirmation":
            live { Text("Confirm on \(target) to start recording. Nothing is recorded until you do.") }
            controls(stop: false)
        case "recording":
            live {
                if let startedAt = status.startedAt {
                    Text("Recording on \(target) · \(startedAt, style: .timer) · \(steps(status.eventCount))")
                } else {
                    Text("Recording on \(target) · \(steps(status.eventCount))")
                }
            }
            controls(stop: true)
        case "stopping":
            live { Text("Saving the recording on \(target)…") }
        case "busy":
            message("Another thread is recording on \(target). You can record here once it ends.", symbol: "record.circle")
        case "completed":
            if model.workflowSkillPromptAdded {
                message("Prompt added. Send it to create the skill.", symbol: "checkmark")
            } else {
                message(status.endReason == "time-limit"
                        ? "Recording reached 30 minutes and was saved. Turn it into a skill?"
                        : status.endReason == "size-limit"
                            ? "Recording reached its size limit and was saved. Turn it into a skill?"
                            : "Recording saved. Turn it into a skill?", symbol: "sparkles")
            }
            Button("Discard") { Task { await model.discardWorkflowRecording() } }
                .buttonStyle(.borderless).disabled(busy)
                .accessibilityHint(model.workflowSkillPromptAdded
                                   ? "Deletes the recording and removes its prompt from your draft"
                                   : "Deletes the recording")
            if !model.workflowSkillPromptAdded {
                Button("Create skill", systemImage: "sparkles") { model.appendWorkflowSkillPrompt() }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(busy || status.skillPrompt == nil)
            }
        case "failed":
            Text(status.message ?? "Recording stopped unexpectedly. Nothing was saved.")
                .foregroundStyle(.red).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark") { dismissedFailure = status.recordingID ?? status.phase }
                .labelStyle(.iconOnly).buttonStyle(.borderless)
        default:
            EmptyView()
        }
        if let error = recording.error { errorRow(error) }
    }

    @ViewBuilder
    private func controls(stop: Bool) -> some View {
        Button("Cancel") { Task { await recording.perform(.cancel, thread: model) } }
            .buttonStyle(.borderless).disabled(busy)
        if stop {
            Button("Stop") { Task { await recording.perform(.stop, thread: model) } }
                .buttonStyle(.bordered).controlSize(.small).disabled(busy)
        }
    }

    private func live(@ViewBuilder _ label: () -> some View) -> some View {
        HStack(spacing: 8) {
            Circle().fill(.red).frame(width: 8, height: 8).accessibilityHidden(true)
            label()
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary).lineLimit(2)
    }

    private func message(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol).foregroundStyle(.secondary).lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func errorRow(_ error: String) -> some View {
        HStack(spacing: 6) {
            Text(error).foregroundStyle(.red).lineLimit(2)
            Button("Dismiss error", systemImage: "xmark") { recording.clearError() }
                .labelStyle(.iconOnly).buttonStyle(.borderless)
        }
    }

    private func steps(_ count: Int) -> String { count == 1 ? "1 step" : "\(count) steps" }
}
