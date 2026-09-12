/// The live conversation footer. Cached runs must not imply that an agent is still working.
enum PathwayThreadActivity: String, Equatable {
    case sending = "Sending…"
    case queued = "Queued…"
    case preparing = "Preparing workspace…"
    case starting = "Starting agent…"
    case working = "Working…"
    case waiting = "Waiting…"

    init?(isSynchronized: Bool, isSending: Bool, runStatus: String?) {
        guard isSynchronized else { return nil }
        if isSending {
            self = .sending
            return
        }
        switch runStatus {
        case "queued": self = .queued
        case "preparing": self = .preparing
        case "starting": self = .starting
        case "running": self = .working
        case "waiting": self = .waiting
        default: return nil
        }
    }
}
