import SwiftUI

enum PathwayIssueCatalogKind: String, CaseIterable, Identifiable {
    case milestone, cycle, status, label
    var id: Self { self }
    var title: String {
        switch self {
        case .milestone: "Milestones"
        case .cycle: "Cycles"
        case .status: "Statuses"
        case .label: "Labels"
        }
    }
    var singular: String { String(title.dropLast()).lowercased() }
    var operation: String { "issue" + rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    @MainActor func entities(in model: PathwayIssuesModel, companyID: String) -> [PathwayIssueEntity] {
        let all: [PathwayIssueEntity]
        switch self {
        case .milestone: all = model.milestones
        case .cycle: all = model.cycles
        case .status: all = model.statuses
        case .label: all = model.labels
        }
        return all.filter { $0.companyId == companyID }.sorted { $0.position < $1.position }
    }
}

struct PathwayIssuePlanningView: View {
    let model: PathwayIssuesModel
    let companyID: String
    @State private var kind: PathwayIssueCatalogKind = .milestone

    var body: some View {
        VStack(spacing: 0) {
            Picker("Planning", selection: $kind) {
                Text("Milestones").tag(PathwayIssueCatalogKind.milestone)
                Text("Cycles").tag(PathwayIssueCatalogKind.cycle)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            PathwayIssueCatalogView(model: model, companyID: companyID, kind: kind)
                .id(kind)
        }
        .navigationTitle("Planning")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PathwayIssueCatalogView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let model: PathwayIssuesModel
    let companyID: String
    let kind: PathwayIssueCatalogKind
    @State private var creating = false
    @State private var editing: PathwayIssueEntity?
    @State private var error: String?
    @State private var projectFilter = ""

    private var entities: [PathwayIssueEntity] {
        kind.entities(in: model, companyID: companyID).filter {
            kind != .milestone || projectFilter.isEmpty || ($0.string("cloudProjectId") ?? $0.string("projectId")) == projectFilter
        }
    }

    var body: some View {
        List {
            if kind == .milestone {
                Picker("Project", selection: $projectFilter) {
                    Text("All projects").tag("")
                    ForEach(appModel.cloud.projects.filter { $0.companyId == companyID }) { project in
                        Text(project.project.name).tag(project.project.id)
                    }
                }
                NavigationLink {
                    PathwayIssueMilestoneTimeline(model: model, companyID: companyID, entities: entities)
                } label: { Label("Timeline", systemImage: "chart.bar.xaxis") }
            }
            ForEach(entities) { entity in
                if kind == .milestone || kind == .cycle {
                    NavigationLink {
                        PathwayIssuePlanDetailView(model: model, companyID: companyID, kind: kind, entityID: entity.id)
                    } label: {
                        catalogRow(entity)
                    }
                    .contextMenu { Button("Edit") { editing = entity } }
                } else {
                    Button { editing = entity } label: { catalogRow(entity) }
                        .foregroundStyle(.primary)
                }
            }
            .onMove { source, destination in
                var ordered = entities
                ordered.move(fromOffsets: source, toOffset: destination)
                Task {
                    do {
                        if kind == .status, let first = ordered.first {
                            _ = try await model.mutate(companyID: companyID, kind: "issueStatus.reorder",
                                entityID: first.id, args: ["statusIds": .array(ordered.map { .string($0.id) })])
                        } else {
                            for (position, entity) in ordered.enumerated() {
                                _ = try await model.mutate(companyID: companyID, kind: kind.operation + ".update",
                                    entityID: entity.id, args: ["position": .number(Double(position + 1))])
                            }
                        }
                    } catch { self.error = error.localizedDescription }
                }
            }
            .moveDisabled(kind == .cycle || kind == .label || (kind == .milestone && projectFilter.isEmpty) || model.isWriting)
        }
        .listStyle(.plain)
        .overlay {
            if entities.isEmpty {
                ContentUnavailableView("No \(kind.title.lowercased())", systemImage: "flag",
                    description: Text("Create a \(kind.singular) to organize your tasks."))
            }
        }
        .navigationTitle(kind.title)
        .toolbar {
            if kind == .status || (kind == .milestone && !projectFilter.isEmpty) { EditButton() }
            Button("New \(kind.singular)", systemImage: "plus") { creating = true }
        }
        .sheet(isPresented: $creating) {
            NavigationStack { PathwayIssueCatalogEditor(model: model, companyID: companyID, kind: kind) }
        }
        .sheet(item: $editing) { entity in
            NavigationStack { PathwayIssueCatalogEditor(model: model, companyID: companyID, kind: kind, entity: entity) }
        }
        .alert("Could not save", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func catalogRow(_ entity: PathwayIssueEntity) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entity.name).font(.body)
            if kind == .milestone || kind == .cycle {
                let memberIssues = model.records.filter {
                    $0.companyId == companyID && !$0.isDeleted && !$0.triage
                        && (kind == .milestone ? $0.milestoneId == entity.id : $0.cycleId == entity.id)
                }
                let statusCategories = Dictionary(uniqueKeysWithValues: model.statuses.filter { $0.companyId == companyID }.map { ($0.id, $0.category) })
                let scoped = memberIssues.filter { statusCategories[$0.statusId] != "canceled" }
                let completed = scoped.filter { statusCategories[$0.statusId] == "completed" }.count
                let endDate = entity.string(kind == .cycle ? "endDate" : "targetDate")
                HStack {
                    Text("\(completed)/\(scoped.count) completed")
                    if let endDate { Text("· Due \(endDate)") }
                }.font(.caption).foregroundStyle(.secondary)
            } else if kind == .status {
                Text(entity.category.capitalized).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
    }
}

struct PathwayIssueCatalogEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    let model: PathwayIssuesModel
    let companyID: String
    let kind: PathwayIssueCatalogKind
    var entity: PathwayIssueEntity?
    @State private var name = ""
    @State private var description = ""
    @State private var projectID = ""
    @State private var color = "#8E8E93"
    @State private var category = "unstarted"
    @State private var startDate = Date()
    @State private var endDate = Date()
    @State private var hasStart = false
    @State private var hasEnd = false
    @State private var replacement = ""
    @State private var error: String?
    @State private var saving = false
    @State private var deleting = false
    @State private var loaded = false

    private var projects: [PathwayCompanyProject] {
        appModel.cloud.projects.filter { $0.companyId == companyID && $0.project.archivedAt == nil }
    }
    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !saving
            && (kind != .milestone || !projectID.isEmpty)
            && (!(kind == .cycle || (hasStart && hasEnd)) || startDate <= endDate)
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                if kind == .milestone {
                    Picker("Project", selection: $projectID) {
                        Text("Select project").tag("")
                        ForEach(projects) { Text($0.project.name).tag($0.project.id) }
                    }
                    TextField("Description", text: $description, axis: .vertical).lineLimit(3...6)
                }
                if kind == .label || kind == .status {
                    Picker("Color", selection: $color) {
                        ForEach(Array(Set(["#8E8E93", "#007AFF", "#34C759", "#FFCC00", "#FF3B30", "#AF52DE", color])).sorted(), id: \.self) {
                            Text($0).tag($0)
                        }
                    }
                }
                if kind == .status {
                    Picker("Category", selection: $category) {
                        ForEach(["backlog", "unstarted", "started", "review", "completed", "canceled"], id: \.self) {
                            Text($0.capitalized).tag($0)
                        }
                    }
                }
            }
            if kind == .milestone || kind == .cycle {
                Section("Dates") {
                    if kind == .milestone { Toggle("Start date", isOn: $hasStart) }
                    if hasStart || kind == .cycle { DatePicker("Start", selection: $startDate, displayedComponents: .date) }
                    if kind == .milestone { Toggle("Target date", isOn: $hasEnd) }
                    if hasEnd || kind == .cycle { DatePicker("End", selection: $endDate, displayedComponents: .date) }
                }
            }
            if let entity {
                Section {
                    if kind == .status {
                        Picker("Move tasks to", selection: $replacement) {
                            Text("Choose a status").tag("")
                            ForEach(model.statuses.filter { $0.companyId == companyID && $0.id != entity.id }) {
                                Text($0.name).tag($0.id)
                            }
                        }
                    }
                    Button("Delete \(kind.singular)", role: .destructive) { deleting = true }
                        .disabled(saving || (kind == .status && replacement.isEmpty))
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle(entity == nil ? "New \(kind.singular)" : "Edit \(kind.singular)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(!canSave) }
        }
        .onAppear(perform: load)
        .confirmationDialog("Delete this \(kind.singular)?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { save(removing: true) }
        } message: { Text("Tasks remain in the tracker. Their \(kind.singular) will be cleared or reassigned.") }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let entity else { return }
        name = entity.name
        description = entity.string("description") ?? ""
        projectID = entity.string("cloudProjectId") ?? entity.string("projectId") ?? ""
        color = entity.color
        category = entity.category
        let formatter = Self.dateFormatter
        if let text = entity.string("startDate"), let date = formatter.date(from: text) {
            startDate = date; hasStart = true
        }
        if let text = entity.string(kind == .cycle ? "endDate" : "targetDate"), let date = formatter.date(from: text) {
            endDate = date; hasEnd = true
        }
    }

    private func save(removing: Bool = false) {
        saving = true
        Task {
            defer { saving = false }
            do {
                var args: [String: JSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]
                if kind == .status {
                    args["category"] = .string(category)
                    if entity == nil { args["scope"] = .string("company") }
                }
                if kind == .status || kind == .label { args["color"] = .string(color) }
                if kind == .milestone {
                    args["cloudProjectId"] = .string(projectID)
                    args["description"] = .string(description)
                }
                if kind == .cycle || kind == .milestone {
                    if hasStart || kind == .cycle { args["startDate"] = .string(Self.dateFormatter.string(from: startDate)) }
                    else if entity != nil { args["startDate"] = .null }
                    let key = kind == .cycle ? "endDate" : "targetDate"
                    if hasEnd || kind == .cycle { args[key] = .string(Self.dateFormatter.string(from: endDate)) }
                    else if entity != nil { args[key] = .null }
                }
                if removing { args = kind == .status ? ["reassignToStatusId": .string(replacement)] : [:] }
                _ = try await model.mutate(companyID: companyID,
                    kind: kind.operation + (removing ? ".delete" : entity == nil ? ".create" : ".update"),
                    entityID: entity?.id ?? UUID().uuidString.lowercased(), args: args)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }

    static var dateFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }
}

struct PathwayIssuePlanDetailView: View {
    let model: PathwayIssuesModel
    let companyID: String
    let kind: PathwayIssueCatalogKind
    let entityID: String
    @State private var editing = false
    @State private var addingIssues = false
    @State private var selectedIssueID: String?
    @State private var error: String?

    private var entity: PathwayIssueEntity? { kind.entities(in: model, companyID: companyID).first { $0.id == entityID } }
    private var issues: [PathwayIssueRecord] {
        model.records.filter { $0.companyId == companyID && !$0.isDeleted && !$0.triage
            && (kind == .milestone ? $0.milestoneId == entityID : $0.cycleId == entityID) }
    }
    private var completed: Int {
        let ids = Set(model.statuses.filter { $0.companyId == companyID && $0.category == "completed" }.map(\.id))
        return issues.filter { ids.contains($0.statusId) }.count
    }
    private var total: Int {
        let canceled = Set(model.statuses.filter { $0.companyId == companyID && $0.category == "canceled" }.map(\.id))
        return issues.filter { !canceled.contains($0.statusId) }.count
    }
    var body: some View {
        List {
            Section {
                if let text = entity?.string("description"), !text.isEmpty { Text(text) }
                if let entity {
                    let start = entity.string("startDate")
                    let end = entity.string(kind == .cycle ? "endDate" : "targetDate")
                    if let start { LabeledContent("Start", value: start) }
                    if let end { LabeledContent(kind == .cycle ? "End" : "Target", value: end) }
                }
                ProgressView(value: Double(completed), total: Double(max(1, total))) {
                    Text("\(completed) of \(total) completed")
                }
            }
            if kind == .milestone, let entity {
                Section("Burn-up") { PathwayIssueMilestoneHistory(model: model, entity: entity) }
            }
            Section {
                ForEach(issues) { issue in
                    Button { selectedIssueID = issue.id } label: {
                        HStack {
                            PathwayIssueStatusGlyph(category: model.statuses.first { $0.companyId == companyID && $0.id == issue.statusId }?.category ?? "unstarted", hexColor: nil)
                            Text(issue.title).lineLimit(1).foregroundStyle(.primary)
                        }.frame(minHeight: 44)
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) { remove(issue) }
                    }
                }
                Button("Add tasks", systemImage: "plus") { addingIssues = true }
            } header: { Text("Tasks") }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle(entity?.name ?? kind.title)
        .toolbar { Button("Edit") { editing = true } }
        .sheet(isPresented: $editing) {
            if let entity {
                NavigationStack { PathwayIssueCatalogEditor(model: model, companyID: companyID, kind: kind, entity: entity) }
            }
        }
        .sheet(isPresented: $addingIssues) {
            if let entity { PathwayIssuePlanAssignmentSheet(model: model, entity: entity, kind: kind) }
        }
        .navigationDestination(item: $selectedIssueID) { issueID in
            PathwayIssueDetailView(model: model, companyID: companyID, issueID: issueID)
        }
    }

    private func remove(_ issue: PathwayIssueRecord) {
        Task {
            do { try await model.update(issue, patch: [kind == .milestone ? "milestoneId" : "cycleId": .null]) }
            catch { self.error = error.localizedDescription }
        }
    }
}
