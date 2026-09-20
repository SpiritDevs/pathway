import Foundation
import Testing
@testable import Pathway

struct PathwayLiveActivityTests {
    @Test func conversationLiveActivityPreservesOwnerAndConversationLabel() throws {
        let row = try JSONDecoder().decode(PathwayActivityRow.self, from: Data(#"{"environmentId":"env","threadId":"conversation","projectTitle":"Conversation","threadTitle":"Planning","modelTitle":"Codex","phase":"running","status":"Working","updatedAt":"2026-09-08T12:00:00Z","deepLink":"/threads/env/conversation","conversationCompanyId":"company-one"}"#.utf8))
        #expect(row.conversationCompanyId == "company-one")
        #expect(row.projectTitle == "Conversation")
        #expect(row.url?.absoluteString == "pathway://threads/env/conversation")
    }

    // Fixture uses the relay's ApnsClient contentState() shape, including stringified props.
    @Test func decodesRelayAPNsPayloadAndEmptyAttributes() throws {
        let aggregate = try fixture()
        let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
        let encoded = try JSONEncoder().encode(state)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["name"] as? String == "AgentActivity")
        #expect(object["props"] is String)
        #expect(try JSONDecoder().decode(LiveActivityAttributes.ContentState.self, from: encoded).aggregate == aggregate)
        let attributes = try JSONEncoder().encode(LiveActivityAttributes())
        #expect((try JSONSerialization.jsonObject(with: attributes) as? [String: Any])?.isEmpty == true)
        _ = try JSONDecoder().decode(LiveActivityAttributes.self, from: Data("{}".utf8))
    }

    @Test func noEmptyOrCompletedOnlyCardStarts() throws {
        #expect(try fixture().canStart)
        #expect(try !fixture(activeCount: 0, phase: "completed").canStart)
        #expect(try !fixture(rows: false).canStart)
    }

    @Test func islandCountsRunningThreadsEvenWhenTheRowsAreTruncated() throws {
        var aggregate = try fixture(activeCount: 10)
        aggregate.runningCount = 8
        #expect(aggregate.activities.count == 1)
        #expect(aggregate.runningThreadCount == 8)
        let roundTrip = try JSONDecoder().decode(PathwayActivityAggregate.self, from: JSONEncoder().encode(aggregate))
        #expect(roundTrip.runningThreadCount == 8)
    }

    @Test func olderCardsDoNotCountQuestionsAsRunningOrCompleted() throws {
        let running = try fixture()
        #expect(running.runningThreadCount == 1)
        for phase in ["waiting_for_input", "waiting_for_approval", "stale"] {
            let waiting = try fixture(phase: phase)
            #expect(waiting.runningThreadCount == 0)
            #expect(waiting.canStart)
            #expect(waiting.restingStatusRow?.phase == phase)
        }
        let completed = try fixture(activeCount: 0, phase: "completed")
        #expect(completed.runningThreadCount == 0)
        #expect(!completed.canStart)
        #expect(completed.restingStatusRow?.symbol == "checkmark.circle.fill")
        let failed = try fixture(activeCount: 0, phase: "failed")
        #expect(failed.restingStatusRow?.symbol == "exclamationmark.circle.fill")
    }

    @Test func foregroundSnapshotCannotReplaceNewerPushedContent() throws {
        let pushed = try fixture(updatedAt: "2026-09-06T11:00:01.123Z")
        let oldSnapshot = try fixture(updatedAt: "2026-09-06T11:00:00Z")
        #expect(!oldSnapshot.shouldReplace(pushed))
        #expect(pushed.shouldReplace(oldSnapshot))
        #expect(pushed.shouldReplace(pushed))
        #expect(try !fixture(updatedAt: "invalid").shouldReplace(pushed))
    }

    @Test func widgetLinksUseThreadIdentityAndIgnoreServerRelativeLink() throws {
        let row = try #require(fixture().activities.first)
        let url = try #require(row.url)
        #expect(PathwayProductLink(url: url)?.environmentID == "env-one")
        #expect(PathwayProductLink(url: url)?.threadID == "thread-one")
        #expect(url.absoluteString == "pathway://threads/env-one/thread-one")
    }

    @Test func malformedAndUnrelatedPayloadDoesNotRenderAFalseSummary() throws {
        let malformed = try JSONDecoder().decode(LiveActivityAttributes.ContentState.self, from: Data(#"{"name":"AgentActivity","props":"broken"}"#.utf8))
        #expect(malformed.aggregate == nil)
        let other = try JSONDecoder().decode(LiveActivityAttributes.ContentState.self, from: Data(#"{"name":"OtherActivity","props":"{}"}"#.utf8))
        #expect(other.aggregate == nil)
    }

    @Test func completedDurationUsesTurnTimesInsteadOfLastUpdate() throws {
        var row = try #require(fixture(phase: "completed").activities.first)
        row.startedAt = "2026-09-06T10:57:55Z"
        row.completedAt = "2026-09-06T11:00:00Z"
        #expect(row.elapsedText == "2:05")
        #expect(row.isComplete)
        #expect(row.symbol == "checkmark.circle.fill")
        let encoded = try JSONEncoder().encode(row)
        #expect(try JSONDecoder().decode(PathwayActivityRow.self, from: encoded).elapsedText == "2:05")
        row.startedAt = "2026-09-06T09:57:55Z"
        #expect(row.elapsedText == "1:02:05")
        row.startedAt = "2026-09-06T12:00:00Z"
        #expect(row.elapsedText == nil)
    }

    @Test func questionKeepsItsStartTimeWithoutACompletedTimer() throws {
        var row = try #require(fixture(phase: "waiting_for_input").activities.first)
        row.startedAt = "2026-09-06T10:57:55Z"
        #expect(row.hasQuestion)
        #expect(row.symbol == "questionmark.circle.fill")
        #expect(row.startDate != nil)
        #expect(row.endDate == nil)
        #expect(row.elapsedText == nil)
    }

    @Test func olderPayloadHasNoInventedDurationAndRowsOpenTheirOwnThreads() throws {
        let first = try #require(fixture().activities.first)
        #expect(first.startDate == nil)
        #expect(first.elapsedText == nil)
        let second = PathwayActivityRow(environmentId: "env-two", threadId: "thread-two", projectTitle: "Other",
            threadTitle: "Review", modelTitle: "Codex", phase: "completed", status: "Done",
            updatedAt: first.updatedAt, deepLink: "/threads/ignored")
        #expect(first.url != second.url)
        #expect(PathwayProductLink(url: try #require(second.url))?.environmentID == "env-two")
        #expect(PathwayProductLink(url: try #require(second.url))?.threadID == "thread-two")
    }

    private func fixture(activeCount: Int = 1, phase: String = "running", updatedAt: String = "2026-09-06T11:00:00.000Z", rows: Bool = true) throws -> PathwayActivityAggregate {
        let row: [String: Any] = ["environmentId": "env-one", "threadId": "thread-one", "projectTitle": "Pathway", "threadTitle": "Fix sync", "modelTitle": "Codex", "phase": phase, "status": "Working", "updatedAt": updatedAt, "deepLink": "/threads/ignored"]
        let data = try JSONSerialization.data(withJSONObject: ["title": "Pathway", "subtitle": "1 agent working", "activeCount": activeCount, "updatedAt": updatedAt, "activities": rows ? [row] : []])
        return try JSONDecoder().decode(PathwayActivityAggregate.self, from: data)
    }
}
