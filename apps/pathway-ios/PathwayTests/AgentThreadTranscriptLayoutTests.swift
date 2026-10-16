import Foundation
@testable import Pathway
import Testing

@MainActor
struct AgentThreadTranscriptLayoutTests {
    @Test func settledRunFoldsCommentaryAndToolsButKeepsAnswerAndChildVisible() throws {
        let timeline = [
            try item("user", type: "user_message", ordinal: 0, start: "2026-09-06T00:00:00Z"),
            try item("commentary", type: "assistant_message", ordinal: 1),
            try item("command", type: "command_execution", ordinal: 2),
            try item("child", type: "subagent", ordinal: 3),
            try item("answer", type: "assistant_message", ordinal: 4, end: "2026-09-06T00:01:14Z")
        ]
        let rows = AgentThreadTranscriptLayout.rows(timeline, activeRunID: nil)
        #expect(rows.map(\.id) == ["user", "work:run", "child", "answer"])
        guard case let .work(label, items, settled, expanded) = rows[1].content else { Issue.record("Expected settled work fold"); return }
        #expect(label == "Worked for 1m 14s")
        #expect(items.map { timeline[$0].id } == ["commentary", "command"])
        #expect(settled)
        #expect(!expanded)
    }

    @Test func pendingRequestsAndErrorsCannotBeHiddenInWorkGroups() throws {
        let rows = AgentThreadTranscriptLayout.rows([
            try item("tool", type: "command_execution", ordinal: 0),
            try item("question", type: "user_input_request", ordinal: 1, status: "waiting"),
            try item("approval", type: "approval_request", ordinal: 2, status: "waiting"),
            try item("error", type: "error", ordinal: 3, status: "failed")
        ], activeRunID: "run")
        #expect(rows.map(\.id) == ["tool", "question", "approval", "error"])
        #expect(rows.allSatisfy { if case .item = $0.content { true } else { false } })
    }

    @Test func activeRunDoesNotHideAssistantProgressEvenWhenToolsHaveCompleted() throws {
        let rows = AgentThreadTranscriptLayout.rows([
            try item("commentary", type: "assistant_message", ordinal: 0),
            try item("tool", type: "command_execution", ordinal: 1),
            try item("answer", type: "assistant_message", ordinal: 2)
        ], activeRunID: "run")
        #expect(rows.map(\.id) == ["commentary", "tool", "answer"])
    }

    @Test func streamingOrInterruptedRunsNeverAcquireSettledWorkLabels() throws {
        let streaming = AgentThreadTranscriptLayout.rows([
            try item("commentary", type: "assistant_message", ordinal: 0),
            try item("answer", type: "assistant_message", ordinal: 1, streaming: true)
        ], activeRunID: nil)
        #expect(streaming.map(\.id) == ["commentary", "answer"])
        let interrupted = AgentThreadTranscriptLayout.rows([
            try item("commentary", type: "assistant_message", ordinal: 0),
            try item("interrupt", type: "run_interrupt_result", ordinal: 1),
            try item("answer", type: "assistant_message", ordinal: 2)
        ], activeRunID: nil)
        #expect(interrupted.map(\.id) == ["commentary", "interrupt", "answer"])
    }

    @Test func toolGroupsDoNotCrossRunBoundariesAndKeepStableIdentity() throws {
        let first = try item("search", type: "file_search", ordinal: 0, run: "a")
        let second = try item("command", type: "command_execution", ordinal: 1, run: "a")
        let third = try item("next", type: "command_execution", ordinal: 2, run: "b", status: "running")
        let rows = AgentThreadTranscriptLayout.rows([first, second, third], activeRunID: "a")
        #expect(rows.map(\.id) == ["activity:search", "next"])
        guard case let .work(label, grouped, settled, _) = rows[0].content else { Issue.record("Expected consecutive activity group"); return }
        #expect(label == "Searched 1 time, ran 1 command")
        #expect(grouped == [0, 1])
        #expect(!settled)
    }

    @Test func streamingPayloadUpdatesWithoutRebuildingHistoricalFolds() throws {
        let historical = try item("history", type: "command_execution", ordinal: 0, run: "old")
        let streaming = try item("live", type: "assistant_message", ordinal: 1, status: "running", streaming: true)
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        _ = cache.rows([historical, streaming], changes: changes, activeRunID: "run")
        var payload = streaming.fields
        payload["text"] = .string("The latest streamed response")
        payload["updatedAt"] = .string("2026-09-06T00:03:00Z")
        let updated = try #require(PathwayTimelineItem(json: .object(payload)))
        changes.update("live")
        let rows = cache.rows([historical, updated], changes: changes, activeRunID: "run")
        #expect(cache.rebuildCount == 1)
        let last = try #require(rows.last)
        guard case let .item(index) = last.content else { Issue.record("Expected latest message"); return }
        #expect([historical, updated][index].text == "The latest streamed response")
        payload["status"] = .string("completed")
        payload["streaming"] = .bool(false)
        let completed = try #require(PathwayTimelineItem(json: .object(payload)))
        changes.update("live")
        _ = cache.rows([historical, completed], changes: changes, activeRunID: nil)
        #expect(cache.rebuildCount == 2)
    }

