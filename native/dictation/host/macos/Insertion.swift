// Current-field delivery adapts Sotto's focus/caret checks and clipboard revision lease.
// Copyright (c) 2026 Davis. MIT license; see ../LICENSE-Sotto.
import AppKit
import ApplicationServices

struct ClipboardSnapshot {
    let revision: Int
    let items: [NSPasteboardItem]
    static func capture(_ board: NSPasteboard) -> ClipboardSnapshot? {
        let revision = board.changeCount
        var items: [NSPasteboardItem] = []
        var bytes = 0
        for original in board.pasteboardItems ?? [] {
            let copy = NSPasteboardItem()
            for type in original.types {
                guard let data = original.data(forType: type) else { return nil }
                bytes += data.count
                guard bytes <= 32 * 1024 * 1024, copy.setData(data, forType: type) else { return nil }
            }
            items.append(copy)
        }
        guard board.changeCount == revision else { return nil }
        return ClipboardSnapshot(revision: revision, items: items)
    }
    func restore(_ board: NSPasteboard, owned: Int) {
        guard board.changeCount == owned else { return }
        let prepared = board.prepareForNewContents(with: .currentHostOnly)
        guard board.changeCount == prepared else { return }
        if !items.isEmpty { _ = board.writeObjects(items) }
    }
}

struct TextFieldAccess {
    let role: String
    var subrole: String? = nil
    var editable: Bool? = nil
    var protectedContent: Bool? = nil

    var permitsPaste: Bool {
        // Browser editors can accept paste without supporting AXSelectedText/AXValue writes.
        [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) &&
            subrole != kAXSecureTextFieldSubrole && editable != false && protectedContent != true
    }
}

private struct FocusedField {
    let application: AXUIElement
    let element: AXUIElement
    let pid: pid_t
    let selection: CFRange
}

