import SwiftUI
import Charts

struct PathwayCalendarView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Bindable var model: PathwayCalendarModel
    let companies: [PathwayCompany]
    var initialMode = "schedule"
    @State private var companyID = ""
    @State private var date = Date()
    @State private var mode = "Agenda"
    @State private var search = ""
    @State private var hidden: Set<String> = []
    @State private var editor: CalendarEditorDestination?
    @State private var workEditor: PathwayCalendarRecord?
    @State private var showSettings = false

    private var modePicker: some View {
        Picker("View", selection: $mode) {
            ForEach(["Agenda", "Day", "Week", "Month", "Timeline"], id: \.self) { Text($0) }
        }
        .accessibilityIdentifier("calendar-view-picker")
    }

    private var visibleEvents: [PathwayCalendarRecord] {
        let calendar = Calendar.current
        let interval = mode == "Day" ? calendar.dateInterval(of: .day, for: date) : mode == "Week" ? calendar.dateInterval(of: .weekOfYear, for: date) : calendar.dateInterval(of: .month, for: date)
        return model.events.filter { event in
            event.companyID == companyID && !hidden.contains(event.string("calendarId")) &&
                (search.isEmpty || event.string("title").localizedCaseInsensitiveContains(search)) &&
                (interval.map { (event.date("startAt") ?? .distantPast) < $0.end && (event.date("endAt") ?? .distantPast) > $0.start } ?? true)
        }
    }
    private var visibleWork: [PathwayCalendarRecord] {
        model.work.filter { row in
            guard row.companyID == companyID, !hidden.contains(row.kind), search.isEmpty || row.string("title").localizedCaseInsensitiveContains(search) || row.string("name").localizedCaseInsensitiveContains(search) else { return false }
            guard let end = row.date("dueDate") ?? row.date("targetDate") ?? row.date("endDate") ?? row.date("startDate") else { return false }
            let start = row.date("startDate") ?? end
            guard let interval = Calendar.current.dateInterval(of: mode == "Day" ? .day : mode == "Week" ? .weekOfYear : .month, for: date) else { return false }
            return start < interval.end && end >= interval.start
        }.sorted { ($0.date("dueDate") ?? $0.date("targetDate") ?? $0.date("endDate") ?? .distantPast) < ($1.date("dueDate") ?? $1.date("targetDate") ?? $1.date("endDate") ?? .distantPast) }
    }
    var body: some View {
        List {
            Section {
                Picker("Workspace", selection: $companyID) { ForEach(companies) { Text($0.name).tag($0.id) } }
                if dynamicTypeSize.isAccessibilitySize {
                    modePicker.pickerStyle(.menu)
                } else {
                    modePicker.pickerStyle(.segmented)
                }
                DatePicker("Date", selection: $date, displayedComponents: .date)
                    .datePickerStyle(.compact)
                if mode == "Month" { DatePicker("Month", selection: $date, displayedComponents: .date).datePickerStyle(.graphical).labelsHidden() }
            }
            if mode == "Day" || mode == "Week" {
                Section("Schedule") {
                    PathwayCalendarScheduleView(model: model, companyID: companyID, date: date, week: mode == "Week", hidden: hidden,
                        onCreate: { editor = .init(event: nil, start: $0) }, onEdit: { editor = .init(event: $0) })
                        .listRowInsets(EdgeInsets())
                }
            }
            if mode == "Timeline", !visibleWork.isEmpty {
                Section("Work timeline") {
                    Chart(Array(visibleWork.prefix(100))) { item in
                        let end = item.date("dueDate") ?? item.date("targetDate") ?? item.date("endDate") ?? date
                        let start = item.date("startDate") ?? end
                        let title = item.string("title").isEmpty ? item.string("name") : item.string("title")
                        BarMark(xStart: .value("Starts", start), xEnd: .value("Ends", Calendar.current.date(byAdding: .day, value: 1, to: end) ?? end), y: .value("Work", title))
                            .foregroundStyle(by: .value("Kind", item.kind == "issue" ? "Issue" : item.kind == "issueCycle" ? "Cycle" : "Milestone"))
                            .accessibilityLabel(title)
                            .accessibilityValue("\(start.formatted(date: .abbreviated, time: .omitted)) to \(end.formatted(date: .abbreviated, time: .omitted))")
                    }.frame(height: max(180, CGFloat(min(visibleWork.count, 100)) * 42))
                    if visibleWork.count > 100 { Text("Showing the first 100 items in the chart. All items are listed below.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Section("Events") {
                if visibleEvents.isEmpty { Text("No events in this period.").foregroundStyle(.secondary) }
                ForEach(visibleEvents) { event in
                    NavigationLink {
                        PathwayCalendarEventDetail(model: model, original: event)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(event.string("title")).font(.headline)
                            if let start = event.date("startAt") {
                                Text(start, format: .dateTime.weekday().day().month().hour().minute()).foregroundStyle(.secondary)
                            }
                            if event.fields["allDay"]?.boolValue == true { Text("All day").font(.caption) }
                            if !event.string("location").isEmpty { Label(event.string("location"), systemImage: "mappin").font(.caption) }
                        }.accessibilityElement(children: .combine)
                    }.accessibilityIdentifier("calendar-event-\(event.entityID)")
                }
            }
            Section("Dated work") {
                if visibleWork.isEmpty { Text("No dated work in this period.").foregroundStyle(.secondary) }
                ForEach(visibleWork) { item in
                    Button { workEditor = item } label: { VStack(alignment: .leading) {
                        Text(item.string("title").isEmpty ? item.string("name") : item.string("title"))
                        Text(item.kind == "issue" ? "Issue due date" : item.kind == "issueCycle" ? "Cycle" : "Milestone").font(.caption).foregroundStyle(.secondary)
                        if let day = item.date("dueDate") ?? item.date("targetDate") ?? item.date("endDate") { Text(day, format: .dateTime.day().month().year()).font(.caption) }
                    } }.foregroundStyle(.primary)
                }
            }
            if let error = model.errorMessage { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("Calendar")
        .onChange(of: initialMode, initial: true) { mode = ["day": "Day", "week": "Week", "month": "Month", "timeline": "Timeline"][initialMode] ?? "Agenda" }
        .searchable(text: $search, prompt: "Search events and work")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Today", systemImage: "calendar") { date = Date() }
                Menu("Layers", systemImage: "line.3.horizontal.decrease") {
                    ForEach(model.calendars.filter { $0.companyID == companyID }) { calendar in
                        Toggle(calendar.string("name"), isOn: Binding(get: { !hidden.contains(calendar.entityID) }, set: { if $0 { hidden.remove(calendar.entityID) } else { hidden.insert(calendar.entityID) } }))
                    }
                    ForEach(["issue", "issueMilestone", "issueCycle"], id: \.self) { kind in
                        Toggle(kind == "issue" ? "Issue due dates" : kind == "issueMilestone" ? "Milestones" : "Cycles", isOn: Binding(get: { !hidden.contains(kind) }, set: { if $0 { hidden.remove(kind) } else { hidden.insert(kind) } }))
                    }
                    Button("Calendar settings") { showSettings = true }
                }
                Button("New event", systemImage: "plus") { editor = .init(event: nil) }
                    .disabled(!model.calendars.contains { $0.companyID == companyID && model.canEdit($0) })
            }
        }
        .onChange(of: companies, initial: true) { if !companies.contains(where: { $0.id == companyID }) { companyID = companies.first?.id ?? "" } }
        .onChange(of: companyID) {
            let member = companies.first { $0.id == companyID }?.membershipId ?? ""
            hidden = Set(UserDefaults.standard.stringArray(forKey: "pathway.calendar.layers.\(companyID).\(member)") ?? [])
        }
        .onChange(of: hidden) {
            let member = companies.first { $0.id == companyID }?.membershipId ?? ""
            if !companyID.isEmpty && !member.isEmpty { UserDefaults.standard.set(hidden.sorted(), forKey: "pathway.calendar.layers.\(companyID).\(member)") }
        }
        .sheet(item: $workEditor) { item in PathwayCalendarWorkEditor(model: model, item: item) }
        .sheet(item: $editor) { destination in PathwayCalendarEventEditor(model: model, companyID: companyID, event: destination.event, start: destination.start) }
        .sheet(isPresented: $showSettings) { NavigationStack { PathwayCalendarSettingsView(model: model, companyID: companyID) } }
    }
}

private struct CalendarEditorDestination: Identifiable {
    let id = UUID()
    let event: PathwayCalendarRecord?
    var start: Date? = nil
}

struct PathwayCalendarEventEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayCalendarModel
    let companyID: String
    let event: PathwayCalendarRecord?
    @State private var draft: PathwayCalendarDraft

    init(model: PathwayCalendarModel, companyID: String, event: PathwayCalendarRecord?, start: Date? = nil) {
        self.model = model; self.companyID = companyID; self.event = event
        var draft = PathwayCalendarDraft(event: event)
        if event == nil, let start { draft.start = start; draft.end = start.addingTimeInterval(3_600) }
        if event == nil { draft.calendarID = model.calendars.first { $0.companyID == companyID && model.canEdit($0) }?.entityID ?? "" }
        _draft = State(initialValue: draft)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $draft.title).accessibilityIdentifier("calendar-event-title")
                    Picker("Calendar", selection: $draft.calendarID) {
                        ForEach(model.calendars.filter { $0.companyID == companyID && model.canEdit($0) }) { Text($0.string("name")).tag($0.entityID) }
                    }.disabled(event != nil)
                    Toggle("All day", isOn: $draft.allDay)
                    DatePicker("Starts", selection: $draft.start, displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute])
                    DatePicker("Ends", selection: $draft.end, displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute])
                    Picker("Time zone", selection: $draft.timeZone) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) } }
                }
                Section("Details") {
                    TextField("Location or meeting room", text: $draft.location)
                    TextField("Notes", text: $draft.notes, axis: .vertical).lineLimit(4...10)
                    TextField("Web links, one per line", text: $draft.urls, axis: .vertical).keyboardType(.URL).textInputAutocapitalization(.never)
                    TextField("Invitee emails, separated by commas", text: $draft.invitees, axis: .vertical).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                }
                Section {
                    ForEach([5, 10, 15, 30, 60, 1440], id: \.self) { minutes in
                        Toggle(minutes == 1440 ? "1 day before" : "\(minutes) minutes before", isOn: Binding(get: { draft.reminders.contains(minutes) }, set: { if $0 { draft.reminders.insert(minutes) } else { draft.reminders.remove(minutes) } }))
                    }
                } header: { Text("Reminders") } footer: { Text("Reminders sync with the event for desktop alerts. Reminder delivery is not yet supported on this device.") }
                if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
            }
            .environment(\.timeZone, TimeZone(identifier: draft.timeZone) ?? .current)
            .navigationTitle(event == nil ? "New event" : "Edit event")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { if await model.perform({ try await model.save(draft, companyID: companyID, existing: event) }) { dismiss() } } }.disabled(model.isWriting || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(model.isWriting)
        }
    }
}

private struct PathwayCalendarWorkEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayCalendarModel
    let item: PathwayCalendarRecord
    @State private var start: Date
    @State private var end: Date
    init(model: PathwayCalendarModel, item: PathwayCalendarRecord) {
        self.model = model; self.item = item
        let end = item.date("dueDate") ?? item.date("targetDate") ?? item.date("endDate") ?? Date()
        _start = State(initialValue: item.date("startDate") ?? end)
        _end = State(initialValue: end)
    }
    var body: some View {
        NavigationStack {
            Form {
                Text(item.string("title").isEmpty ? item.string("name") : item.string("title")).font(.headline)
                if item.kind != "issue" { DatePicker("Starts", selection: $start, displayedComponents: .date) }
                DatePicker(item.kind == "issue" ? "Due" : "Ends", selection: $end, displayedComponents: .date)
                if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Work dates")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { if await model.perform({ try await model.updateWork(item, start: item.kind == "issue" ? end : start, end: end) }) { dismiss() } } }.disabled(model.isWriting)
                }
            }
        }
    }
}