    @Test func streamedTextKeepsTheRowsOfALongHistory() throws {
        var timeline: [PathwayTimelineItem] = []
        for turn in 0..<500 {
            let run = "run-\(turn)"
            timeline.append(try item("user-\(turn)", type: "user_message", ordinal: turn * 4, run: run))
            timeline.append(try item("search-\(turn)", type: "file_search", ordinal: turn * 4 + 1, run: run))
            timeline.append(try item("command-\(turn)", type: "command_execution", ordinal: turn * 4 + 2, run: run))
            timeline.append(try item("answer-\(turn)", type: "assistant_message", ordinal: turn * 4 + 3, run: run))
        }
        let live = try item("live", type: "assistant_message", ordinal: 2_000, run: "active", status: "running", streaming: true)
        timeline.append(live)
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        let initial = cache.rows(timeline, changes: changes, activeRunID: "active")
        #expect(initial.count == 1_501)
        for step in 1...200 {
            var payload = live.fields
            payload["text"] = .string(String(repeating: "word ", count: step))
            payload["updatedAt"] = .string("2026-09-06T00:03:\(String(format: "%02d", step % 60))Z")
            timeline[timeline.count - 1] = try #require(PathwayTimelineItem(json: .object(payload)))
            changes.update("live")
            let rows = cache.rows(timeline, changes: changes, activeRunID: "active")
            #expect(rows == initial)
        }
        #expect(cache.rebuildCount == 1)
        guard case let .item(index) = initial.last?.content else { Issue.record("Expected the live message"); return }
        #expect(timeline[index].text == String(repeating: "word ", count: 200))

        // An in-place update that changes structure, here an older item's status, still rebuilds.
        var failed = timeline[1].fields
        failed["status"] = .string("running")
        timeline[1] = try #require(PathwayTimelineItem(json: .object(failed)))
        changes.update(timeline[1].id)
        #expect(cache.rows(timeline, changes: changes, activeRunID: "active").map(\.id).prefix(3) == ["user-0", "activity:search-0", "answer-0"])
        #expect(cache.rebuildCount == 2)
    }

    @Test func unrecordedItemCountChangesStillRebuild() throws {
        let cache = AgentThreadTranscriptLayoutCache()
        let changes = PathwayTimelineChanges()
        let first = try item("first", type: "assistant_message", ordinal: 0)
        _ = cache.rows([first], changes: changes, activeRunID: "run")
        let rows = cache.rows([first, try item("second", type: "assistant_message", ordinal: 1)], changes: changes, activeRunID: "run")
        #expect(rows.map(\.id) == ["first", "second"])
        #expect(cache.rebuildCount == 2)
    }

    @Test func hiddenQueuedMessagesUseTheVisibilityFromTheLastRebuild() throws {
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        let timeline = [try item("answer", type: "assistant_message", ordinal: 0), try item("queued", type: "user_message", ordinal: 1, run: "next")]
        let hidden = cache.rows(timeline, changes: changes, activeRunID: "run", visibility: { { $0.id != "queued" } })
        #expect(hidden.map(\.id) == ["answer"])
        changes.restructure()
        #expect(cache.rows(timeline, changes: changes, activeRunID: "run").map(\.id) == ["answer", "queued"])
    }

    @Test func expandedGroupsListEachMemberAsATranscriptRow() throws {
        var timeline = [try item("user", type: "user_message", ordinal: 0)]
        for index in 1...1_000 { timeline.append(try item("tool-\(index)", type: "command_execution", ordinal: index)) }
        timeline.append(try item("answer", type: "assistant_message", ordinal: 1_001))
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        let collapsed = cache.rows(timeline, changes: changes, activeRunID: nil)
        #expect(collapsed.map(\.id) == ["user", "work:run", "answer"])

        let expanded = cache.rows(timeline, changes: changes, activeRunID: nil, expanded: ["work:run"])
        #expect(expanded.count == 1_003)
        #expect(expanded.map(\.id) == ["user", "work:run"] + (1...1_000).map { "tool-\($0)" } + ["answer"])
        guard case let .work(_, _, settled, isExpanded) = expanded[1].content else { Issue.record("Expected the group header"); return }
        #expect(settled && isExpanded)
        #expect(expanded[2].content == .child(1, closesGroup: false))
        #expect(expanded[1_001].content == .child(1_000, closesGroup: true))
        #expect(Set(expanded.map(\.id)).count == expanded.count)
        #expect(cache.rebuildCount == 1)

        #expect(cache.rows(timeline, changes: changes, activeRunID: nil) == collapsed)
    }

