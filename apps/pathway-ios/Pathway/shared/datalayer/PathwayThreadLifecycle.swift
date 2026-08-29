import Foundation

enum PathwayThreadLifecycleSection: Equatable, Sendable {
    case active
    case snoozed
    case settled
    case hidden
}

enum PathwayChangeRequestState: String, Equatable, Sendable {
    case open
    case closed
    case merged
}

struct PathwayThreadLifecyclePartition {
    let all: [PathwayAgentThread]
    let active: [PathwayAgentThread]
    let snoozed: [PathwayAgentThread]
    let settled: [PathwayAgentThread]

    init(
        threads: [PathwayAgentThread],
        now: Date,
        changeRequestStates: [String: PathwayChangeRequestState] = [:]
    ) {
        all = threads
            .filter { $0.shell.deletedAt == nil }
            .sorted(by: PathwayAgentThread.isOrderedBefore)

        var active: [PathwayAgentThread] = []
        var snoozed: [PathwayAgentThread] = []
        var settled: [PathwayAgentThread] = []
        for thread in all {
            switch thread.lifecycleSection(
                at: now,
                changeRequestState: changeRequestStates[thread.id]
            ) {
            case .active:
                active.append(thread)
            case .snoozed:
                snoozed.append(thread)
            case .settled:
                settled.append(thread)
            case .hidden:
                continue
            }
        }

        self.active = active.sorted(by: PathwayAgentThread.isOrderedBefore)
        self.snoozed = snoozed.sorted(by: PathwayAgentThread.isSnoozedBefore)
        self.settled = settled.sorted(by: PathwayAgentThread.isSettledBefore)
    }
}

extension PathwayAgentThread {
    func lifecycleSection(
        at now: Date,
        autoSettleAfterDays: Int? = 3,
        changeRequestState: PathwayChangeRequestState? = nil
    ) -> PathwayThreadLifecycleSection {
        guard shell.archivedAt == nil, shell.deletedAt == nil else { return .hidden }
        guard shell.lineage?.relationshipToParent == nil else { return .hidden }
        guard shell.locations?.contains("agents") ?? true else { return .hidden }
        guard !shell.title.hasPrefix("PR review · ") else { return .hidden }

        if isEffectivelySnoozed(at: now) {
            return .snoozed
        }
        if shell.pinnedAt != nil {
            return .active
        }
        return isEffectivelySettled(
            at: now,
            autoSettleAfterDays: autoSettleAfterDays,
            changeRequestState: changeRequestState
        )
            ? .settled
            : .active
    }

    var lifecycleSortDate: Date {
        latestActivityDate ?? pathwayDate(from: shell.updatedAt) ?? sortDate
    }

    private var hasPendingUserAction: Bool {
        guard let kind = shell.pendingRuntimeRequest?.kind else { return false }
        return kind != "auth_refresh"
    }

    private var hasLiveWork: Bool {
        let status = shell.activityRunStatus ?? shell.status
        return ["preparing", "queued", "starting", "running", "waiting"].contains(status)
    }

    private var latestActivityDate: Date? {
        [
            shell.latestUserMessageAt,
            shell.latestRunRequestedAt,
            shell.latestRunStartedAt,
            shell.latestRunCompletedAt
        ]
        .compactMap { value in value.flatMap(pathwayDate(from:)) }
        .max()
    }

    private func isEffectivelySnoozed(at now: Date) -> Bool {
        guard let wakeAt = shell.snoozedUntil.flatMap(pathwayDate(from:)), wakeAt > now else {
            return false
        }
        guard !hasPendingUserAction else { return false }

        let snoozedAt = shell.snoozedAt.flatMap(pathwayDate(from:))
        let status = shell.activityRunStatus ?? shell.status
        if ["error", "failed"].contains(status) {
            guard let snoozedAt else { return false }
            if let updatedAt = pathwayDate(from: shell.updatedAt), updatedAt > snoozedAt {
                return false
            }
        }

        if let snoozedAt, runCompleted(after: snoozedAt) {
            return false
        }
        return true
    }

    private func runCompleted(after date: Date) -> Bool {
        guard ["completed", "idle"].contains(shell.status),
              let completedAt = shell.latestRunCompletedAt.flatMap(pathwayDate(from:))
        else {
            return false
        }
        return completedAt > date
    }

    private func isEffectivelySettled(
        at now: Date,
        autoSettleAfterDays: Int?,
        changeRequestState: PathwayChangeRequestState?
    ) -> Bool {
        guard !hasPendingUserAction, !hasLiveWork else { return false }
        if hasQueuedTurnStart(at: now), !serverAdjudicatedQueuedTurn {
            return false
        }

        if shell.settledOverride == "settled" { return true }
        if shell.settledOverride == "active" { return false }
        if changeRequestState == .merged { return true }
        if changeRequestState == .open || changeRequestState == .closed { return false }
        guard let autoSettleAfterDays, let latestActivityDate else { return false }
        return latestActivityDate < now.addingTimeInterval(-Double(autoSettleAfterDays) * 86400)
    }

    private var serverAdjudicatedQueuedTurn: Bool {
        guard shell.settledOverride == "settled",
              let settledAt = shell.settledAt.flatMap(pathwayDate(from:)),
              let latestUserMessageAt = shell.latestUserMessageAt.flatMap(pathwayDate(from:))
        else {
            return false
        }
        return settledAt >= latestUserMessageAt
    }

    private func hasQueuedTurnStart(at now: Date) -> Bool {
        guard !["error", "failed"].contains(shell.status),
              let messageAt = shell.latestUserMessageAt.flatMap(pathwayDate(from:)),
              abs(now.timeIntervalSince(messageAt)) <= 120
        else {
            return false
        }

        return [
            shell.latestRunRequestedAt,
            shell.latestRunStartedAt,
            shell.latestRunCompletedAt
        ].allSatisfy { value in
            guard let value, let date = pathwayDate(from: value) else { return true }
            return date < messageAt
        }
    }

    static func isOrderedBefore(_ left: Self, _ right: Self) -> Bool {
        switch (left.shell.pinnedAt, right.shell.pinnedAt) {
        case (.some, .none):
            return true
        case (.none, .some):
            return false
        default:
            let leftDate = pathwayDate(from: left.shell.createdAt) ?? left.sortDate
            let rightDate = pathwayDate(from: right.shell.createdAt) ?? right.sortDate
            return leftDate == rightDate ? left.id < right.id : leftDate > rightDate
        }
    }

    static func isSnoozedBefore(_ left: Self, _ right: Self) -> Bool {
        let leftDate = left.shell.snoozedUntil.flatMap(pathwayDate(from:)) ?? .distantFuture
        let rightDate = right.shell.snoozedUntil.flatMap(pathwayDate(from:)) ?? .distantFuture
        return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
    }

    static func isSettledBefore(_ left: Self, _ right: Self) -> Bool {
        let leftDate = left.shell.settledAt.flatMap(pathwayDate(from:)) ?? left.lifecycleSortDate
        let rightDate = right.shell.settledAt.flatMap(pathwayDate(from:)) ?? right.lifecycleSortDate
        return leftDate == rightDate ? left.id < right.id : leftDate > rightDate
    }
}
