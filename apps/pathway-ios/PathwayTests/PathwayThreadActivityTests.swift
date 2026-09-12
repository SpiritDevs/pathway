@testable import Pathway
import Testing

struct PathwayThreadActivityTests {
    @Test func sendingAppearsBeforeTheRunArrives() {
        #expect(activity(nil, sending: true) == .sending)
        #expect(activity("running", sending: true) == .sending)
        #expect(activity("running") == .working)
    }

    @Test func tracksTheRunLifecycle() {
        #expect(activity("queued") == .queued)
        #expect(activity("preparing") == .preparing)
        #expect(activity("starting") == .starting)
        #expect(activity("running") == .working)
        #expect(activity("waiting") == .waiting)
        #expect(activity("running") == .working)
        #expect(activity("completed") == nil)
    }

    @Test(arguments: ["completed", "failed", "interrupted", "cancelled", "rolled_back", "unknown"])
    func settledRunsDoNotKeepWorking(status: String) {
        #expect(activity(status) == nil)
    }

    @Test func idleThreadsHaveNoActivity() {
        #expect(activity(nil) == nil)
    }

    @Test(arguments: ["queued", "preparing", "starting", "running", "waiting"])
    func disconnectHidesCachedActivityUntilSynchronized(status: String) {
        #expect(PathwayThreadActivity(isSynchronized: false, isSending: false, runStatus: status) == nil)
        #expect(PathwayThreadActivity(isSynchronized: false, isSending: true, runStatus: status) == nil)
        #expect(activity(status) != nil)
    }

    private func activity(_ status: String?, sending: Bool = false) -> PathwayThreadActivity? {
        PathwayThreadActivity(isSynchronized: true, isSending: sending, runStatus: status)
    }
}
