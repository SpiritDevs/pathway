import AppKit
import AVFoundation
import ApplicationServices
import Foundation

let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    outputLock.withLock {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func respond(_ command: [String: Any], operation: () throws -> Any) {
    let requestId = command["requestId"] ?? NSNull()
    do { emit(["requestId": requestId, "ok": true, "result": try operation()]) }
    catch { emit(["requestId": requestId, "ok": false, "error": error.localizedDescription]) }
}
func permissions() -> [String: String] {
    let microphone: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: microphone = "granted"
    case .notDetermined: microphone = "unknown"
    default: microphone = "denied"
    }
    return ["microphone": microphone, "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "inputMonitoring": AXIsProcessTrusted() || CGPreflightListenEventAccess() ? "granted" : "denied"]
}
func required(_ command: [String: Any], _ key: String) throws -> String {
    guard let value = command[key] as? String else { throw AudioRecordingError.processing("Missing string: \(key).") }
    return value
}

if CommandLine.arguments.contains("--self-test") {
    runSelfTests()
    exit(0)
}
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let capture = CaptureController(emit: emit)
let shortcut = ShortcutMonitor(emit: emit)
let insertion = TextInsertion()
let insertionQueue = DispatchQueue(label: "pathway.dictation.insertion", qos: .userInitiated)
var shuttingDown = false // stdin thread owns this gate

func shutdown(_ command: [String: Any]? = nil) {
    insertion.cancel()
    capture.closeAdmission(id: nil, cancel: true)
    DispatchQueue.main.async { shortcut.stop() }
    capture.queue.async {
        _ = try? capture.finish(id: nil, cancel: true)
        insertionQueue.async {
            if let command { respond(command) { ["shutdown": true] } }
            exit(0)
        }
    }
}

let sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in
    insertion.cancel()
    capture.closeAdmission(id: nil, cancel: true)
    emit(["type": "cancel", "reason": "sleep"])
    capture.queue.async { _ = try? capture.finish(id: nil, cancel: true) }
}
let lockObserver = DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
    insertion.cancel()
    capture.closeAdmission(id: nil, cancel: true)
    emit(["type": "cancel", "reason": "screen-lock"])
    capture.queue.async { _ = try? capture.finish(id: nil, cancel: true) }
}

DispatchQueue(label: "pathway.dictation.stdin").async {
    while let line = readLine() {
        autoreleasepool {
            guard !shuttingDown else { return }
            guard line.utf8.count <= 2_097_152, let data = line.data(using: .utf8),
                  let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  command["requestId"] is NSNumber, let type = command["type"] as? String else {
                emit(["type": "error", "message": "Invalid JSON-lines command."])
                return
            }
            switch type {
            case "shutdown": shuttingDown = true; shutdown(command)
            case "enumerate":
                capture.queue.async { respond(command) {
                    let snapshot = AudioInputHardware.snapshot()
                    return snapshot.inputs.map { ["id": $0.device.uid, "name": $0.device.name, "isDefault": $0.deviceID == snapshot.systemDefaultID] as [String: Any] }
                } }
            case "permissions":
                do {
                    let plan = try PermissionRequestPlan(command)
                    if !plan.requestsAny { respond(command) { permissions() }; return }
                    DispatchQueue.main.async {
                        performPermissionRequest(plan, requestAccessibility: {
                            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
                            _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
                        }, requestInputMonitoring: {
                            if !AXIsProcessTrusted(), !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
                        }, requestMicrophone: { completion in
                            requestMicrophoneIfUndetermined(status: AVCaptureDevice.authorizationStatus(for: .audio),
                                requestAccess: { AVCaptureDevice.requestAccess(for: .audio, completionHandler: $0) },
                                completion: completion)
                        }, completion: { respond(command) { permissions() } })
                    }
                } catch { respond(command) { throw error } }
            case "configureShortcut":
                DispatchQueue.main.async { respond(command) {
                    guard let enabled = command["enabled"] as? Bool else { throw AudioRecordingError.processing("Missing enabled flag.") }
                    return try shortcut.configure(shortcut: required(command, "shortcut"), enabled: enabled)
                } }
            case "startCapture":
                do {
                    let id = try required(command, "id")
                    let path = try required(command, "path")
                    let gate = try capture.reserveStart(id: id)
                    capture.queue.async { respond(command) {
                        let result = try capture.start(id: id, path: path, deviceID: command["deviceId"] as? String ?? "default", request: gate)
                        insertionQueue.async { if gate.acceptsAudio { insertion.prepare() } }
                        return result
                    } }
                } catch { respond(command) { throw error } }
            case "stopCapture", "cancelCapture":
                let cancel = type == "cancelCapture"
                if cancel { insertion.cancel() }
                capture.closeAdmission(id: command["id"] as? String, cancel: cancel)
                capture.queue.async { respond(command) { try capture.finish(id: command["id"] as? String, cancel: cancel) } }
            case "insert":
                let ticket = insertion.ticket()
                insertionQueue.async { respond(command) { insertion.insert(try required(command, "text"), token: ticket) } }
            default: respond(command) { throw AudioRecordingError.processing("Unknown command: \(type).") }
            }
        }
    }
    if !shuttingDown { shuttingDown = true; shutdown() }
}
emit(["type": "ready", "protocolVersion": 1, "platform": "darwin", "shortcuts": ["fn", "right-control", "right-option", "F8"]])
app.run()
