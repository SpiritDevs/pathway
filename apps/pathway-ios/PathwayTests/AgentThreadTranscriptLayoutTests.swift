import Foundation
@testable import Pathway
import Testing

@MainActor
struct AgentThreadTranscriptLayoutTests {
    @Test func settledRunFoldsCommentaryAndToolsButKeepsAnswerAndChildVisible() throws {
        let rows = AgentThreadTranscriptLayout.rows([
            try item("user", type: "user_message", ordinal: 0, start: "2026-09-06T00:00:00Z"),
            try item("commentary", type: "assistant_message", ordinal: 1),
            try item("command", type: "command_execution", ordinal: 2),
            try item("child", type: "subagent", ordinal: 3),
            try item("answer", type: "assistant_message", ordinal: 4, end: "2026-09-06T00:01:14Z")
        ], activeRunID: nil)
        #expect(rows.map(\.id) == ["user", "work:run", "child", "answer"])
        guard case let .work(label, items, settled) = rows[1].content else { Issue.record("Expected settled work fold"); return }
        #expect(label == "Worked for 1m 14s")
        #expect(items.map(\.id) == ["commentary", "command"])
        #expect(settled)
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
        guard case let .work(label, grouped, settled) = rows[0].content else { Issue.record("Expected consecutive activity group"); return }
        #expect(label == "Searched 1 time, ran 1 command")
        #expect(grouped.map(\.id) == ["search", "command"])
        #expect(!settled)
    }

    @Test func streamingPayloadUpdatesWithoutRebuildingHistoricalFolds() throws {
        let historical = try item("history", type: "command_execution", ordinal: 0, run: "old")
        let streaming = try item("live", type: "assistant_message", ordinal: 1, status: "running", streaming: true)
        let cache = AgentThreadTranscriptLayoutCache()
        _ = cache.rows([historical, streaming], activeRunID: "run")
        var payload = streaming.fields
        payload["text"] = .string("The latest streamed response")
        payload["updatedAt"] = .string("2026-09-06T00:03:00Z")
        let updated = try #require(PathwayTimelineItem(json: .object(payload)))
        let rows = cache.rows([historical, updated], activeRunID: "run")
        #expect(cache.rebuildCount == 1)
        let last = try #require(rows.last)
        guard case let .item(message) = last.content else { Issue.record("Expected latest message"); return }
        #expect(message.text == "The latest streamed response")
        payload["status"] = .string("completed")
        payload["streaming"] = .bool(false)
        let completed = try #require(PathwayTimelineItem(json: .object(payload)))
        _ = cache.rows([historical, completed], activeRunID: nil)
        #expect(cache.rebuildCount == 2)
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
        guard case let .work(_, folded, _) = rows[1].content else { Issue.record("Expected settled work fold"); return }
        #expect(folded.map(\.id) == ["command", "later"])

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
        let pending = try render("page", ordinal: 0, output: .null)
        #expect(cache.rows([pending], activeRunID: nil).map(\.id) == ["work:run"])
        #expect(cache.rows([try render("page", ordinal: 0)], activeRunID: nil).map(\.id) == ["page"])
        #expect(cache.rebuildCount == 2)
    }

    @Test func pageMetadataUsesCurrentItemsAndInvalidOutputUnpinsTheRow() throws {
        let cache = AgentThreadTranscriptLayoutCache()
        _ = cache.rows([try render("page", ordinal: 0)], activeRunID: nil)
        let changed: JSONValue = .object(["htmlRender": .object([
            "attachmentId": .string("thread-replacement-html"), "title": .string("Updated"), "height": .number(600)
        ])])
        let rows = cache.rows([try render("page", ordinal: 0, output: changed)], activeRunID: nil)
        guard case let .item(item) = rows.first?.content else { Issue.record("Expected page row"); return }
        #expect(PathwayHTMLRender(item)?.attachmentID == "thread-replacement-html")
        #expect(PathwayHTMLRender(item)?.height == 600)
        #expect(cache.rebuildCount == 1)
        let invalid: JSONValue = .object(["htmlRender": changed.objectValue!["htmlRender"]!, "isError": .bool(true)])
        #expect(cache.rows([try render("page", ordinal: 0, output: invalid)], activeRunID: nil).map(\.id) == ["work:run"])
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
