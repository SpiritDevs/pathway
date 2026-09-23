import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayFocusViewTests {
    private let early = makeAgentThread(latestRunCompletedAt: "2026-08-29T01:00:00.000Z")
    private let late = makeAgentThread(latestRunCompletedAt: "2026-08-29T03:00:00.000Z")
    private let waiting = makeAgentThread(latestRunCompletedAt: "2026-08-29T02:00:00.000Z", pendingRequestKind: "user_input")

    private func order(_ threads: [PathwayAgentThread]) -> [String?] { threads.map(\.shell.latestRunCompletedAt) }

    @Test func unknownSyncedSortsReadAsCustomOrder() {
        let newer = PathwayFocusViewPreference(focusId: "all", sortOrder: "from-a-newer-client", collapsiblePinned: true)
        #expect(PathwayFocusView(newer) == PathwayFocusView(sort: .custom, collapsiblePinned: true))
        #expect(PathwayFocusView(nil) == PathwayFocusView())
    }

    @Test func sortsByActivityAndPutsAttentionFirst() {
        let threads = [early, late, waiting]
        #expect(order(PathwayFocusThreadSorter.sorted(threads, by: .custom)) == order(threads))
        #expect(order(PathwayFocusThreadSorter.sorted(threads, by: .recentActivity)) == order([late, waiting, early]))
        #expect(order(PathwayFocusThreadSorter.sorted(threads, by: .needsAttention)) == order([waiting, late, early]))
        var failed = early
        failed.shell.status = "failed"
        #expect(order(PathwayFocusThreadSorter.sorted([late, failed], by: .needsAttention)) == order([failed, late]))
    }

    @Test func groupsByProjectNameWithUnassignedLast() {
        let names = [early.shell.latestRunCompletedAt: "beta", late.shell.latestRunCompletedAt: "Alpha"]
        let sorted = PathwayFocusThreadSorter.sorted([early, waiting, late], by: .project) { names[$0.shell.latestRunCompletedAt] }
        #expect(order(sorted) == order([late, early, waiting]))
    }
}
