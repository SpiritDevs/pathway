import Charts
import SwiftUI

struct PathwayIssueMilestoneTimeline: View {
    let model: PathwayIssuesModel
    let companyID: String
    let entities: [PathwayIssueEntity]
    @State private var editing: PathwayIssueEntity?

    private var dated: [PathwayIssueTimelineEntry] {
        entities.compactMap { entity in
            let formatter = PathwayIssueCatalogEditor.dateFormatter
            let start = entity.string("startDate").flatMap(formatter.date(from:))
            let end = entity.string("targetDate").flatMap(formatter.date(from:))
            guard let anchor = start ?? end else { return nil }
            return .init(id: entity.id, name: entity.name, start: anchor, end: max(anchor, end ?? anchor))
        }.sorted { $0.start < $1.start }
    }

    var body: some View {
        ScrollView {
            if dated.isEmpty {
                ContentUnavailableView("No milestone dates", systemImage: "calendar", description: Text("Add a start or target date to place milestones on the timeline."))
            } else {
                Chart(dated) { entry in
                    if entry.start == entry.end {
                        PointMark(x: .value("Date", entry.start), y: .value("Milestone", entry.id))
                            .symbol(.diamond)
                    } else {
                        BarMark(xStart: .value("Start", entry.start), xEnd: .value("Target", entry.end), y: .value("Milestone", entry.id))
                            .cornerRadius(4)
                    }
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                .chartYAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            if let id = value.as(String.self), let entry = dated.first(where: { $0.id == id }) {
                                Text(entry.name).lineLimit(1)
                            }
                        }
                    }
                }
                .frame(height: CGFloat(max(3, dated.count)) * 48)
                .padding()
                .accessibilityLabel("Milestone timeline")
                let undatedCount = entities.count - dated.count
                if undatedCount > 0 { Text("\(undatedCount) milestones have no dates.").font(.footnote).foregroundStyle(.secondary) }
            }
            LazyVStack(spacing: 0) {
                ForEach(entities) { entity in
                    Button { editing = entity } label: {
                        HStack {
                            Text(entity.name).foregroundStyle(.primary)
                            Spacer()
                            Label("Edit dates", systemImage: "calendar").font(.subheadline)
                        }
                        .frame(minHeight: 44)
                        .padding(.horizontal)
                    }
                }
            }
        }
        .navigationTitle("Timeline")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { entity in
            NavigationStack { PathwayIssueCatalogEditor(model: model, companyID: companyID, kind: .milestone, entity: entity) }
        }
    }
}

private struct PathwayIssueTimelineEntry: Identifiable {
    let id: String
    let name: String
    let start: Date
    let end: Date
}

/// Historical counts come from the same reconstruction as desktop, never from today's snapshot.
struct PathwayIssueMilestoneHistory: View {
    let model: PathwayIssuesModel
    let entity: PathwayIssueEntity
    @State private var points: [PathwayIssueHistoryPoint] = []
    @State private var approximate = false
    @State private var loading = true
    @State private var error: String?

