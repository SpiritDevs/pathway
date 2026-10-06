import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

/// Hard cap on one demonstration. Mirrors WORKFLOW_RECORDING_MAX_DURATION_MS.
private let workflowRecordingLimit: TimeInterval = 30 * 60

/// Owns consent and the visible controls for `--record-workflow`.
///
/// Nothing is captured until the user presses Start in the native
/// confirmation on this Mac. While recording, a floating indicator shows the
/// elapsed time with Stop and Cancel. The host may send `stop` or `cancel` on
/// stdin at any point, including during confirmation; stdin EOF cancels.
/// Every path ends with exactly one `workflow-ended` line, then the helper exits.
@MainActor
final class WorkflowRecordingController: NSObject {
    private let emitter: NDJSONEmitter
    private let targetName: String
    private var capture: WorkflowCapture?
    private var confirmation: NSPanel?
    private var indicator: NSPanel?
    private var timeLabel: NSTextField?
    private var timer: Timer?
    /// Monotonic start (`systemUptime`), so clock changes cannot stretch or cut the cap.
    private var startedAt: TimeInterval?
    private var ended = false
    /// The app the user was in before the confirmation took focus.
    private var previousApp: NSRunningApplication?
    private var sessionObservers: [(NotificationCenter, NSObjectProtocol)] = []

    init(emitter: NDJSONEmitter, targetName: String?) {
        self.emitter = emitter
        let name = targetName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.targetName = name.isEmpty ? (Host.current().localizedName ?? "this Mac") : name
        super.init()
    }

