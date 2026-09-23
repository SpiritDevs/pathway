import Foundation

/// How one Focus sorts its active threads. Raw values match the web client and Convex.
enum PathwayFocusThreadSort: String, CaseIterable, Identifiable {
    case custom
    case recentWork = "recent_work"
    case recentActivity = "recent_activity"
    case createdAt = "created_at"
    case needsAttention = "needs_attention"
    case project

    var id: String { rawValue }

    var title: String {
        switch self {
        case .custom: "Custom order"
        case .recentWork: "Recent work"
        case .recentActivity: "Recent activity"
        case .createdAt: "Date created"
        case .needsAttention: "Needs attention first"
        case .project: "Project"
        }
    }
}

/// Synced per user for each Focus id, "all", or "conversations".
struct PathwayFocusViewPreference: Decodable, Equatable {
    let focusId: String
    let sortOrder: String
    let collapsiblePinned: Bool
}

struct PathwayFocusView: Equatable {
    var sort: PathwayFocusThreadSort = .custom
    var collapsiblePinned = false

    init(sort: PathwayFocusThreadSort = .custom, collapsiblePinned: Bool = false) {
        self.sort = sort
        self.collapsiblePinned = collapsiblePinned
    }

    /// A sort written by a newer client reads as Custom order.
    init(_ preference: PathwayFocusViewPreference?) {
        sort = preference.flatMap { PathwayFocusThreadSort(rawValue: $0.sortOrder) } ?? .custom
        collapsiblePinned = preference?.collapsiblePinned ?? false
    }
}

extension PathwayAgentThread {
    private var createdDate: Date { pathwayDate(from: shell.createdAt) ?? sortDate }

    /// Your last message, else creation.
    var recentWorkDate: Date { shell.latestUserMessageAt.flatMap(pathwayDate(from:)) ?? createdDate }

    /// Latest of creation, your last message, and the last run starting or finishing.
    var recentActivityDate: Date {
        ([shell.latestUserMessageAt, shell.latestRunStartedAt, shell.latestRunCompletedAt]
            .compactMap { $0.flatMap(pathwayDate(from:)) } + [createdDate]).max() ?? createdDate
    }

    /// Approval, input, or a failed last run.
    var needsFocusAttention: Bool {
        (shell.pendingRuntimeRequest.map { $0.kind != "auth_refresh" } ?? false) || shell.status == "failed"
    }
}

enum PathwayFocusThreadSorter {
    /// Custom keeps the list's existing order (iOS has no manual arrangement). The rest are
    /// newest first; Needs attention and Project group first, then sort by recent activity.
    static func sorted(
        _ threads: [PathwayAgentThread],
        by sort: PathwayFocusThreadSort,
        projectName: (PathwayAgentThread) -> String? = { _ in nil }
    ) -> [PathwayAgentThread] {
        func newestFirst(_ key: @escaping (PathwayAgentThread) -> Date) -> (PathwayAgentThread, PathwayAgentThread) -> Bool {
            { left, right in key(left) == key(right) ? left.id < right.id : key(left) > key(right) }
        }
        let byActivity = newestFirst(\.recentActivityDate)
        switch sort {
        case .custom:
            return threads
        case .recentWork:
            return threads.sorted(by: newestFirst(\.recentWorkDate))
        case .createdAt:
            return threads.sorted(by: newestFirst { pathwayDate(from: $0.shell.createdAt) ?? $0.sortDate })
        case .recentActivity:
            return threads.sorted(by: byActivity)
        case .needsAttention:
            return threads.sorted { left, right in
                left.needsFocusAttention == right.needsFocusAttention
                    ? byActivity(left, right) : left.needsFocusAttention
            }
        case .project:
            let names = Dictionary(threads.map { ($0.id, projectName($0)) }, uniquingKeysWith: { first, _ in first })
            return threads.sorted { left, right in
                switch (names[left.id] ?? nil, names[right.id] ?? nil) {
                case let (.some(leftName), .some(rightName)):
                    let order = leftName.localizedStandardCompare(rightName)
                    return order == .orderedSame ? byActivity(left, right) : order == .orderedAscending
                case (.some, .none): return true
                case (.none, .some): return false
                case (.none, .none): return byActivity(left, right)
                }
            }
        }
    }
}