    private var refreshKey: String {
        let members = model.records.filter { $0.companyId == entity.companyId && $0.milestoneId == entity.id }
        return entity.identity + ":" + String(entity.updatedAt.timeIntervalSince1970) + ":" + members.map {
            $0.identity + ":" + String($0.updatedAt.timeIntervalSince1970)
        }.sorted().joined(separator: ",")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if loading && points.isEmpty {
                ProgressView("Loading history…").frame(maxWidth: .infinity)
            } else if let error {
                Text(error).font(.footnote).foregroundStyle(.secondary)
                Button("Try again") { Task { await load() } }
            } else if points.count < 2 {
                Text("The burn-up appears once this milestone has two days of history.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                Chart(points) { point in
                    AreaMark(x: .value("Date", point.date), y: .value("Completed", point.completed))
                        .foregroundStyle(Color.accentColor.opacity(0.12))
                    LineMark(x: .value("Date", point.date), y: .value("Issues", point.scope), series: .value("Series", "Scope"))
                        .foregroundStyle(by: .value("Series", "Scope"))
                    LineMark(x: .value("Date", point.date), y: .value("Issues", point.completed), series: .value("Series", "Completed"))
                        .foregroundStyle(by: .value("Series", "Completed"))
                }
                .chartForegroundStyleScale(["Scope": Color.secondary, "Completed": Color.accentColor])
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 3)) }
                .chartYAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                .frame(height: 190)
                .accessibilityLabel("Milestone scope and completed issues over time")
                DisclosureGroup("Daily history") {
                    ForEach(points.reversed()) { point in
                        HStack {
                            Text(point.date, format: .dateTime.month(.abbreviated).day())
                            Spacer()
                            Text("\(point.completed) / \(point.scope) completed").monospacedDigit()
                        }.font(.caption).padding(.vertical, 3)
                    }
                }
            }
            if approximate {
                Text("Some history is approximate because statuses or the milestone were renamed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .task(id: refreshKey) { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            guard let request = model.environmentRequest else {
                throw PathwayIssueWriteError(message: "Connect an environment to load milestone history.")
            }
            let response = try await request(entity.companyId, entity.string("cloudProjectId") ?? entity.string("projectId"), "issues.milestoneHistory", .object(["milestoneId": .string(entity.id)]))
            try Task.checkCancellation()
            guard let fields = response.objectValue, let rows = fields["points"]?.arrayValue else {
                throw PathwayIssueWriteError(message: "The environment did not return milestone history.")
            }
            let formatter = PathwayIssueCatalogEditor.dateFormatter
            points = rows.compactMap { row in
                guard let values = row.objectValue,
                      let text = values["date"]?.stringValue,
                      let date = formatter.date(from: text),
                      let scope = values["scope"]?.intValue,
                      let completed = values["completed"]?.intValue else { return nil }
                return .init(id: text, date: date, scope: scope, completed: completed)
            }
            approximate = fields["approximate"]?.boolValue ?? false
            error = nil
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }
}

private struct PathwayIssueHistoryPoint: Identifiable {
    let id: String
    let date: Date
    let scope: Int
    let completed: Int
}

struct PathwayIssuePlanAssignmentSheet: View {
    let model: PathwayIssuesModel
    let entity: PathwayIssueEntity
    let kind: PathwayIssueCatalogKind
    @Environment(\.dismiss) private var dismiss
    @State private var selectedIDs: Set<String> = []
    @State private var query = ""
    @State private var saving = false
    @State private var error: String?

    private var eligible: [PathwayIssueRecord] {
        model.records.filter { issue in
            guard issue.companyId == entity.companyId && !issue.isDeleted && !issue.triage else { return false }
            if kind == .milestone {
                guard issue.projectId == (entity.string("cloudProjectId") ?? entity.string("projectId")), issue.milestoneId != entity.id else { return false }
            } else if issue.cycleId == entity.id { return false }
            return true
        }
    }

    private var visible: [PathwayIssueRecord] {
        query.isEmpty ? eligible : eligible.filter { ($0.key + " " + $0.title).localizedStandardContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(visible) { issue in
                    Button {
                        if selectedIDs.contains(issue.id) { selectedIDs.remove(issue.id) }
                        else if selectedIDs.count < 500 { selectedIDs.insert(issue.id) }
                    } label: {
                        HStack {
                            Text(issue.title).lineLimit(1).foregroundStyle(.primary)
                            Spacer()
                            if selectedIDs.contains(issue.id) { Image(systemName: "checkmark") }
                        }.frame(minHeight: 44)
                    }
                }
            }
            .overlay {
                if visible.isEmpty { ContentUnavailableView.search(text: query) }
            }
            .searchable(text: $query, prompt: "Find issues")
            .navigationTitle("Add issues")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add \(selectedIDs.count)") { save() }.disabled(selectedIDs.isEmpty || saving)
                }
            }
        }
    }

    private func save() {
        saving = true
        let selected = eligible.filter { selectedIDs.contains($0.id) }
        Task {
            defer { saving = false }
            do {
                try await model.bulkUpdate(selected, patch: [kind == .milestone ? "milestoneId" : "cycleId": .string(entity.id)])
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
