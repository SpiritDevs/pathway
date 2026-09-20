import Foundation
#if os(iOS)
import ActivityKit
#endif

// These names and the JSON-string wrapper are the relay's APNs wire format.
struct LiveActivityAttributes: Codable, Sendable {
    struct ContentState: Codable, Hashable, Sendable {
        let name: String
        let props: String

        init(aggregate: PathwayActivityAggregate) throws {
            name = "AgentActivity"
            props = String(decoding: try JSONEncoder().encode(aggregate), as: UTF8.self)
        }

        var aggregate: PathwayActivityAggregate? {
            guard name == "AgentActivity" else { return nil }
            return try? JSONDecoder().decode(PathwayActivityAggregate.self, from: Data(props.utf8))
        }
    }
}
#if os(iOS)
extension LiveActivityAttributes: ActivityAttributes {}
#endif

struct PathwayActivityAggregate: Codable, Hashable, Sendable {
    let title: String
    let subtitle: String
    let activeCount: Int
    let updatedAt: String
    let activities: [PathwayActivityRow]
    var runningCount: Int? = nil

    var canStart: Bool { activeCount > 0 && !activities.isEmpty }
    var runningThreadCount: Int {
        // Older relays only sent activeCount, which includes questions and approvals.
        max(0, runningCount ?? (activeCount - activities.filter { $0.isWaiting }.count))
    }
    var restingStatusRow: PathwayActivityRow? {
        activities.first(where: { $0.isWaiting })
            ?? activities.first(where: { $0.phase == "failed" })
            ?? activities.first
    }
    var date: Date? { Self.parseDate(updatedAt) }
    func shouldReplace(_ previous: Self?) -> Bool {
        guard let previous else { return true }
        guard let date else { return false }
        guard let previousDate = previous.date else { return true }
        return date >= previousDate
    }
    static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct PathwayActivityRow: Codable, Hashable, Sendable, Identifiable {
    let environmentId: String
    let threadId: String
    let projectTitle: String
    let threadTitle: String
    let modelTitle: String
    let phase: String
    let status: String
    let updatedAt: String
    let deepLink: String
    var conversationCompanyId: String? = nil
    var startedAt: String? = nil
    var completedAt: String? = nil

    var isComplete: Bool { phase == "completed" }
    var hasQuestion: Bool { phase == "waiting_for_input" }
    var isWaiting: Bool { phase == "waiting_for_input" || phase == "waiting_for_approval" || phase == "stale" }
    var startDate: Date? { startedAt.flatMap(PathwayActivityAggregate.parseDate) }
    var endDate: Date? {
        guard phase == "completed" || phase == "failed" else { return nil }
        return PathwayActivityAggregate.parseDate(completedAt ?? updatedAt)
    }
    var elapsedText: String? {
        guard let startDate, let endDate, endDate >= startDate else { return nil }
        let seconds = Int(endDate.timeIntervalSince(startDate))
        return seconds >= 3600
            ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    var id: String { "\(environmentId):\(threadId)" }
    var url: URL? {
        guard !environmentId.isEmpty, !threadId.isEmpty,
              !environmentId.contains("/"), !threadId.contains("/") else { return nil }
        var url = URLComponents()
        url.scheme = "pathway"; url.host = "threads"
        url.path = "/\(environmentId)/\(threadId)"
        return url.url
    }
    var symbol: String {
        switch phase {
        case "waiting_for_approval": "hand.raised.fill"
        case "waiting_for_input": "questionmark.circle.fill"
        case "completed": "checkmark.circle.fill"
        case "failed": "exclamationmark.circle.fill"
        case "stale": "wifi.slash"
        default: "sparkles"
        }
    }
}
