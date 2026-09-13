import AppKit
import AVFoundation
import Foundation

func runSelfTests() {
    func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
    }
    func requestedPermissions(_ command: [String: Any]) -> [String] {
        var calls: [String] = []
        performPermissionRequest(try! PermissionRequestPlan(command), requestAccessibility: {
            calls.append("accessibility")
        }, requestInputMonitoring: {
            calls.append("inputMonitoring")
        }, requestMicrophone: { completion in
            calls.append("microphone")
            completion()
        }, completion: { calls.append("complete") })
        return calls
    }
    check(requestedPermissions(["request": true, "permission": "microphone"]) == ["microphone", "complete"], "microphone-only request never invokes AX or Input Monitoring")
    check(requestedPermissions(["request": true, "permission": "accessibility"]) == ["accessibility", "complete"], "accessibility-only request never invokes microphone or Input Monitoring")
    check(requestedPermissions(["request": true]) == ["accessibility", "inputMonitoring", "microphone", "complete"], "legacy request retains all-permissions routing")
    check(requestedPermissions(["request": false, "permission": "accessibility"]) == ["complete"], "drag wizard permission check never prompts")
    check(requestedPermissions(["permission": "microphone"]) == ["complete"], "permission selector without request does not prompt")
    do {
        _ = try PermissionRequestPlan(["request": true, "permission": "invalid"])
        check(false, "unknown permission must not fall back to requesting everything")
    } catch { }
    for status: AVAuthorizationStatus in [.authorized, .denied, .restricted, .notDetermined] {
        var calls: [String] = []
        requestMicrophoneIfUndetermined(status: status, requestAccess: { callback in
            calls.append("request")
            callback(false)
        }, completion: { calls.append("complete") })
        check(calls == (status == .notDetermined ? ["request", "complete"] : ["complete"]), "only undetermined microphone permission invokes an OS request; Electron owns denied Settings UI")
    }
    let gate = AudioCaptureRequest()
    check(gate.acceptsAudio, "new gate accepts audio")
    gate.release()
    check(!gate.acceptsAudio && gate.isReleased, "release immediately closes audio admission")
    gate.cancel()
    check(gate.isCancelled, "cancel overrides release")
    let controller = CaptureController { _ in }
    let pending = try! controller.reserveStart(id: "pending")
    controller.closeAdmission(id: "old-take", cancel: true)
    check(pending.acceptsAudio, "stale capture cancellation cannot stop a newer take")
    controller.closeAdmission(id: "pending", cancel: true)
    check(pending.isCancelled, "cancel closes a start still queued behind other work")
    let insertion = TextInsertion()
    let queued = insertion.ticket()
    insertion.cancel()
    check(insertion.insert("must not write", token: queued)["status"] as? String == "manual", "queued insertion cannot outlive cancellation")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pathway-host-test-\(UUID())")
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("capture.wav").path
    let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
    var levels = 0
    let writer = try! CaptureWriter(path: path, input: input, onLevel: { _, level in
        check(level.isFinite && level >= 0 && level <= 1, "bounded audio level")
        levels += 1
    }, onError: { message in fputs("FAIL: \(message)\n", stderr); exit(1) })
    let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 4_800)!
    buffer.frameLength = 4_800
    for index in 0..<4_800 {
        let value = Float(sin(Double(index) * 2 * Double.pi * 440 / 48_000)) * 0.3
        buffer.floatChannelData![0][index] = value
        buffer.floatChannelData![1][index] = value
    }
    for _ in 0..<10 { writer.append(buffer) }
    let duration = try! writer.finish(cancel: false)
    let wav = try! AVAudioFile(forReading: URL(fileURLWithPath: path))
    check(wav.fileFormat.sampleRate == 16_000 && wav.fileFormat.channelCount == 1, "16 kHz mono WAV")
    check(wav.fileFormat.streamDescription.pointee.mBitsPerChannel == 16, "16 bit PCM")
    check(abs(duration - 1_000) < 2 && levels > 0, "capture duration follows converted samples")
    do {
        _ = try CaptureWriter(path: path, input: input, onLevel: { _, _ in }, onError: { _ in })
        check(false, "existing paths must not be overwritten")
    } catch { }
    let cancelled = directory.appendingPathComponent("cancelled.wav").path
    let discard = try! CaptureWriter(path: cancelled, input: input, onLevel: { _, _ in }, onError: { _ in })
    discard.append(buffer)
    _ = try! discard.finish(cancel: true)
    check(!FileManager.default.fileExists(atPath: cancelled), "cancel removes WAV")

    // Named pasteboard only. This test never reads or modifies the user's clipboard.
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let item = NSPasteboardItem()
    item.setString("original", forType: .string)
    item.setData(Data([1, 2, 3]), forType: .init("test.pathway.binary"))
    board.writeObjects([item])
    let backup = ClipboardSnapshot.capture(board)!
    let owned = board.prepareForNewContents(with: .currentHostOnly)
    board.setString("transcript", forType: .string)
    backup.restore(board, owned: owned)
    check(board.string(forType: .string) == "original", "clipboard restoration")
    check(board.data(forType: .init("test.pathway.binary")) == Data([1, 2, 3]), "all clipboard formats restored")
    let second = ClipboardSnapshot.capture(board)!
    let oldOwned = board.prepareForNewContents(with: .currentHostOnly)
    board.setString("transcript", forType: .string)
    board.clearContents()
    board.setString("new user copy", forType: .string)
    second.restore(board, owned: oldOwned)
    check(board.string(forType: .string) == "new user copy", "intervening copy is preserved")

    var events: [[String: Any]] = []
    let monitor = ShortcutMonitor { events.append($0) }
    _ = try! monitor.configure(shortcut: "right-control", enabled: false)
    let event = CGEvent(keyboardEventSource: nil, virtualKey: 62, keyDown: true)!
    event.flags = CGEventFlags(rawValue: 0x2000 | CGEventFlags.maskControl.rawValue)
    monitor.receive(.flagsChanged, event)
    monitor.receive(.flagsChanged, event)
    event.flags = []
    monitor.receive(.flagsChanged, event)
    check(events.map { $0["type"] as? String } == ["shortcut-down", "shortcut-up"], "one down and up without duplicate companion events")
    events.removeAll()
    event.flags = CGEventFlags(rawValue: 0x2000 | CGEventFlags.maskControl.rawValue | CGEventFlags.maskShift.rawValue)
    monitor.receive(.flagsChanged, event)
    event.flags = []
    monitor.receive(.flagsChanged, event)
    check(events.isEmpty, "modifier chord does not activate shortcut")
    monitor.stop()
    print("PASS: permission routing, audio conversion, duration, levels, exclusive paths, cancellation, clipboard leases, shortcut edges")
}