    @Test func activeGroupsExpandWithoutAClosingDivider() throws {
        let timeline = [try item("search", type: "file_search", ordinal: 0), try item("command", type: "command_execution", ordinal: 1)]
        let rows = AgentThreadTranscriptLayout.expand(AgentThreadTranscriptLayout.rows(timeline, activeRunID: "run"), items: timeline,
                                                      expanded: ["activity:search"])
        #expect(rows.map(\.content) == [
            .work(label: "Searched 1 time, ran 1 command", items: [0, 1], settled: false, expanded: true),
            .child(0, closesGroup: false), .child(1, closesGroup: false)
        ])
    }

    @Test func publishedPageStaysAboveTheAnswerWhenItsRunFolds() throws {
        let page = try render("page", ordinal: 2)
        let rows = AgentThreadTranscriptLayout.rows([
            try item("user", type: "user_message", ordinal: 0),
            try item("command", type: "command_execution", ordinal: 1),
            page,
            try item("later", type: "command_execution", ordinal: 3),
            try item("answer", type: "assistant_message", ordinal: 4)
        ], activeRunID: nil)
        #expect(rows.map(\.id) == ["user", "work:run", "page", "answer"])
        guard case let .work(_, folded, _, _) = rows[1].content else { Issue.record("Expected settled work fold"); return }
        #expect(folded == [1, 3])

        // While the run is active the page ends the activity group around it.
        let active = AgentThreadTranscriptLayout.rows([
            try item("search", type: "file_search", ordinal: 0), try item("command", type: "command_execution", ordinal: 1),
            page, try item("later", type: "command_execution", ordinal: 3)
        ], activeRunID: "run")
        #expect(active.map(\.id) == ["activity:search", "page", "later"])
    }

    @Test func unpublishedPagesFoldLikeOtherToolCalls() throws {
        let rows = AgentThreadTranscriptLayout.rows([
            try item("user", type: "user_message", ordinal: 0),
            try render("failed", ordinal: 1, status: "failed"),
            try item("answer", type: "assistant_message", ordinal: 2)
        ], activeRunID: nil)
        #expect(rows.map(\.id) == ["user", "work:run", "answer"])
    }

    @Test func pageOutputArrivingAfterCompletionRebuildsTheLayout() throws {
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        let pending = try render("page", ordinal: 0, output: .null)
        #expect(cache.rows([pending], changes: changes, activeRunID: nil).map(\.id) == ["work:run"])
        changes.update("page")
        #expect(cache.rows([try render("page", ordinal: 0)], changes: changes, activeRunID: nil).map(\.id) == ["page"])
        #expect(cache.rebuildCount == 2)
    }

    @Test func pageMetadataUsesCurrentItemsAndInvalidOutputUnpinsTheRow() throws {
        let cache = AgentThreadTranscriptLayoutCache()
        var changes = PathwayTimelineChanges()
        changes.restructure()
        _ = cache.rows([try render("page", ordinal: 0)], changes: changes, activeRunID: nil)
        let changed: JSONValue = .object(["htmlRender": .object([
            "attachmentId": .string("thread-replacement-html"), "title": .string("Updated"), "height": .number(600)
        ])])
        let current = [try render("page", ordinal: 0, output: changed)]
        changes.update("page")
        let rows = cache.rows(current, changes: changes, activeRunID: nil)
        guard case let .item(index) = rows.first?.content else { Issue.record("Expected page row"); return }
        #expect(PathwayHTMLRender(current[index])?.attachmentID == "thread-replacement-html")
        #expect(PathwayHTMLRender(current[index])?.height == 600)
        #expect(cache.rebuildCount == 1)
        let invalid: JSONValue = .object(["htmlRender": changed.objectValue!["htmlRender"]!, "isError": .bool(true)])
        changes.update("page")
        #expect(cache.rows([try render("page", ordinal: 0, output: invalid)], changes: changes, activeRunID: nil).map(\.id) == ["work:run"])
        #expect(cache.rebuildCount == 2)
    }

    private func render(_ id: String, ordinal: Int, status: String = "completed", output: JSONValue? = nil) throws -> PathwayTimelineItem {
        let reference: JSONValue = .object(["attachmentId": .string("thread-\(id)-html"), "title": .string("Chart"), "height": .number(420)])
        return try #require(PathwayTimelineItem(json: .object([
            "id": .string(id), "type": .string("dynamic_tool"), "ordinal": .number(Double(ordinal)), "runId": .string("run"),
            "status": .string(status), "toolName": .string("pathway.html_render"), "startedAt": .string("2026-09-06T00:00:01Z"),
            "completedAt": .string("2026-09-06T00:00:02Z"), "updatedAt": .string("2026-09-06T00:00:02Z"),
            "output": output ?? .object(["htmlRender": reference, "message": .string("Rendered above your reply.")])
        ])))
    }

    private func item(_ id: String, type: String, ordinal: Int, run: String = "run", status: String = "completed", streaming: Bool = false,
                      start: String = "2026-09-06T00:00:01Z", end: String = "2026-09-06T00:00:02Z") throws -> PathwayTimelineItem {
        try #require(PathwayTimelineItem(json: .object([
            "id": .string(id), "type": .string(type), "ordinal": .number(Double(ordinal)), "runId": .string(run),
            "status": .string(status), "streaming": .bool(streaming), "startedAt": .string(start),
            "completedAt": .string(end), "updatedAt": .string(end), "text": .string(id)
        ])))
    }
}
