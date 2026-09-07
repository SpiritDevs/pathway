import Foundation

struct PathwayCalendarScheduleSlot: Identifiable {
    let event: PathwayCalendarRecord
    let start: Date
    let end: Date
    let column: Int
    var columns: Int
    var id: String { event.id }
}

enum PathwayCalendarScheduleLayout {
    /// Each connected overlap group shares a lane count. Pairwise counts let A/B/C chains collide.
    static func slots(events: [PathwayCalendarRecord], day: Date, end: Date) -> [PathwayCalendarScheduleSlot] {
        let sorted = events.compactMap { event -> (PathwayCalendarRecord, Date, Date)? in
            guard let start = event.date("startAt"), let finish = event.date("endAt"), start < end, finish > day else { return nil }
            return (event, max(start, day), min(finish, end))
        }.sorted { $0.1 == $1.1 ? $0.0.id < $1.0.id : $0.1 < $1.1 }
        var result: [PathwayCalendarScheduleSlot] = []
        var group: [PathwayCalendarScheduleSlot] = []
        var laneEnds: [Date] = []
        var groupEnd = Date.distantPast
        func finishGroup() {
            result.append(contentsOf: group.map { slot in var slot = slot; slot.columns = laneEnds.count; return slot })
            group = []; laneEnds = []
        }
        for (event, start, finish) in sorted {
            if start >= groupEnd { finishGroup() }
            let column = laneEnds.firstIndex { $0 <= start } ?? laneEnds.count
            if column == laneEnds.count { laneEnds.append(finish) } else { laneEnds[column] = finish }
            group.append(.init(event: event, start: start, end: finish, column: column, columns: 1))
            groupEnd = max(groupEnd, finish)
        }
        finishGroup()
        return result
    }
}
