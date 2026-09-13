import Foundation

enum PathwayThreadStatus: String, Sendable {
    case working = "Working", queued = "Queued", preparing = "Preparing", waiting = "Waiting"
    case question = "Question", approval = "Approval", plan = "Review plan", needsYou = "Needs you"
    case failed = "Failed", stopped = "Stopped", ready = "Ready"

    init(requestKind: String?, hasPlan: Bool, runStatus: String, hasActiveRun: Bool, hasError: Bool) {
        switch requestKind {
        case "user_input", "tool_user_input": self = .question; return
        case "command", "file-read", "file-change": self = .approval; return
        case nil, "auth_refresh", "auth_tokens_refresh": break
        default: self = .needsYou; return
        }
        if hasPlan { self = .plan; return }
        switch runStatus {
        case "queued": self = .queued
        case "preparing", "starting": self = .preparing
        case "running": self = .working
        case "waiting": self = .waiting
        case "failed", "error": self = .failed
        case "interrupted", "cancelled": self = .stopped
        default: self = hasActiveRun ? .working : hasError ? .failed : .ready
        }
    }
}
