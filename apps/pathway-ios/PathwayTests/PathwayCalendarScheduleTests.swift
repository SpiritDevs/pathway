import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayCalendarScheduleTests {
    private func event(_ id: String, start: Date, minutes: Double) -> PathwayCalendarRecord {
        .init(companyID: "company", kind: "calendarEvent", fields: ["id": .string(id), "startAt": .number(start.timeIntervalSince1970 * 1_000), "endAt": .number(start.addingTimeInterval(minutes * 60).timeIntervalSince1970 * 1_000)])
    }
    @Test func chainedOverlapsShareConsistentLanesAndAdjacentEventsReuseThem() {
        let day = Date(timeIntervalSince1970: 1_800_000_000)
        let events = [event("a", start: day, minutes: 60), event("b", start: day.addingTimeInterval(30 * 60), minutes: 60), event("c", start: day.addingTimeInterval(60 * 60), minutes: 60), event("d", start: day.addingTimeInterval(180 * 60), minutes: 60)]
        let slots = PathwayCalendarScheduleLayout.slots(events: events, day: day, end: day.addingTimeInterval(86_400))
        #expect(slots.map(\.columns) == [2, 2, 2, 1])
        #expect(slots.map(\.column) == [0, 1, 0, 0])
    }
    @Test func crossMidnightEventsClipToTheVisibleDay() {
        let day = Date(timeIntervalSince1970: 1_800_000_000)
        let slots = PathwayCalendarScheduleLayout.slots(events: [event("overnight", start: day.addingTimeInterval(-1800), minutes: 60)], day: day, end: day.addingTimeInterval(86_400))
        #expect(slots[0].start == day)
        #expect(slots[0].end.timeIntervalSince(day) == 1800)
    }
    @Test func triggerPayloadRequiresAMatcherAndPreservesTheProjectTarget() throws {
        let invalid = PathwayEmailTriggerDraft(id: "rule", projectID: "project", name: "Rule", enabled: false, sender: " ", subject: "", recipient: "", prompt: "Handle {{subject}}", hourlyCap: 5)
        #expect(throws: PathwayIssueWriteError.self) { try invalid.payload() }
        let valid = PathwayEmailTriggerDraft(id: "rule", projectID: "project", name: "Rule", enabled: false, sender: " sender@example.test ", subject: "", recipient: "", prompt: "Handle {{subject}}", hourlyCap: 5)
        let payload = try valid.payload()
        #expect(payload["projectId"] == .string("project"))
        #expect(payload["enabled"] == .bool(false))
        #expect(payload["matcher"]?.objectValue?["sender"] == .string("sender@example.test"))
        #expect(payload["matcher"]?.objectValue?["subject"] == .null)
    }
    @Test func retentionEmptyMeansInheritanceAndInvalidNumbersAreRejected() throws {
        #expect(try PathwayEmailRetentionOverride.parse(" ") == .null)
        #expect(try PathwayEmailRetentionOverride.parse("25") == .number(25))
        for invalid in ["0", "-1", "1.5", "letters"] { #expect(throws: PathwayIssueWriteError.self) { try PathwayEmailRetentionOverride.parse(invalid) } }
    }
}
