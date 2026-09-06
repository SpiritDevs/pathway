import Foundation
import Testing
@testable import Pathway

struct PathwayLiveActivityTests {
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

    private func fixture(activeCount: Int = 1, phase: String = "running", updatedAt: String = "2026-09-06T11:00:00.000Z", rows: Bool = true) throws -> PathwayActivityAggregate {
        let row: [String: Any] = ["environmentId": "env-one", "threadId": "thread-one", "projectTitle": "Pathway", "threadTitle": "Fix sync", "modelTitle": "Codex", "phase": phase, "status": "Working", "updatedAt": updatedAt, "deepLink": "/threads/ignored"]
        let data = try JSONSerialization.data(withJSONObject: ["title": "Pathway", "subtitle": "1 agent working", "activeCount": activeCount, "updatedAt": updatedAt, "activities": rows ? [row] : []])
        return try JSONDecoder().decode(PathwayActivityAggregate.self, from: data)
    }
}