    func present() {
        guard AXIsProcessTrusted(), CGPreflightListenEventAccess() else {
            fail(
                code: "workflow_permissions_required",
                message: "Allow Accessibility and Input Monitoring for Pathway before recording a skill."
            )
            return
        }
        observeSessionEnd()
        let panel = makePanel(width: 420, height: 228, style: [.titled, .closable])
        panel.title = "Record a skill"
        panel.delegate = self
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 228))

        let title = label(
            "Record a skill on \(targetName)?",
            size: 15, weight: .semibold, color: .labelColor
        )
        let body = label(
            "Pathway will record what you do on this Mac (\(targetName)) until you stop: the apps and "
                + "windows you use, what you click, and the text you type. Password fields and password "
                + "managers are skipped.\n\nDon't do anything sensitive while recording. Recording stops "
                + "on its own after 30 minutes.",
            size: 12, weight: .regular, color: .secondaryLabelColor
        )
        body.maximumNumberOfLines = 0
        body.preferredMaxLayoutWidth = 380
        let start = NSButton(title: "Start recording", target: self, action: #selector(confirmPressed))
        start.keyEquivalent = "\r"
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.keyEquivalent = "\u{1b}"

        let buttons = NSStackView(views: [cancel, start])
        buttons.spacing = 8
        let stack = NSStackView(views: [title, body, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 18, right: 20)
        stack.setCustomSpacing(18, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            buttons.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -20),
        ])
        panel.contentView = content
        panel.setContentSize(stack.fittingSize)
        panel.center()
        confirmation = panel
        previousApp = NSWorkspace.shared.frontmostApplication
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    /// Host command from stdin. Stop before consent is a cancel.
    func handle(command: String) {
        switch command {
        case "stop": finish(startedAt == nil ? "cancelled" : "stopped")
        case "cancel": finish("cancelled")
        default:
            emitter.emitError(
                PathwayHelperFailure(code: "invalid_command", message: "Expected stop or cancel."),
                capturedAt: pathwayHelperTimestamp()
            )
        }
    }

    /// The host is gone: stop capturing and report the end before exiting.
    func cancelForHostExit() {
        finish("cancelled")
    }

    @objc private func confirmPressed() {
        guard !ended, startedAt == nil else { return }
        confirmation?.orderOut(nil)
        confirmation = nil
        let emitter = emitter
        let capture = WorkflowCapture(
            emit: { event in emitter.emit(["type": "workflow-event", "event": event]) },
            onFailure: { [weak self] message in
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.fail(code: "workflow_capture_failed", message: message) }
                }
            }
        )
        // Started goes out before begin so the host accepts the first snapshot.
        startedAt = ProcessInfo.processInfo.systemUptime
        emitter.emit(["type": "workflow-started"])
        do {
            try capture.begin()
        } catch let failure as PathwayHelperFailure {
            fail(code: failure.code, message: failure.message)
            return
        } catch {
            fail(code: "workflow_capture_failed", message: error.localizedDescription)
            return
        }
        self.capture = capture
        showIndicator()
        // Hand focus back so recording starts in the user's app, not ours;
        // the activation also triggers the first window snapshot.
        if let previousApp, previousApp.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            previousApp.activate()
        }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // Common modes keep the cap and clock running while a panel is dragged or a button tracked.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    @objc private func cancelPressed() { finish("cancelled") }
    @objc private func stopPressed() { finish(startedAt == nil ? "cancelled" : "stopped") }

    private func tick() {
        guard let startedAt else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
        if elapsed >= workflowRecordingLimit {
            finish("time-limit")
            return
        }
        timeLabel?.stringValue = "\(clock(elapsed)) / \(clock(workflowRecordingLimit))"
    }

    private func showIndicator() {
        let panel = makePanel(width: 340, height: 44, style: [.nonactivatingPanel, .borderless])
        panel.level = .statusBar
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = true
        let background = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 340, height: 44))
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 12
        background.layer?.cornerCurve = .continuous

        let dot = NSView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemRed.cgColor
        dot.layer?.cornerRadius = 5
        dot.widthAnchor.constraint(equalToConstant: 10).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 10).isActive = true
        let title = label("Recording on \(targetName)", size: 12, weight: .semibold, color: .labelColor)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let time = label(
            "00:00 / \(clock(workflowRecordingLimit))",
            size: 11, weight: .regular, color: .secondaryLabelColor
        )
        time.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        timeLabel = time
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.controlSize = .small
        cancel.toolTip = "Discard this recording"
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopPressed))
        stop.controlSize = .small
        stop.toolTip = "Stop and keep this recording"

        let stack = NSStackView(views: [dot, title, time, cancel, stop])
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 10)
        stack.setCustomSpacing(12, after: time)
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
        ])
        panel.contentView = background
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - 340 - 16, y: screen.maxY - 44 - 12))
        }
        indicator = panel
        panel.orderFrontRegardless()
    }

    /// Locking the screen, sleeping, or switching users ends the demonstration:
    /// whatever happens next is not the user's recorded workflow.
    private func observeSessionEnd() {
        let workspace = NSWorkspace.shared.notificationCenter
        let distributed = DistributedNotificationCenter.default()
        let names: [(NotificationCenter, Notification.Name)] = [
            (workspace, NSWorkspace.sessionDidResignActiveNotification),
            (workspace, NSWorkspace.willSleepNotification),
            (workspace, NSWorkspace.screensDidSleepNotification),
            (distributed, Notification.Name("com.apple.screenIsLocked")),
        ]
        sessionObservers = names.map { center, name in
            (center, center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish("cancelled") }
            })
        }
    }

    private func fail(code: String, message: String) {
        guard !ended else { return }
        emitter.emitError(PathwayHelperFailure(code: code, message: message), capturedAt: pathwayHelperTimestamp())
        finish("cancelled")
    }

    private func finish(_ reason: String) {
        guard !ended else { return }
        ended = true
        capture?.stop()
        capture = nil
        timer?.invalidate()
        timer = nil
        confirmation?.orderOut(nil)
        indicator?.orderOut(nil)
        emitter.emit(["type": "workflow-ended", "reason": reason])
        exit(EXIT_SUCCESS)
    }

    private func makePanel(width: CGFloat, height: CGFloat, style: NSWindow.StyleMask) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: style, backing: .buffered, defer: false
        )
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        return panel
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.isSelectable = false
        return field
    }

    private func clock(_ interval: TimeInterval) -> String {
        let seconds = Int(interval)
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

extension WorkflowRecordingController: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        finish("cancelled")
        return true
    }
}

/// Line-oriented stdin for `--record-workflow`: `stop`, `cancel`; EOF cancels.
final class WorkflowRecordingCommandListener {
    private let onCommand: (String) -> Void
    private var buffer = Data()

    init(onCommand: @escaping (String) -> Void) {
        self.onCommand = onCommand
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                self.dispatch("cancel")
                return
            }
            self.buffer.append(data)
            while let newline = self.buffer.firstIndex(of: UInt8(ascii: "\n")) {
                let line = String(data: self.buffer[self.buffer.startIndex ..< newline], encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                self.buffer.removeSubrange(self.buffer.startIndex ... newline)
                if let line, !line.isEmpty { self.dispatch(line) }
            }
        }
    }

    private func dispatch(_ command: String) {
        DispatchQueue.main.async { [onCommand] in onCommand(command) }
    }
}
