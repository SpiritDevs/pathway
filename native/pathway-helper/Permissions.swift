import ApplicationServices
import CoreGraphics

enum PathwayHelperPermission: String {
    case accessibility
    case inputMonitoring
    case screenRecording
}

struct PathwayHelperPermissionState {
    let accessibility: Bool?
    let inputMonitoring: Bool?
    let screenRecording: Bool?
}

func preflightPathwayHelperPermissions(_ permissions: Set<PathwayHelperPermission>) -> PathwayHelperPermissionState {
    PathwayHelperPermissionState(
        accessibility: permissions.contains(.accessibility) ? AXIsProcessTrusted() : nil,
        inputMonitoring: permissions.contains(.inputMonitoring) ? CGPreflightListenEventAccess() : nil,
        screenRecording: permissions.contains(.screenRecording) ? CGPreflightScreenCaptureAccess() : nil
    )
}

func requestPathwayHelperPermissions(_ permissions: Set<PathwayHelperPermission>) -> PathwayHelperPermissionState {
    let preflight = preflightPathwayHelperPermissions(permissions)
    if preflight.accessibility == false {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }
    if preflight.screenRecording == false {
        _ = CGRequestScreenCaptureAccess()
    }
    if preflight.inputMonitoring == false {
        _ = CGRequestListenEventAccess()
    }
    return preflightPathwayHelperPermissions(permissions)
}
