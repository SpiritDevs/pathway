import Foundation

enum PathwayThreadStatus: String, Sendable {
    case working = "Working", queued = "Queued", preparing = "Preparing"
    case question = "Question", approval = "Approval", plan = "Review plan", needsYou = "Needs you"
    case failed = "Failed", stopped = "Stopped", ready = "Ready"
    case waitingForAllowance = "Waiting for allowance"

    init(requestKind: String?, hasPlan: Bool, runStatus: String, hasActiveRun: Bool, hasError: Bool, hasAllowanceHold: Bool = false,
         subagentRequest: String? = nil, hasBackgroundWork: Bool = false) {
        // A hidden subagent's approval outranks the thread's own question.
        if subagentRequest == "approval" { self = .approval; return }
        switch requestKind {
        case "user_input", "tool_user_input": self = .question; return
        case "command", "file-read", "file-change": self = .approval; return
        case nil, "auth_refresh", "auth_tokens_refresh": break
        default: self = .needsYou; return
        }
        if subagentRequest == "user_input" { self = .question; return }
        if hasPlan { self = .plan; return }
        if hasAllowanceHold { self = .waitingForAllowance; return }
        // A turn that ended with background tasks still open is still working.
        if hasBackgroundWork { self = .working; return }
        switch runStatus {
        case "queued": self = .queued
        case "preparing", "starting": self = .preparing
        case "running", "waiting": self = .working
        case "failed", "error": self = .failed
        case "interrupted", "cancelled": self = .stopped
        default: self = hasActiveRun ? .working : hasError ? .failed : .ready
        }
    }
}
