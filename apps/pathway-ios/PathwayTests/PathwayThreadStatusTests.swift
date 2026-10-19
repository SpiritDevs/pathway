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

    private func status(request: String? = nil, hasPlan: Bool = false,
                        runStatus: String = "running", held: Bool = false) -> PathwayThreadStatus {
        PathwayThreadStatus(requestKind: request, hasPlan: hasPlan, runStatus: runStatus,
                            hasActiveRun: false, hasError: false, hasAllowanceHold: held)
    }
}
