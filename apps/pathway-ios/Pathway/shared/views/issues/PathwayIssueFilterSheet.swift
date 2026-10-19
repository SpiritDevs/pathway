import SwiftUI

struct PathwayIssueFilterSheet: View {
    @Binding var configuration: PathwayIssueListConfiguration
    let statuses: [PathwayIssueEntity]
    let labels: [PathwayIssueEntity]
    let milestones: [PathwayIssueEntity]
    let cycles: [PathwayIssueEntity]
    let members: [PathwayIssueEntity]
    let projects: [PathwayCompanyProject]
    let saveView: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("View") {
                    Picker("Show", selection: $configuration.tab) {
                        Text("All tasks").tag("all")
                        Text("Active").tag("active")
                        Text("Backlog").tag("backlog")
                    }
                    Picker("Layout", selection: $configuration.viewMode) {
                        Text("List").tag("list")
                        Text("Board").tag("board")
                    }
                    Picker("Group by", selection: $configuration.grouping) {
                        Text("Status").tag("status")
                        Text("Project").tag("project")
                        Text("Priority").tag("priority")
                        Text("Assignee").tag("assignee")
                        Text("No grouping").tag("none")
                    }
                    .disabled(configuration.viewMode == "board")
                    Picker("Sort by", selection: $configuration.sortMode) {
                        Text("Manual").tag("manual")
                        Text("Priority").tag("priority")
                        Text("Last updated").tag("updated")
                        Text("Created").tag("created")
                    }
                    if configuration.sortMode == "manual" && configuration.grouping != "status" && configuration.viewMode != "board" {
                        Text("Manual order applies within statuses. This grouping uses priority order.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Filters") {
                    filterLink("Status", selection: $configuration.statusIDs, options: statuses.map { .init(id: $0.id, name: $0.name) })
                    filterLink("Project", selection: $configuration.projectIDs, options: projects.map { .init(id: $0.project.id, name: $0.project.name) })
                    filterLink("Label", selection: $configuration.labelIDs, options: labels.map { .init(id: $0.id, name: $0.name) })
                    filterLink("Milestone", selection: $configuration.milestoneIDs, options: milestones.map { .init(id: $0.id, name: $0.name) })
                    filterLink("Cycle", selection: $configuration.cycleIDs, options: cycles.map { .init(id: $0.id, name: $0.name) })
                    filterLink("Assignee", selection: $configuration.assignees, options: assigneeOptions)
                    filterLink("Priority", selection: $configuration.priorities, options: PathwayIssueListConfiguration.priorityOrder.map { .init(id: $0, name: $0 == "none" ? "No priority" : $0.capitalized) })
                    Picker("Due date", selection: $configuration.dueFilter) {
                        Text("Any").tag("")
                        Text("Overdue").tag("overdue")
                        Text("Next 7 days").tag("week")
                        Text("Next 30 days").tag("month")
                        Text("No due date").tag("none")
                    }
                }
                Section {
                    Button("Save as view", systemImage: "star") { saveView() }
                    Button("Reset filters and display", role: .destructive) { configuration = .init() }
                }
            }
            .navigationTitle("Filter and display")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private var assigneeOptions: [PathwayIssueFilterOption] {
        [.init(id: "user", name: "You")]
            + members.map { .init(id: "member:\($0.id)", name: $0.name.isEmpty ? "Member" : $0.name) }
            + ["codex", "claude", "cursor", "grok", "opencode"].map { .init(id: "agent:\($0)", name: $0.capitalized) }
    }

    private func filterLink(_ title: String, selection: Binding<Set<String>>, options: [PathwayIssueFilterOption]) -> some View {
        NavigationLink {
            PathwayIssueFilterPicker(title: title, selection: selection, options: options)
        } label: {
            HStack {
                Text(title)
                Spacer()
                Text(selection.wrappedValue.isEmpty ? "Any" : "\(selection.wrappedValue.count) selected")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct PathwayIssueFilterOption: Identifiable {
    let id: String
    let name: String
}

private struct PathwayIssueFilterPicker: View {
    let title: String
    @Binding var selection: Set<String>
    let options: [PathwayIssueFilterOption]
    @State private var query = ""

    private var visibleOptions: [PathwayIssueFilterOption] {
        let knownIDs = Set(options.map(\.id))
        let all = options + selection.subtracting(knownIDs).sorted().map { .init(id: $0, name: "Unavailable (\($0))") }
        return query.isEmpty ? all : all.filter { $0.name.localizedStandardContains(query) }
    }

    var body: some View {
        List {
            Button("Any \(title.lowercased())") { selection = [] }
            ForEach(visibleOptions) { option in
                Button {
                    if selection.contains(option.id) { selection.remove(option.id) }
                    else if selection.count < 200 { selection.insert(option.id) }
                } label: {
                    HStack {
                        Text(option.name).foregroundStyle(.primary)
                        Spacer()
                        if selection.contains(option.id) { Image(systemName: "checkmark") }
                    }
                }
                .accessibilityAddTraits(selection.contains(option.id) ? .isSelected : [])
            }
        }
        .searchable(text: $query)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
