import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private func workflowEventCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if let userInfo {
        Unmanaged<WorkflowCapture>.fromOpaque(userInfo).takeUnretainedValue()
            .receive(type: type, event: event)
    }
    return Unmanaged.passUnretained(event)
}

/// Passive, bounded evidence for a user demonstration. Nothing is captured
/// until the recording controller calls begin after the user's confirmation.
final class WorkflowCapture {
    private let emit: ([String: Any]) -> Void
    private let onFailure: (String) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var snapshotTimer: Timer?
    private var workspaceObserver: NSObjectProtocol?
    private var running = false
    private var sequence = 0
    private var lastSnapshot: Data?
    private let blockedApps: Set<String> = [
        "com.apple.Passwords", "com.apple.keychainaccess", "com.agilebits.onepassword7",
        "com.1password.1password", "com.bitwarden.desktop", "com.lastpass.LastPass",
    ]

    init(emit: @escaping ([String: Any]) -> Void, onFailure: @escaping (String) -> Void) {
        self.emit = emit
        self.onFailure = onFailure
    }

    func begin() throws {
        guard !running else { return }
        guard AXIsProcessTrusted(), CGPreflightListenEventAccess() else {
            throw PathwayHelperFailure(
                code: "workflow_permissions_required",
                message: "Allow Accessibility and Input Monitoring for Pathway before recording a skill."
            )
        }
        let types: [CGEventType] = [
            .keyDown, .leftMouseDown, .leftMouseUp, .rightMouseDown,
            .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: workflowEventCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            throw PathwayHelperFailure(
                code: "workflow_event_tap_unavailable",
                message: "macOS could not start the workflow input listener."
            )
        }
        self.tap = tap
        self.source = source
        running = true
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.scheduleSnapshot() }
        snapshot()
    }

    func stop() {
        running = false
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
        }
        workspaceObserver = nil
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        source = nil
        tap = nil
    }

    fileprivate func receive(type: CGEventType, event: CGEvent) {
        guard running else { return }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            stop()
            onFailure("macOS disabled the workflow input listener. Start a new recording after checking permissions.")
            return
        }
        guard event.getIntegerValueField(.eventSourceUnixProcessID) == 0,
              let app = NSWorkspace.shared.frontmostApplication,
              !blockedApps.contains(app.bundleIdentifier ?? ""),
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.1)
        let focused = element(application, kAXFocusedUIElementAttribute)
        let secure = focused.map(isSecure) ?? true
        var payload: [String: Any] = [
            "kind": type == .keyDown ? "key" : type == .scrollWheel ? "scroll" : "pointer",
            "app": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
            "pid": app.processIdentifier, "modifiers": event.flags.rawValue,
        ]
        if type == .keyDown {
            if secure {
                payload["redacted"] = true
                payload.removeValue(forKey: "modifiers")
            } else {
                payload["keyCode"] = event.getIntegerValueField(.keyboardEventKeycode)
                var characters = [UniChar](repeating: 0, count: 64)
                var count = 0
                event.keyboardGetUnicodeString(maxStringLength: characters.count,
                                               actualStringLength: &count, unicodeString: &characters)
                if count > 0 { payload["text"] = String(utf16CodeUnits: characters, count: count) }
            }
        } else {
            payload["x"] = event.location.x
            payload["y"] = event.location.y
            payload["eventType"] = type.rawValue
            if type == .scrollWheel {
                payload["deltaX"] = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2)
                payload["deltaY"] = event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)
            }
            var target: AXUIElement?
            if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),
                Float(event.location.x), Float(event.location.y), &target) == .success,
               let target {
                var pid: pid_t = 0
                if AXUIElementGetPid(target, &pid) == .success {
                    if pid == ProcessInfo.processInfo.processIdentifier { return }
                    if let targetApp = NSRunningApplication(processIdentifier: pid),
                       blockedApps.contains(targetApp.bundleIdentifier ?? "") { return }
                }
                payload["target"] = describe(target)
            }
        }
        if let focused { payload["focused"] = describe(focused) }
        send(payload)
        scheduleSnapshot()
    }

    private func scheduleSnapshot() {
        guard running, snapshotTimer == nil else { return }
        snapshotTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { [weak self] _ in
            self?.snapshotTimer = nil
            self?.snapshot()
        }
    }

    private func snapshot() {
        guard running, let app = NSWorkspace.shared.frontmostApplication,
              !blockedApps.contains(app.bundleIdentifier ?? ""),
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.1)
        guard let window = element(application, kAXFocusedWindowAttribute) else { return }
        let deadline = Date().addingTimeInterval(0.15)
        var remaining = 160
        func walk(_ node: AXUIElement, depth: Int) -> [String: Any] {
            remaining -= 1
            var result = describe(node)
            guard depth < 6, remaining > 0, Date() < deadline, !isSecure(node) else { return result }
            if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                var captured: [[String: Any]] = []
                for child in children {
                    guard remaining > 0, Date() < deadline else { break }
                    captured.append(walk(child, depth: depth + 1))
                }
                if !captured.isEmpty { result["children"] = captured }
            }
            return result
        }
        let tree = walk(window, depth: 0)
        let payload: [String: Any] = [
            "kind": "window", "app": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier,
            "tree": tree, "truncated": remaining <= 0 || Date() >= deadline,
        ]
        if let encoded = try? JSONSerialization.data(withJSONObject: payload, options: .sortedKeys),
           encoded != lastSnapshot {
            lastSnapshot = encoded
            send(payload)
        }
    }

    private func send(_ payload: [String: Any]) {
        sequence += 1
        var event = payload
        event["sequence"] = sequence
        event["capturedAt"] = pathwayHelperTimestamp()
        emit(event)
    }

    private func describe(_ node: AXUIElement) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, ax) in [("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute),
                          ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
                          ("identifier", kAXIdentifierAttribute)] {
            if let value = attribute(node, ax) as? String { result[key] = String(value.prefix(500)) }
        }
        if isSecure(node) {
            result["redacted"] = true
            return result
        }
        for (key, ax) in [("value", kAXValueAttribute), ("selectedText", kAXSelectedTextAttribute)] {
            if let value = attribute(node, ax) as? String { result[key] = String(value.prefix(1000)) }
        }
        return result
    }

    private func isSecure(_ node: AXUIElement) -> Bool {
        (attribute(node, kAXSubroleAttribute) as? String) == kAXSecureTextFieldSubrole
    }

    private func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil
    }

    private func element(_ node: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(node, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
}
