import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayThreadRefreshTests {
    @Test func successAndPartialFailureFinishAndAllowAnotherRefresh() async {
        let refresh = PathwayThreadRefresh()
        await refresh.run { .updated }
        #expect(!refresh.isRefreshing)
        #expect(refresh.result == .updated)
        await refresh.run { .unavailable(["Offline Mac"]) }
        #expect(!refresh.isRefreshing)
        #expect(refresh.result == .unavailable(["Offline Mac"]))
        #expect(refresh.revision == 2)
    }

    @Test func deadlineFinishesEvenWhenWorkIgnoresCancellationAndLateSuccessIsDiscarded() async {
        let refresh = PathwayThreadRefresh()
        let work = RefreshGate()
        let deadline = RefreshGate()
        let task = Task { await refresh.run(deadline: { await deadline.wait() }) {
            await work.wait()
            return .updated
        } }
        await work.entered()
        await deadline.entered()
        await refresh.run { Issue.record("Duplicate refresh ran"); return .updated }
        #expect(refresh.isRefreshing)
        deadline.release()
        await task.value
        #expect(!refresh.isRefreshing)
        #expect(refresh.result == .timedOut)
        await refresh.run { .unavailable(["Mac"]) }
        work.release()
        #expect(refresh.result == .unavailable(["Mac"]))
    }

    @Test func cancellationFinishesTheGestureWithoutReportingSuccess() async {
        let refresh = PathwayThreadRefresh()
        let work = RefreshGate()
        let task = Task { await refresh.run { await work.wait(); return .updated } }
        await work.entered()
        task.cancel()
        await task.value
        #expect(!refresh.isRefreshing)
        #expect(refresh.result == nil)
        work.release()
    }

    @Test func errorFinishesAndReportsFailure() async {
        let refresh = PathwayThreadRefresh()
        await refresh.run { throw URLError(.notConnectedToInternet) }
        #expect(!refresh.isRefreshing)
        guard case .failed = refresh.result else { Issue.record("Expected a failure result"); return }
    }
}

@MainActor private final class RefreshGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var entry: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation = $0; entry?.resume(); entry = nil }
    }
    func entered() async {
        if continuation != nil { return }
        await withCheckedContinuation { entry = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
}
