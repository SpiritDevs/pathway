import Foundation

enum PathwayIssueListScope: String, CaseIterable, Identifiable {
    case all, mine, triage
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "All tasks"
        case .mine: "My tasks"
        case .triage: "Triage"
        }
    }
}

/// The base-26 ordering contract shared by the desktop list and server. A move writes one row.
enum PathwayIssueOrdering {
    static func key(between before: String?, and after: String?) -> String? {
        func digits(_ text: String?) -> [Int]? {
            guard let text else { return [] }
            let values = text.utf8.map { Int($0) - 97 }
            guard !values.isEmpty, values.allSatisfy({ (0..<26).contains($0) }), values.last != 0 else { return nil }
            return values
        }
        guard let low = digits(before), let high = digits(after) else { return nil }
        if let after, (before ?? "") >= after { return nil }
        return String(bytes: midpoint(low, high).map { UInt8($0 + 97) }, encoding: .utf8)
    }

    private static func midpoint(_ low: [Int], _ high: [Int]) -> [Int] {
        if !high.isEmpty {
            var prefix = 0
            while prefix < high.count && (prefix < low.count ? low[prefix] : 0) == high[prefix] { prefix += 1 }
            if prefix > 0 {
                return Array(high.prefix(prefix)) + midpoint(Array(low.dropFirst(prefix)), Array(high.dropFirst(prefix)))
            }
        }
        let lower = low.first ?? 0
        let upper = high.first ?? 26
        if upper - lower > 1 { return [(lower + upper + 1) / 2] }
        if high.count > 1 { return [high[0]] }
        return [lower] + midpoint(Array(low.dropFirst()), [])
    }
}

/// Saved views use the desktop wire format. Search, selection and triage remain local UI state.
struct PathwayIssueListConfiguration: Equatable {
    var tab = "all"
    var statusIDs: Set<String> = []
    var projectIDs: Set<String> = []
    var labelIDs: Set<String> = []
    var milestoneIDs: Set<String> = []
    var cycleIDs: Set<String> = []
    var assignees: Set<String> = []
    var priorities: Set<String> = []
    var dueFilter = ""
    var grouping = "status"
    var sortMode = "manual"
    var viewMode = "list"

    static let priorityOrder = ["urgent", "high", "medium", "low", "none"]

    var filterCount: Int {
        [statusIDs, projectIDs, labelIDs, milestoneIDs, cycleIDs, assignees, priorities]
            .filter { !$0.isEmpty }.count + (dueFilter.isEmpty ? 0 : 1) + (tab == "all" ? 0 : 1)
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "tab": .string(tab), "grouping": .string(grouping),
            "sortMode": .string(sortMode), "viewMode": .string(viewMode),
        ]
        let filters = [
            "statusIds": statusIDs, "projectIds": projectIDs, "labelIds": labelIDs,
            "milestoneIds": milestoneIDs, "cycleIds": cycleIDs, "priorities": priorities,
        ]
        for (key, values) in filters where !values.isEmpty {
            fields[key] = .array(values.sorted().map(JSONValue.string))
        }
        if !assignees.isEmpty {
            fields["assignees"] = .array(assignees.sorted().map(Self.assigneeJSON))
        }
        if !dueFilter.isEmpty { fields["dueFilter"] = .string(dueFilter) }
        return .object(fields)
    }

    init() {}

    init(json: JSONValue) {
        let fields = json.objectValue ?? [:]
        tab = fields["tab"]?.stringValue ?? "all"
        grouping = fields["grouping"]?.stringValue ?? "status"
        sortMode = fields["sortMode"]?.stringValue ?? "manual"
        viewMode = fields["viewMode"]?.stringValue ?? "list"
        dueFilter = fields["dueFilter"]?.stringValue ?? ""
        func values(_ key: String) -> Set<String> {
            Set(fields[key]?.arrayValue?.compactMap(\.stringValue) ?? [])
        }
        statusIDs = values("statusIds")
        projectIDs = values("projectIds")
        labelIDs = values("labelIds")
        milestoneIDs = values("milestoneIds")
        cycleIDs = values("cycleIds")
        priorities = values("priorities")
        assignees = Set(fields["assignees"]?.arrayValue?.compactMap(Self.assigneeToken) ?? [])
    }

    static func assigneeToken(_ value: JSONValue?) -> String? {
        guard let fields = value?.objectValue else { return nil }
        switch fields["kind"]?.stringValue {
        case "user": return "user"
        case "member": return fields["membershipId"]?.stringValue.map { "member:\($0)" }
        case "agent": return fields["provider"]?.stringValue.map { "agent:\($0)" }
        default: return nil
        }
    }

    static func assigneeJSON(_ token: String) -> JSONValue {
        if token.hasPrefix("member:") {
            return .object(["kind": .string("member"), "membershipId": .string(String(token.dropFirst(7)))])
        }
        if token.hasPrefix("agent:") {
            return .object(["kind": .string("agent"), "provider": .string(String(token.dropFirst(6)))])
        }
        return .object(["kind": .string("user")])
    }

    static func matchesDueDate(_ dueDate: String?, filter: String, today: Date, calendar: Calendar = .current) -> Bool {
        if filter.isEmpty { return true }
        if filter == "none" { return dueDate == nil }
        guard let dueDate else { return false }
        func dateString(_ date: Date) -> String {
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        }
        let start = dateString(today)
        if filter == "overdue" { return dueDate < start }
        guard let end = calendar.date(byAdding: .day, value: filter == "week" ? 7 : 30, to: today) else { return false }
        return dueDate >= start && dueDate <= dateString(end)
    }

    func matches(_ issue: PathwayIssueRecord, category: String?, currentMembershipID: String?, today: Date) -> Bool {
        if tab == "active" && !["unstarted", "started", "review"].contains(category ?? "") { return false }
        if tab == "backlog" && category != "backlog" { return false }
        let values: [(Set<String>, String?)] = [
            (statusIDs, issue.statusId), (projectIDs, issue.projectId), (milestoneIDs, issue.milestoneId),
            (cycleIDs, issue.cycleId), (priorities, issue.priority),
        ]
        for (allowed, value) in values where !allowed.isEmpty {
            guard let value, allowed.contains(value) else { return false }
        }
        if !labelIDs.isEmpty && labelIDs.isDisjoint(with: issue.labelIds) { return false }
        if !assignees.isEmpty {
            let resolved = Set(assignees.map { token in
                token == "user" ? currentMembershipID.map { "member:\($0)" } ?? token : token
            })
            guard let token = Self.assigneeToken(issue.assignee), resolved.contains(token) else { return false }
        }
        return Self.matchesDueDate(issue.dueDate, filter: dueFilter, today: today)
    }
}
