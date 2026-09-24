import SwiftUI

/// What a Computer approval allows, under its title.
struct AgentComputerApprovalDetail: View {
    let prompt: PathwayComputerApprovalPrompt

    var body: some View {
        switch prompt {
        case .task:
            Text(PathwayComputerApprovalPrompt.taskAcceptDescription).font(.subheadline).foregroundStyle(.secondary)
        case .app:
            Text("The agent asks to control this app until the response ends.").font(.subheadline).foregroundStyle(.secondary)
        case let .call(toolName, args):
            VStack(alignment: .leading, spacing: 6) {
                Text(PathwayComputerTool.title(toolName)).font(.body.weight(.medium))
                ForEach((args ?? [:]).sorted { $0.key < $1.key }, id: \.key) { name, value in
                    LabeledContent(name) { Text(Self.display(value)).lineLimit(3).textSelection(.enabled) }
                        .font(.footnote)
                }
            }
        }
    }

    private static func display(_ value: JSONValue) -> String {
        switch value {
        case let .string(text): text
        case let .bool(flag): flag ? "true" : "false"
        case let .number(number): number.rounded() == number && abs(number) < 1e15 ? String(Int64(number)) : String(number)
        case .null: "null"
        default:
            (try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        }
    }
}

/// A Computer notice in place of its tool row: the host needs setup, or Computer control
/// was off (or out of reach for this device) when the agent reached for the desktop.
struct AgentTranscriptComputerNotice: View {
    let item: PathwayTimelineItem
    let notice: PathwayComputerNotice
    let model: PathwayAgentThreadModel
    @AppStorage(PathwayAgentThreadModel.computerControlDefaultsKey) private var controlSetting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch notice {
            case let .setupRequired(missing):
                Label("Computer needs setup", systemImage: "exclamationmark.triangle").font(.headline)
                let permissions = PathwayComputerNotice.permissionList(missing)
                Text(permissions.isEmpty
                     ? "Open Pathway on the host computer and grant the permissions Computer asks for, then try again."
                     : "Open Pathway on the host computer and grant \(permissions), then try again.")
                    .font(.subheadline).foregroundStyle(.secondary)
            case .controlDenied where model.computerAccessDenied:
                Label("This device can't use Computer", systemImage: "xmark.octagon").font(.headline)
                Text(PathwayComputerNotice.accessDeniedHint).font(.subheadline).foregroundStyle(.secondary)
            case .controlDenied:
                let enabled = model.computerControlApplies(setting: controlSetting)
                Label(enabled ? "Computer control is on for this chat" : "Computer control is off",
                      systemImage: enabled ? "checkmark.circle" : "desktopcomputer").font(.headline)
                Text(enabled ? "Queued desktop turns stay cancelled — send a fresh message to continue."
                             : "Turn it on in Settings to let the agent use the desktop.")
                    .font(.subheadline).foregroundStyle(.secondary)
                // Only this chat's own rows arm its composer; a child's notice would enable the wrong chat.
                if !enabled, item.fields["threadId"]?.stringValue.map({ $0 == model.threadID }) ?? true {
                    Button("Enable") { model.armComputerUse() }.buttonStyle(.bordered)
                        .accessibilityIdentifier("thread-computer-enable-\(item.id)")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 22))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-computer-notice-\(item.id)")
    }
}

/// Watches the thread's Computer state while its chat is on screen and in the foreground,
/// and opens an armed preview there. Leaving or backgrounding the chat closes its sockets.
struct AgentThreadComputerWatch: ViewModifier {
    let computer: PathwayThreadComputerModel?
    let model: PathwayAgentThreadModel
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task(id: computer != nil && model.supportsComputer && scenePhase == .active) {
                guard let computer, model.supportsComputer, scenePhase == .active else { return }
                await computer.watch()
            }
            .onChange(of: computer?.session.phase, initial: true) { _, phase in
                if phase == .armed { computer?.viewed() }
            }
            .onChange(of: computer?.session.state?.controlGeneration, initial: true) { _, generation in
                model.computerControlGeneration = generation
            }
    }
}

/// The live card above the composer while this thread's agent drives the desktop.
/// It appears with its first still, or with the reason there is none.
struct AgentThreadComputerPreview: View {
    let computer: PathwayThreadComputerModel

    var body: some View {
        let frames = computer.frames
        if computer.session.isOpen, frames.image != nil || frames.errorMessage != nil {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label(computer.session.statusLabel ?? "Computer", systemImage: "desktopcomputer")
                        .font(.caption).lineLimit(1)
                    Spacer()
                    Button("Hide", systemImage: "xmark") { computer.hide() }
                        .labelStyle(.iconOnly).font(.caption)
                        .accessibilityIdentifier("thread-computer-preview-hide")
                }
                if let image = frames.image {
                    Image(decorative: image, scale: 1).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 220)
                        .clipShape(.rect(cornerRadius: 12))
                        .accessibilityLabel("Live view of the computer")
                }
                if let error = frames.errorMessage {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            #if os(visionOS)
            .background(.regularMaterial, in: .rect(cornerRadius: 22))
            #else
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
            #endif
            .padding(.horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("thread-computer-preview")
        }
    }
}

/// The Medium-effort tip above the composer while a Claude chat is set to drive the desktop.
/// Using or dismissing it hides it for good on this device.
struct AgentThreadComputerEffortHint: View {
    let computer: PathwayThreadComputerModel
    let model: PathwayAgentThreadModel
    @AppStorage(PathwayAgentThreadModel.computerControlDefaultsKey) private var controlSetting = false
    @AppStorage(PathwayComputerEffortHint.dismissedDefaultsKey) private var dismissed = false

    var body: some View {
        if !dismissed, computer.session.state?.availability == "available",
           PathwayComputerInvocation(text: model.draft, controlEnabled: model.computerControlApplies(setting: controlSetting)) != .off,
           let medium = PathwayComputerEffortHint.mediumSelection(for: model.currentModelSelection, providers: model.providers) {
            HStack {
                Label(PathwayComputerEffortHint.message, systemImage: "gauge.with.dots.needle.33percent")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(PathwayComputerEffortHint.actionLabel) {
                    dismissed = true
                    Task {
                        do { try await model.changeModelSelection(medium) } catch { model.actionError = error.localizedDescription }
                    }
                }
                .font(.caption.bold())
                Button("Dismiss", systemImage: "xmark") { dismissed = true }
                    .labelStyle(.iconOnly).font(.caption)
            }
            .padding(.horizontal, 20)
            .accessibilityIdentifier("thread-computer-effort-hint")
        }
    }
}
