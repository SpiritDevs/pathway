import SwiftUI

/// Time positions derive from instants, so daylight-saving days keep their actual 23/25-hour length.
struct PathwayCalendarScheduleView: View {
    @Bindable var model: PathwayCalendarModel
    let companyID: String
    let date: Date
    let week: Bool
    let hidden: Set<String>
    let onCreate: (Date) -> Void
    let onEdit: (PathwayCalendarRecord) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var days: [Date] {
        let calendar = Calendar.current
        let start = week ? calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? calendar.startOfDay(for: date) : calendar.startOfDay(for: date)
        return (0..<(week ? 7 : 1)).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }
    private var allDayHeight: CGFloat {
        let maximum = days.map { day in
            let end = Calendar.current.date(byAdding: .day, value: 1, to: day) ?? day.addingTimeInterval(86_400)
            return model.events.filter { $0.companyID == companyID && !hidden.contains($0.string("calendarId")) && $0.fields["allDay"]?.boolValue == true && ($0.date("startAt") ?? .distantPast) < end && ($0.date("endAt") ?? .distantPast) > day }.count
        }.max() ?? 0
        return CGFloat(max(1, maximum)) * 30
    }
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(days, id: \.self) { day in
                    PathwayCalendarDayColumn(model: model, companyID: companyID, day: day, hidden: hidden, allDayHeight: allDayHeight, onCreate: onCreate, onEdit: onEdit)
                        .frame(width: week ? (sizeClass == .regular ? 180 : 280) : (sizeClass == .regular ? 580 : 300))
                }
            }
        }
        .frame(height: sizeClass == .regular ? 640 : 480)
        .accessibilityLabel(week ? "Week schedule" : "Day schedule")
    }
}

private struct PathwayCalendarDayColumn: View {
    @Bindable var model: PathwayCalendarModel
    let companyID: String
    let day: Date
    let hidden: Set<String>
    let allDayHeight: CGFloat
    let onCreate: (Date) -> Void
    let onEdit: (PathwayCalendarRecord) -> Void
    private var end: Date { Calendar.current.date(byAdding: .day, value: 1, to: day) ?? day.addingTimeInterval(86_400) }
    private var hours: [Date] { (0..<Int(end.timeIntervalSince(day) / 3_600)).map { day.addingTimeInterval(Double($0) * 3_600) } }
    private var events: [PathwayCalendarRecord] {
        model.events.filter { $0.companyID == companyID && !hidden.contains($0.string("calendarId")) && $0.fields["allDay"]?.boolValue != true && ($0.date("startAt") ?? .distantPast) < end && ($0.date("endAt") ?? .distantPast) > day }
    }
    private var allDayEvents: [PathwayCalendarRecord] {
        model.events.filter { $0.companyID == companyID && !hidden.contains($0.string("calendarId")) && $0.fields["allDay"]?.boolValue == true && ($0.date("startAt") ?? .distantPast) < end && ($0.date("endAt") ?? .distantPast) > day }
    }
    var body: some View {
        VStack(spacing: 0) {
            Text(day, format: .dateTime.weekday(.abbreviated).day().month(.abbreviated)).font(.headline).frame(height: 40)
            VStack(alignment: .leading) {
                ForEach(allDayEvents) { event in
                    NavigationLink { PathwayCalendarEventDetail(model: model, original: event) } label: { Text(event.string("title")).font(.caption).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).frame(height: 26).padding(.horizontal, 5).background(.blue.opacity(0.12), in: .rect(cornerRadius: 5)) }
                }
            }.frame(height: allDayHeight, alignment: .top)
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    ForEach(hours, id: \.self) { hour in
                        Button { onCreate(hour) } label: {
                            VStack(alignment: .leading, spacing: 0) {
                                Divider()
                                Text(hour, format: .dateTime.hour().minute()).font(.caption2).foregroundStyle(.secondary).padding(.leading, 3)
                                Spacer(minLength: 0)
                            }.frame(width: geometry.size.width, height: 60)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Create event at \(hour.formatted(date: .abbreviated, time: .shortened))")
                        .disabled(!model.calendars.contains { $0.companyID == companyID && model.canEdit($0) })
                        .offset(y: hour.timeIntervalSince(day) / 60)
                        .dropDestination(for: String.self) { values, _ in
                            guard let id = values.first, let event = events.first(where: { $0.id == id }) ?? model.events.first(where: { $0.id == id && $0.companyID == companyID }), model.canEditEvent(event) else { return false }
                            Task { _ = await model.perform { var draft = PathwayCalendarDraft(event: event); let duration = draft.end.timeIntervalSince(draft.start); draft.start = hour; draft.end = hour.addingTimeInterval(duration); draft.allDay = false; try await model.save(draft, companyID: companyID, existing: event) } }
                            return true
                        }
                    }
                    ForEach(PathwayCalendarScheduleLayout.slots(events: events, day: day, end: end)) { slot in
                        let width = max(40, geometry.size.width - 43) / CGFloat(max(1, slot.columns))
                        PathwayCalendarScheduleEvent(model: model, event: slot.event, onEdit: { onEdit(slot.event) })
                            .frame(width: width - 3, height: max(30, slot.end.timeIntervalSince(slot.start) / 60))
                            .offset(x: 43 + CGFloat(slot.column) * width, y: max(0, slot.start.timeIntervalSince(day) / 60))
                    }
                }
            }.frame(height: end.timeIntervalSince(day) / 60)
        }
        .overlay(alignment: .trailing) { Divider() }
    }

}

