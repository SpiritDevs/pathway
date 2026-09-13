import AVFoundation
import Foundation

/// Selects permission requests without invoking OS APIs. Omission preserves the original all-permissions flow.
struct PermissionRequestPlan {
    let microphone: Bool
    let accessibility: Bool
    let inputMonitoring: Bool

    init(_ command: [String: Any]) throws {
        let selected: String?
        if let raw = command["permission"] {
            guard let value = raw as? String, ["microphone", "accessibility"].contains(value) else {
                throw AudioRecordingError.processing("permission must be microphone or accessibility.")
            }
            selected = value
        } else { selected = nil }
        let requesting = command["request"] as? Bool == true
        microphone = requesting && (selected == nil || selected == "microphone")
        accessibility = requesting && (selected == nil || selected == "accessibility")
        inputMonitoring = requesting && selected == nil
    }

    var requestsAny: Bool { microphone || accessibility || inputMonitoring }
}

/// Tests inject recording closures so request routing never prompts or opens System Settings.
func performPermissionRequest(
    _ plan: PermissionRequestPlan,
    requestAccessibility: () -> Void,
    requestInputMonitoring: () -> Void,
    requestMicrophone: (@escaping () -> Void) -> Void,
    completion: @escaping () -> Void
) {
    if plan.accessibility { requestAccessibility() }
    if plan.inputMonitoring { requestInputMonitoring() }
    if plan.microphone { requestMicrophone(completion) }
    else { completion() }
}

/// Electron owns Settings navigation for denied access. The host only presents the first OS consent request.
func requestMicrophoneIfUndetermined(
    status: AVAuthorizationStatus,
    requestAccess: (@escaping (Bool) -> Void) -> Void,
    completion: @escaping () -> Void
) {
    if status == .notDetermined { requestAccess { _ in completion() } }
    else { completion() }
}