final class TextInsertion {
    private let lock = NSLock()
    private var generation = 0
    func cancel() { lock.withLock { generation += 1 } }
    func ticket() -> Int { lock.withLock { generation } }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    func prepare() {
        guard AXIsProcessTrusted(), let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              pid > 0, pid != getpid() else { return }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.2)
        // Chromium enables native accessibility when assistive clients read the app role.
        _ = attribute(application, kAXRoleAttribute)
        if let raw = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let element = unsafeBitCast(raw, to: AXUIElement.self)
            AXUIElementSetMessagingTimeout(element, 0.2)
            if let role = attribute(element, kAXRoleAttribute) as? String,
               TextFieldAccess(role: role).permitsPaste, selection(element) != nil { return }
        }
        // Electron can need its full DOM tree. Its manual activation is asynchronous, so
        // request it during recording, without putting AX work on the capture queue.
        if (attribute(application, "AXManualAccessibility") as? Bool) != true {
            _ = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
    }
    private func selection(_ element: AXUIElement) -> CFRange? {
        guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = unsafeBitCast(raw, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range),
              range.location >= 0, range.length >= 0, range.location < Int.max - range.length else { return nil }
        return range
    }
    private func focus() -> FocusedField? {
        guard AXIsProcessTrusted(),
              let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              frontmostPID > 0, frontmostPID != getpid() else { return nil }
        let application = AXUIElementCreateApplication(frontmostPID)
        AXUIElementSetMessagingTimeout(application, 0.2)
        guard let raw = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let element = unsafeBitCast(raw, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(element, 0.2)
        var pid: pid_t = 0
        var enabled: CFTypeRef?
        let enabledStatus = AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled)
        guard AXUIElementGetPid(element, &pid) == .success, pid == frontmostPID,
              let role = attribute(element, kAXRoleAttribute) as? String,
              enabledStatus == .attributeUnsupported || enabledStatus == .notImplemented ||
                  (enabledStatus == .success && (enabled as? Bool) == true),
              TextFieldAccess(role: role,
                  subrole: attribute(element, kAXSubroleAttribute) as? String,
                  editable: attribute(element, "AXEditable") as? Bool,
                  protectedContent: attribute(element, "AXProtectedContent") as? Bool).permitsPaste,
              let selection = selection(element) else { return nil }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmostPID else { return nil }
        return FocusedField(application: application, element: element, pid: pid, selection: selection)
    }
    private func matches(_ target: FocusedField, caret: Bool = true) -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
              let raw = attribute(target.application, kAXFocusedUIElementAttribute),
              CFGetTypeID(raw) == AXUIElementGetTypeID(), CFEqual(raw, target.element) else { return false }
        if caret {
            guard let current = selection(target.element), current.location == target.selection.location,
                  current.length == target.selection.length else { return false }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
    }
    private var modifiersHeld: Bool {
        !CGEventSource.flagsState(.hidSystemState).intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]).isEmpty
    }
    func insert(_ text: String, token: Int) -> [String: Any] {
        func result(_ status: String, _ reason: String? = nil) -> [String: Any] {
            var value: [String: Any] = ["status": status]
            if let reason { value["reason"] = reason }
            return value
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 4
        func allowed() -> Bool { lock.withLock { generation == token } && ProcessInfo.processInfo.systemUptime < deadline }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 1_048_576 else {
            return result("manual", "No usable text to insert.")
        }
        guard allowed(), let target = focus(), allowed() else { return result("manual", "No verified editable field is focused.") }
        guard !modifiersHeld else { return result("manual", "Release keyboard modifiers before inserting.") }
        var settable = DarwinBoolean(false)
        let access = AXUIElementIsAttributeSettable(target.element, kAXSelectedTextAttribute as CFString, &settable)
        if access == .success, settable.boolValue {
            guard matches(target), !modifiersHeld, allowed() else { return result("manual", "The focused field changed.") }
            // Dispatch at most once, even if AX reports an error after the target consumed the write.
            _ = AXUIElementSetAttributeValue(target.element, kAXSelectedTextAttribute as CFString, text as CFString)
            return confirm(target, text: text, allowed: allowed) ? result("inserted") : result("unconfirmed", "The application did not confirm insertion.")
        }
        guard access == .success || access == .attributeUnsupported || access == .notImplemented else {
            return result("manual", "Could not verify insertion access.")
        }
        let board = NSPasteboard.general
        guard let backup = ClipboardSnapshot.capture(board), allowed(), matches(target), !modifiersHeld,
              board.changeCount == backup.revision else { return result("manual", "Focus or clipboard could not be preserved.") }
        let item = NSPasteboardItem()
        guard item.setString(text, forType: .string), item.setData(Data(), forType: .init("org.nspasteboard.TransientType")) else {
            return result("manual", "Could not prepare insertion.")
        }
        let owned = board.prepareForNewContents(with: .currentHostOnly)
        defer { backup.restore(board, owned: owned) }
        guard board.changeCount == owned, board.writeObjects([item]), board.changeCount == owned,
              matches(target), !modifiersHeld, allowed(), CGPreflightPostEventAccess(),
              let source = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false),
              board.changeCount == owned else { return result("manual", "Insertion conditions changed before paste.") }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.postToPid(target.pid)
        up.postToPid(target.pid)
        let confirmed = confirm(target, text: text, allowed: allowed)
        return confirmed ? result("inserted") : result("unconfirmed", "Paste was sent once; the application did not confirm it.")
    }
    private func confirm(_ target: FocusedField, text: String, allowed: () -> Bool) -> Bool {
        // Async application paste handlers need time to consume the clipboard lease. Only this worker waits.
        for attempt in 0..<8 {
            guard allowed() else { return false }
            if attempt > 0 { Thread.sleep(forTimeInterval: 0.1) }
            guard allowed() else { return false }
            guard matches(target, caret: false), let current = selection(target.element) else { continue }
            if current.length == 0, current.location == target.selection.location + text.utf16.count { return true }
        }
        return false
    }
}
