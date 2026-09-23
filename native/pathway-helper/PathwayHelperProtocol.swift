import CoreGraphics
import Foundation

struct PathwayHelperFailure: Error {
    let code: String
    let message: String
}

enum PathwayHelperMode {
    case checkPermissions(Set<PathwayHelperPermission>)
    case requestPermissions(Set<PathwayHelperPermission>, appPath: String)
    case preparePermissionSetup(Set<PathwayHelperPermission>, appPath: String)
    case releaseHeldInput
    case permissionGuide(pane: String, appPath: String, appName: String)
    case computerFrames(
        windowID: CGWindowID,
        ownerPID: pid_t?,
        socketPath: String
    )
    /// Long-running listener that reports physical Escape keypresses while the
    /// parent marks computer control armed. Emits `escape`,
    /// `escape-monitor-state`, `error`, and `ready`.
    case escapeMonitor
    /// Masked-activation shield host: reads engage/release commands on stdin
    /// and owns the Pathway-side overlay panels for their lease's lifetime.
    case shield
}

struct PathwayHelperOptions {
    let mode: PathwayHelperMode

    static func parse(_ arguments: [String]) throws -> PathwayHelperOptions {
        var requestedMode: String?
        var permissions = Set<PathwayHelperPermission>()
        var guidePane: String?
        var guideAppPath: String?
        var guideAppName: String?
        var frameWindowID: String?
        var frameSocketPath: String?
        var frameOwnerPID: String?
        var index = 0

        // Consumes the value token after a flag, keeping the "--flag requires
        // …" usage errors identical across flags.
        func readValue(_ flag: String, _ what: String) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "\(flag) requires \(what)."
                )
            }
            return arguments[index]
        }

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--check-permissions", "--request-permissions", "--prepare-permission-setup", "--release-held-input", "--permission-guide", "--computer-frames", "--escape-monitor", "--shield":
                guard requestedMode == nil else {
                    throw PathwayHelperFailure(
                        code: "invalid_arguments",
                        message: "Choose exactly one helper mode."
                    )
                }
                requestedMode = argument
            case "--permission":
                let value = try readValue("--permission", "a value")
                guard let permission = PathwayHelperPermission(rawValue: value) else {
                    throw PathwayHelperFailure(
                        code: "invalid_arguments",
                        message: "--permission requires accessibility, inputMonitoring, or screenRecording."
                    )
                }
                permissions.insert(permission)
            case "--pane":
                guidePane = try readValue("--pane", "a value")
            case "--app-path":
                guideAppPath = try readValue("--app-path", "a path")
            case "--app-name":
                guideAppName = try readValue("--app-name", "a value")
            case "--window-id":
                frameWindowID = try readValue("--window-id", "a window number")
            case "--out":
                frameSocketPath = try readValue("--out", "a socket path")
            case "--pid":
                frameOwnerPID = try readValue("--pid", "a process identifier")
            default:
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "Unknown argument: \(argument)"
                )
            }
            index += 1
        }

        let usesSetupAppPath = requestedMode == "--request-permissions" || requestedMode == "--prepare-permission-setup"
        if requestedMode != "--permission-guide",
           guidePane != nil || guideAppName != nil || (guideAppPath != nil && !usesSetupAppPath) {
            throw PathwayHelperFailure(code: "invalid_arguments", message: "Guide metadata is only used by the permission guide.")
        }
        if requestedMode != "--computer-frames",
           frameWindowID != nil || frameSocketPath != nil || frameOwnerPID != nil {
            throw PathwayHelperFailure(code: "invalid_arguments", message: "Frame arguments are only used by the computer frames mode.")
        }
        switch requestedMode {
        case "--permission-guide":
            guard permissions.isEmpty, let guidePane,
                  guidePane == "accessibility" || guidePane == "input-monitoring" || guidePane == "screen-recording",
                  let appPath = guideAppPath, appPath.hasPrefix("/"),
                  appPath.hasSuffix(".app"), FileManager.default.fileExists(atPath: appPath),
                  let appName = guideAppName, !appName.isEmpty, appName.count <= 256 else {
                throw PathwayHelperFailure(code: "invalid_arguments", message: "The permission guide requires --pane accessibility, input-monitoring, or screen-recording, the running app bundle, and its name.")
            }
            return PathwayHelperOptions(
                mode: .permissionGuide(pane: guidePane, appPath: appPath, appName: appName)
            )
        case "--check-permissions":
            return PathwayHelperOptions(mode: .checkPermissions(
                permissions.isEmpty ? [.inputMonitoring, .screenRecording] : permissions
            ))
        case "--request-permissions":
            guard let appPath = guideAppPath, appPath.hasPrefix("/"), appPath.hasSuffix(".app") else {
                throw PathwayHelperFailure(code: "permission_setup_bundle_unavailable", message: "Move this app to Applications and reopen it before granting access.")
            }
            return PathwayHelperOptions(mode: .requestPermissions(
                permissions.isEmpty ? [.inputMonitoring, .screenRecording] : permissions,
                appPath: appPath
            ))
        case "--prepare-permission-setup":
            guard let appPath = guideAppPath, appPath.hasPrefix("/"), appPath.hasSuffix(".app") else {
                throw PathwayHelperFailure(code: "permission_setup_bundle_unavailable", message: "Move this app to Applications and reopen it before granting access.")
            }
            return PathwayHelperOptions(mode: .preparePermissionSetup(
                permissions.isEmpty ? [.inputMonitoring, .screenRecording] : permissions,
                appPath: appPath
            ))
        case "--release-held-input":
            guard permissions.isEmpty else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--release-held-input does not accept permission selectors."
                )
            }
            return PathwayHelperOptions(mode: .releaseHeldInput)
        case "--escape-monitor":
            guard permissions.isEmpty else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--escape-monitor does not accept permission selectors."
                )
            }
            return PathwayHelperOptions(mode: .escapeMonitor)
        case "--computer-frames":
            guard permissions.isEmpty else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--computer-frames does not accept permission selectors."
                )
            }
            guard let windowIDText = frameWindowID,
                  let windowID = CGWindowID(windowIDText), windowID > 0 else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--computer-frames requires --window-id with a window number."
                )
            }
            guard let socketPath = frameSocketPath,
                  socketPath.hasPrefix("/"),
                  socketPath.utf8.count < 104 else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--computer-frames requires --out with a unix socket path."
                )
            }
            var ownerPID: pid_t?
            if let pidText = frameOwnerPID {
                guard let pid = pid_t(pidText), pid > 0 else {
                    throw PathwayHelperFailure(
                        code: "invalid_arguments",
                        message: "--pid requires a process identifier."
                    )
                }
                ownerPID = pid
            }
            return PathwayHelperOptions(
                mode: .computerFrames(
                    windowID: windowID,
                    ownerPID: ownerPID,
                    socketPath: socketPath
                )
            )
        case "--shield":
            guard permissions.isEmpty else {
                throw PathwayHelperFailure(
                    code: "invalid_arguments",
                    message: "--shield does not accept permission selectors."
                )
            }
            return PathwayHelperOptions(mode: .shield)
        default:
            throw PathwayHelperFailure(
                code: "invalid_arguments",
                message: "Expected --check-permissions, --request-permissions, --prepare-permission-setup, --release-held-input, --permission-guide, --computer-frames, --escape-monitor, or --shield."
            )
        }
    }
}

func pathwayHelperTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

final class NDJSONEmitter {
    private let lock = NSLock()

    func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              var data = try? JSONSerialization.data(withJSONObject: payload)
        else {
            writeDiagnostic("Could not encode helper protocol event.")
            return
        }

        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }

    func emitReady() {
        emit(["type": "ready"])
    }

    func emitError(
        _ failure: PathwayHelperFailure,
        capturedAt: String,
        id: String? = nil,
        requestId: String? = nil
    ) {
        var payload: [String: Any] = [
            "type": "error",
            "code": failure.code,
            "message": failure.message,
            "capturedAt": capturedAt,
        ]
        if let id {
            payload["id"] = id
        }
        if let requestId {
            payload["requestId"] = requestId
        }
        emit(payload)
    }

    func emitEscape(capturedAt: String) {
        emit([
            "type": "escape",
            "capturedAt": capturedAt,
        ])
    }

    func emitPhysicalInput(kind: String, pid: pid_t?, windowID: CGWindowID?, capturedAt: String) {
        var payload: [String: Any] = [
            "type": "physical-input",
            "kind": kind,
            "capturedAt": capturedAt,
        ]
        if let pid { payload["pid"] = pid }
        if let windowID { payload["windowId"] = windowID }
        emit(payload)
    }

    func emitEscapeMonitorState(armed: Bool, capturedAt: String) {
        emit([
            "type": "escape-monitor-state",
            "armed": armed,
            "capturedAt": capturedAt,
        ])
    }

    func emitPermissionGuide(state: String) {
        emit([
            "type": "permission-guide",
            "state": state,
        ])
    }

    func emitPermissions(_ permissions: PathwayHelperPermissionState) {
        var payload: [String: Any] = ["type": "permissions"]
        if let accessibility = permissions.accessibility {
            payload["accessibility"] = accessibility ? "granted" : "denied"
        }
        if let inputMonitoring = permissions.inputMonitoring {
            payload["inputMonitoring"] = inputMonitoring ? "granted" : "denied"
        }
        if let screenRecording = permissions.screenRecording {
            payload["screenRecording"] = screenRecording ? "granted" : "denied"
        }
        emit(payload)
    }

    private func writeDiagnostic(_ message: String) {
        guard let data = "[pathway-helper] \(message)\n".data(using: .utf8) else {
            return
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(data)
    }
}