private struct PathwayCalendarScheduleEvent: View {
    @Bindable var model: PathwayCalendarModel
    let event: PathwayCalendarRecord
    let onEdit: () -> Void
    @State private var resizeOffset: CGFloat = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.canEditEvent(event) {
                Button(action: onEdit) { content }.buttonStyle(.plain).draggable(event.id)
            } else {
                NavigationLink { PathwayCalendarEventDetail(model: model, original: event) } label: { content }.buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            if model.canEditEvent(event) {
                Capsule().fill(.blue).frame(width: 26, height: 4).frame(maxWidth: .infinity).frame(height: 14)
                    .contentShape(.rect)
                    .gesture(DragGesture(minimumDistance: 8)
                        .onChanged { resizeOffset = $0.translation.height }
                        .onEnded { gesture in
                            resizeOffset = 0
                            let minutes = (gesture.translation.height / 15).rounded() * 15
                            Task { _ = await model.perform {
                                var draft = PathwayCalendarDraft(event: event)
                                draft.end = max(draft.start.addingTimeInterval(15 * 60), draft.end.addingTimeInterval(minutes * 60))
                                try await model.save(draft, companyID: event.companyID, existing: event)
                            } }
                        })
                    .accessibilityLabel("Resize \(event.string("title"))")
                    .accessibilityAdjustableAction { direction in
                        let minutes = direction == .increment ? 15.0 : -15.0
                        Task { _ = await model.perform { var draft = PathwayCalendarDraft(event: event); draft.end = max(draft.start.addingTimeInterval(900), draft.end.addingTimeInterval(minutes * 60)); try await model.save(draft, companyID: event.companyID, existing: event) } }
                    }
            }
        }
        .padding(.horizontal, 5).padding(.top, 3)
        .background(.blue.opacity(0.18), in: .rect(cornerRadius: 5))
        .overlay(alignment: .bottom) { if resizeOffset != 0 { Text("\(Int((resizeOffset / 15).rounded() * 15)) min").font(.caption2).padding(3).background(.regularMaterial) } }
        .clipped()
    }
    private var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(event.string("title")).font(.caption).fontWeight(.medium).lineLimit(2)
            if let start = event.date("startAt") { Text(start, format: .dateTime.hour().minute()).font(.caption2) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
