import Foundation

struct PathwayIssueCompositionClock {
    struct Interval: Equatable {
        let start: Double
        let end: Double
    }
    private var intervals: [Interval] = []
    private var start: Double?
    private var lastActivity: Double = 0

    private func monotonicNow(_ now: Double) -> Double {
        max(now, lastActivity, intervals.last?.end ?? 0)
    }

    mutating func activity(at now: Double) {
        let now = monotonicNow(now)
        if start != nil && now > lastActivity + 30_000 { pause(at: now) }
        if start == nil { start = now }
        lastActivity = now
    }

    mutating func pause(at now: Double) {
        guard let start else { return }
        let end = max(start, min(monotonicNow(now), lastActivity + 30_000))
        if end > start && intervals.count < 256 { intervals.append(Interval(start: start, end: end)) }
        self.start = nil
    }

    func snapshot(at now: Double) -> [Interval] {
        guard let start, intervals.count < 256 else { return intervals }
        let end = max(start, min(monotonicNow(now), lastActivity + 30_000))
        return end > start ? intervals + [Interval(start: start, end: end)] : intervals
    }
}
