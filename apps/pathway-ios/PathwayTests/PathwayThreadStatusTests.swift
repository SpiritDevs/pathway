import Foundation
@testable import Pathway
import Testing

struct PathwayThreadStatusTests {
    @Test(arguments: ["queued", "running", "waiting", "interrupted", "completed"])
    func allowanceHoldExplainsWhyWorkIsWaiting(runStatus: String) {
        #expect(status(runStatus: runStatus, held: true) == .waitingForAllowance)
    }

    @Test func pendingUserActionsTakePriorityOverAllowance() {
        #expect(status(request: "user_input", held: true) == .question)
        #expect(status(request: "file-change", held: true) == .approval)
        #expect(status(hasPlan: true, held: true) == .plan)
    }

    @Test func clearingAllowanceHoldRestoresRunStatus() {
        #expect(status(runStatus: "running") == .working)
        #expect(status(runStatus: "queued") == .queued)
        #expect(status(runStatus: "interrupted") == .stopped)
        #expect(status(runStatus: "completed") == .ready)
    }

    @Test func subagentRequestsWakeTheThreadAboveThem() {
        let parent = makeAgentThread(id: "parent", snoozedUntil: "2099-01-01T00:00:00.000Z")
        var review = makeAgentThread(id: "review", parentThreadId: "parent",
                                     pendingRequestKind: "command", relationshipToParent: "subagent")
        review.shell.activityRunStatus = "running"
        var helper = makeAgentThread(id: "helper", parentThreadId: "review",
                                     pendingRequestKind: "user_input", relationshipToParent: "subagent")
        helper.shell.activityRunStatus = "running"

        #expect(PathwayThreadLifecyclePartition(threads: [parent], now: Date()).snoozed.map(\.threadId) == ["parent"])
        let waiting = PathwayThreadLifecyclePartition(threads: [parent, review, helper], now: Date())
        #expect(waiting.active.map(\.threadId) == ["parent"])
        #expect(waiting.active.first?.pendingSubagentRequest == "approval")
        #expect(waiting.all.first { $0.threadId == "review" }?.pendingSubagentRequest == "user_input")

        // Once the subagent's run ends, nothing waits on its leftover question.
        var finished = helper
        finished.shell.activityRunStatus = nil
        finished.shell.status = "completed"
        #expect(PathwayThreadLifecyclePartition(threads: [parent, finished], now: Date()).snoozed.map(\.threadId) == ["parent"])

        #expect(status(request: "user_input", subagentRequest: "approval") == .approval)
        #expect(status(runStatus: "waiting", subagentRequest: "user_input") == .question)
    }

    private func status(request: String? = nil, hasPlan: Bool = false,
                        runStatus: String = "running", held: Bool = false,
                        subagentRequest: String? = nil) -> PathwayThreadStatus {
        PathwayThreadStatus(requestKind: request, hasPlan: hasPlan, runStatus: runStatus,
                            hasActiveRun: false, hasError: false, hasAllowanceHold: held,
                            subagentRequest: subagentRequest)
    }
}
