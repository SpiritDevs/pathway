// Key masks, listen-only event tap and recovery adapted from Sotto.
// Copyright (c) 2026 Davis. MIT license; see ../LICENSE-Sotto.
import AppKit
import CoreGraphics

final class ShortcutMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var watchdog: Timer?
    private var down = false
    private var blocked = false
    private(set) var shortcut = "fn"
    private let emit: ([String: Any]) -> Void
    init(emit: @escaping ([String: Any]) -> Void) { self.emit = emit }
    private var code: CGKeyCode { ["fn": 63, "right-control": 62, "right-option": 61, "F8": 100][shortcut]! }
    private func held(_ flags: CGEventFlags) -> Bool {
        switch shortcut {
        case "fn": flags.contains(.maskSecondaryFn)
        case "right-control": flags.rawValue & 0x2000 != 0
        case "right-option": flags.rawValue & 0x40 != 0
        default: false
        }
    }
    private func otherModifiers(_ flags: CGEventFlags) -> Bool {
        var disallowed: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
        switch shortcut {
        case "fn", "F8": disallowed.remove(.maskSecondaryFn)
        case "right-control":
            disallowed.remove(.maskControl)
            if flags.rawValue & 1 != 0 { return true }
        case "right-option":
            disallowed.remove(.maskAlternate)
            if flags.rawValue & 0x20 != 0 { return true }
        default: break
        }
        return !flags.intersection(disallowed).isEmpty
    }
    func configure(shortcut: String, enabled: Bool) throws -> [String: Any] {
        guard ["fn", "right-control", "right-option", "F8"].contains(shortcut) else {
            throw AudioRecordingError.processing("Unsupported shortcut.")
        }
        stop()
        self.shortcut = shortcut
        if enabled {
            guard AXIsProcessTrusted() || CGPreflightListenEventAccess() else {
                throw AudioRecordingError.processing("Allow Accessibility or Input Monitoring before enabling the shortcut.")
            }
            let mask = [CGEventType.flagsChanged, .keyDown, .keyUp, .leftMouseDown, .rightMouseDown]
                .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
            guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, context in
                    if let context { Unmanaged<ShortcutMonitor>.fromOpaque(context).takeUnretainedValue().receive(type, event) }
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
                throw AudioRecordingError.processing("Could not install the global shortcut listener.")
            }
            self.tap = tap
            self.source = source
            blocked = physicalDown
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return ["enabled": enabled, "shortcut": shortcut]
    }
    private var physicalDown: Bool {
        shortcut == "fn" ? CGEventSource.flagsState(.hidSystemState).contains(.maskSecondaryFn) : CGEventSource.keyState(.hidSystemState, key: code)
    }
    private func edge(_ pressed: Bool) {
        guard down != pressed else { return }
        down = pressed
        emit(["type": pressed ? "shortcut-down" : "shortcut-up", "shortcut": shortcut,
              "timestampMs": ProcessInfo.processInfo.systemUptime * 1000])
        watchdog?.invalidate()
        watchdog = nil
        if pressed {
            let timer = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in
                guard let self else { return }
                if !self.physicalDown { self.edge(false); self.blocked = false }
            }
            watchdog = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }
    func receive(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if down { emit(["type": "cancel", "reason": "shortcut-interrupted"]) }
            down = false
            watchdog?.invalidate()
            watchdog = nil
            blocked = physicalDown
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let key = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        if type == .keyDown, key == 53, event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            emit(["type": "cancel", "reason": "escape"])
            blocked = down
            return
        }
        if key == code, type == .flagsChanged || type == .keyDown || type == .keyUp {
            let pressed = type == .flagsChanged ? held(event.flags) : type == .keyDown
            if !pressed { edge(false); blocked = false; return }
            guard !blocked, !down, event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return }
            if otherModifiers(event.flags) { blocked = true; return }
            edge(true)
        } else if down, shortcut != "fn",
                  type == .keyDown || type == .leftMouseDown || type == .rightMouseDown ||
                  (type == .flagsChanged && otherModifiers(event.flags)) {
            // Preserve ordinary modifier chords. Parent cancels any pending hold/double-tap.
            emit(["type": "cancel", "reason": "shortcut-interrupted"])
            blocked = true
        }
    }
    func stop() {
        if down { emit(["type": "cancel", "reason": "shortcut-interrupted"]) }
        down = false
        blocked = false
        watchdog?.invalidate()
        watchdog = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        source = nil
        tap = nil
    }
}
