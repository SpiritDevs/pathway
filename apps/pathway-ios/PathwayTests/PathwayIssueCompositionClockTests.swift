import Testing
@testable import Pathway

struct PathwayIssueCompositionClockTests {
    @Test func clockAdjustmentsCannotCreateOverlappingIntervals() {
        var clock = PathwayIssueCompositionClock()
        clock.activity(at: 10_000)
        clock.pause(at: 20_000)
        clock.activity(at: 15_000)
        clock.activity(at: 14_000)
        #expect(clock.snapshot(at: 25_000) == [
            .init(start: 10_000, end: 20_000), .init(start: 20_000, end: 25_000),
        ])
    }
    @Test func idleGapsAndBackgroundTimeAreExcluded() {
        var clock = PathwayIssueCompositionClock()
        clock.activity(at: 1_000)
        clock.activity(at: 11_000)
        clock.activity(at: 100_000)
        #expect(clock.snapshot(at: 105_000) == [
            .init(start: 1_000, end: 41_000), .init(start: 100_000, end: 105_000),
        ])
        clock.pause(at: 105_000)
        #expect(clock.snapshot(at: 500_000) == clock.snapshot(at: 105_000))
    }
}
