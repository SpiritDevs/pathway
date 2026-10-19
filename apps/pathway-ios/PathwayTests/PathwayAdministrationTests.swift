import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayAdministrationTests {
    @Test func scheduleDraftPreservesProviderOptionsAndWorkspaceBranch() throws {
        let data = Data(#"{"id":"schedule","title":"Review","prompt":"Review changes","enabled":true,"schedule":{"type":"fixed_time","timeOfDay":"09:15","weekdays":[1,3,5]},"projectId":"project","threadId":null,"workspaceStrategy":{"type":"worktree","baseRef":"develop","startFromOrigin":false,"branch":"review"},"modelSelection":{"instanceId":"codex-work","model":"model-one","options":{"reasoningEffort":"high"}},"runtimeMode":"full-access","interactionMode":"default","nextRunAt":null,"lastRunAt":null,"lastRunStatus":"never","lastRunError":null,"runCount":0}"#.utf8)
        let task = try JSONDecoder().decode(PathwayAdministrationSchedule.self, from: data)
        var draft = PathwayAdministrationScheduleDraft(task: task)
        draft.title = "Updated review"
        let payload = try draft.payload()
        #expect(payload["modelSelection"] == task.modelSelection)
        #expect(payload["workspaceStrategy"] == task.workspaceStrategy)
        #expect(payload["schedule"] == task.schedule)
        #expect(payload["projectId"] == .string("project"))
        #expect(payload["creationSource"] == .string("mobile"))
        #expect(payload["commandId"] == (try draft.payload())["commandId"])
    }

    @Test func scheduleValidationRejectsInvalidTimeAndIncompleteModel() throws {
        var draft = PathwayAdministrationScheduleDraft()
        draft.title = "Daily"; draft.prompt = "Check"; draft.projectID = "p"
        #expect(!draft.isValid)
        draft.instanceID = "codex"; draft.model = "m"
        draft.scheduleType = "fixed_time"; draft.timeOfDay = "25:00"
        #expect(!draft.isValid)
        draft.timeOfDay = "09:05"
        #expect(draft.isValid)
        draft.intervalMinutes = 0
        #expect(throws: (any Error).self) { try draft.payload() }
    }

    @Test func tokenTotalsDoNotCountReasoningTwice() throws {
        let data = Data(#"{"uncachedInputTokens":10,"cachedInputTokens":20,"cacheCreationTokens":30,"outputTokens":40,"reasoningTokens":15}"#.utf8)
        let totals = try JSONDecoder().decode(PathwayAdministrationUsage.Totals.self, from: data)
        #expect(totals.tokens == 100)
    }

    @Test func quotaKeepsUnavailableDistinctFromZeroAndClampsRemaining() throws {
        let missing = try JSONDecoder().decode(PathwayAdministrationQuota.Limit.self, from: Data(#"{"window":"Weekly"}"#.utf8))
        let exhausted = try JSONDecoder().decode(PathwayAdministrationQuota.Limit.self, from: Data(#"{"window":"Weekly","usedPercent":105}"#.utf8))
        #expect(missing.remaining == nil)
        #expect(exhausted.remaining == 0)
    }
}
