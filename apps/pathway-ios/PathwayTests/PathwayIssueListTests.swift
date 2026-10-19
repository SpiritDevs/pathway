import Foundation
@testable import Pathway
import Testing

struct PathwayIssueListTests {
    private let today = Date(timeIntervalSince1970: 1_783_036_800) // 2026-07-03 UTC
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        return value
    }

    @Test func dueWindowsExcludeOverdueAndIncludeTheirEndDate() {
        let date = DateComponents(calendar: calendar, year: 2026, month: 9, day: 5).date!
        #expect(!PathwayIssueListConfiguration.matchesDueDate("2026-09-04", filter: "week", today: date, calendar: calendar))
        #expect(PathwayIssueListConfiguration.matchesDueDate("2026-09-12", filter: "week", today: date, calendar: calendar))
        #expect(!PathwayIssueListConfiguration.matchesDueDate("2026-09-13", filter: "week", today: date, calendar: calendar))
        #expect(PathwayIssueListConfiguration.matchesDueDate("2026-10-05", filter: "month", today: date, calendar: calendar))
        #expect(!PathwayIssueListConfiguration.matchesDueDate("2026-09-05", filter: "overdue", today: date, calendar: calendar))
        #expect(PathwayIssueListConfiguration.matchesDueDate(nil, filter: "none", today: date, calendar: calendar))
        #expect(!PathwayIssueListConfiguration.matchesDueDate(nil, filter: "overdue", today: date, calendar: calendar))
    }

    @Test func filtersUseOrWithinLabelsAndAndAcrossFields() {
        var config = PathwayIssueListConfiguration()
        config.labelIDs = ["bug", "support"]
        config.projectIDs = ["project-one"]
        config.priorities = ["high", "urgent"]
        let record = PathwayIssueRecord(companyId: "company", fields: [
            "id": .string("issue"), "labelIds": .array([.string("support")]),
            "projectId": .string("project-one"), "priority": .string("high")
        ])
        #expect(config.matches(record, category: "started", currentMembershipID: "me", today: today))
        config.projectIDs = ["project-two"]
        #expect(!config.matches(record, category: "started", currentMembershipID: "me", today: today))
    }

    @Test func mineAssigneeFilterResolvesOnlyTheCurrentCompanyMembership() {
        var config = PathwayIssueListConfiguration()
        config.assignees = ["user"]
        let record = PathwayIssueRecord(companyId: "company", fields: [
            "assignee": .object(["kind": .string("member"), "membershipId": .string("member-a")])
        ])
        #expect(config.matches(record, category: "started", currentMembershipID: "member-a", today: today))
        #expect(!config.matches(record, category: "started", currentMembershipID: "member-b", today: today))
    }

    @Test func activeViewExcludesBacklogAndCompleted() {
        var config = PathwayIssueListConfiguration()
        config.tab = "active"
        let record = PathwayIssueRecord(companyId: "company", fields: [:])
        for category in ["unstarted", "started", "review"] {
            #expect(config.matches(record, category: category, currentMembershipID: nil, today: today))
        }
        for category in ["backlog", "completed", "canceled"] {
            #expect(!config.matches(record, category: category, currentMembershipID: nil, today: today))
        }
    }

    @Test func desktopSavedViewRetainsEveryFilterWhenOpenedAndSavedOnMobile() {
        let desktop: JSONValue = .object([
            "tab": .string("active"), "grouping": .string("project"),
            "sortMode": .string("updated"), "viewMode": .string("board"),
            "statusIds": .array([.string("status")]), "projectIds": .array([.string("project")]),
            "labelIds": .array([.string("label")]), "milestoneIds": .array([.string("milestone")]),
            "cycleIds": .array([.string("cycle")]), "priorities": .array([.string("high")]),
            "dueFilter": .string("week"),
            "assignees": .array([.object(["kind": .string("member"), "membershipId": .string("me")])])
        ])
        #expect(PathwayIssueListConfiguration(json: desktop).json == desktop)
    }

    @Test func manualReorderRemainsStrictAfterRepeatedMovesIntoTheSameGap() throws {
        var before = try #require(PathwayIssueOrdering.key(between: nil, and: nil))
        let after = try #require(PathwayIssueOrdering.key(between: before, and: nil))
        for _ in 0..<1_000 {
            let next = try #require(PathwayIssueOrdering.key(between: before, and: after))
            #expect(before < next && next < after)
            before = next
        }
        var head = "n"
        for _ in 0..<1_000 {
            let next = try #require(PathwayIssueOrdering.key(between: nil, and: head))
            #expect(next < head)
            head = next
        }
    }

    @Test func manualReorderRejectsCorruptOrReversedKeys() {
        for bad in ["", "G", "g1", "ba"] {
            #expect(PathwayIssueOrdering.key(between: bad, and: nil) == nil)
        }
        #expect(PathwayIssueOrdering.key(between: "m", and: "d") == nil)
        #expect(PathwayIssueOrdering.key(between: "m", and: "m") == nil)
        #expect(PathwayIssueOrdering.key(between: "g", and: "h") == "gn")
    }

    private func dragIssue(_ id: String, status: String = "review", order: String, company: String = "company", extra: [String: JSONValue] = [:]) -> PathwayIssueRecord {
        var fields: [String: JSONValue] = ["id": .string(id), "statusId": .string(status), "sortOrder": .string(order), "priority": .string("high")]
        fields.merge(extra) { _, value in value }
        return .init(companyId: company, fields: fields)
    }

    @Test func rowDropMovesAfterTheHoveredNeighbor() throws {
        let rows = [dragIssue("first", order: "b"), dragIssue("second", order: "c"), dragIssue("third", order: "d")]
        let move = try #require(PathwayIssueDropOrdering.resolve(
            payload: .init(companyID: "company", issueID: "first"), companyID: "company", records: rows,
            statusIDs: ["review"], targetStatusID: "review", targetIssueID: "third", edge: .after
        ))
        #expect(move.issueID == "first")
        #expect(move.statusID == "review")
        #expect(move.sortOrder > "d")
    }

    @Test func crossingStatusAndEmptyHeaderDropsResolveOneStatusAndOrderingWrite() throws {
        let rows = [dragIssue("source", order: "b"), dragIssue("target", status: "started", order: "m")]
        let payload = PathwayIssueDragPayload(companyID: "company", issueID: "source")
        let cross = try #require(PathwayIssueDropOrdering.resolve(
            payload: payload, companyID: "company", records: rows, statusIDs: ["review", "started", "unstarted"],
            targetStatusID: "started", targetIssueID: "target", edge: .before
        ))
        #expect(cross.statusID == "started")
        #expect(cross.sortOrder < "m")
        let empty = try #require(PathwayIssueDropOrdering.resolve(
            payload: payload, companyID: "company", records: rows, statusIDs: ["review", "started", "unstarted"],
            targetStatusID: "unstarted", targetIssueID: nil, edge: .before
        ))
        #expect(empty.statusID == "unstarted")
        #expect(empty.sortOrder == "n")
    }

    @Test func nativeListInsertionCrossesStatusHeadersAndHandlesEmptyGroups() throws {
        let entries: [PathwayIssueListDropEntry] = [
            .init(issueID: nil, statusID: "review"),
            .init(issueID: "source", statusID: "review"),
            .init(issueID: "second", statusID: "review"),
            .init(issueID: nil, statusID: "started"),
            .init(issueID: "target", statusID: "started"),
            .init(issueID: nil, statusID: "empty"),
        ]
        let within = try #require(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "source", destination: 3))
        #expect(within.statusID == "review" && within.targetIssueID == "second" && within.edge == .after)
        let cross = try #require(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "source", destination: 4))
        #expect(cross.statusID == "started" && cross.targetIssueID == "target" && cross.edge == .before)
        let empty = try #require(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "source", destination: 6))
        #expect(empty.statusID == "empty" && empty.targetIssueID == nil)
        let upwards = try #require(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "target", destination: 1))
        #expect(upwards.statusID == "review" && upwards.targetIssueID == "source" && upwards.edge == .before)
        #expect(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "source", destination: 7) == nil)
        #expect(PathwayIssueListDropPosition.resolve(entries: entries, sourceID: "missing", destination: 1) == nil)
    }

    @Test func dropsRejectForeignCompanyDeletedTriageAndStaleTargets() {
        let rows = [dragIssue("source", order: "b"), dragIssue("target", order: "m")]
        func resolve(_ payload: PathwayIssueDragPayload, records: [PathwayIssueRecord]? = nil, target: String = "target", status: String = "review") -> PathwayIssueDropMove? {
            PathwayIssueDropOrdering.resolve(payload: payload, companyID: "company", records: records ?? rows, statusIDs: ["review"], targetStatusID: status, targetIssueID: target, edge: .after)
        }
        #expect(resolve(.init(companyID: "other-company", issueID: "source")) == nil)
        #expect(resolve(.init(companyID: "company", issueID: "source"), target: "missing") == nil)
        #expect(resolve(.init(companyID: "company", issueID: "source"), status: "missing") == nil)
        #expect(resolve(.init(companyID: "company", issueID: "source"), target: "source") == nil)
        for field in [["triage": JSONValue.bool(true)], ["deletedAt": JSONValue.number(1_800_000_000_000)]] {
            #expect(resolve(.init(companyID: "company", issueID: "source"), records: [dragIssue("source", order: "b", extra: field), rows[1]]) == nil)
        }
    }

    @MainActor @Test func crossStatusMoveSendsOneAtomicWriteAndPreservesPriorityUntilReplicaCatchesUp() async throws {
        var sent: [JSONValue] = []
        let model = PathwayIssuesModel(sendOperations: { _, value in
            sent += value.arrayValue ?? []
            return .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let company = PathwayCompany(id: "company", membershipId: "me", name: "Company", workspaceKind: "company", issueKeyPrefix: "PW", lifecycleState: "active", syncVersion: 1, isOwner: true)
        let source = dragIssue("source", order: "b")
        let change = PathwaySyncChange(version: 1, entityKind: "issue", entityId: source.id, changeKind: "upsert", payload: .object(source.fields))
        model.replaceReplica(["company": [change]], companies: [company])
        try await model.setSortOrder(source, sortOrder: "n", statusID: "started")
        #expect(sent.count == 1)
        #expect(sent[0].objectValue?["kind"] == .string("issue.setSortOrder"))
        #expect(sent[0].objectValue?["args"] == .object(["sortOrder": .string("n"), "statusId": .string("started")]))
        model.replaceReplica(["company": [change]], companies: [company])
        #expect(model.records[0].statusId == "started")
        #expect(model.records[0].sortOrder == "n")
        #expect(model.records[0].priority == "high")
    }
}
