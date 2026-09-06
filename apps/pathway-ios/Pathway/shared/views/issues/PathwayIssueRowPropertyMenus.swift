import SwiftUI
import UIKit

struct PathwayIssueRowPropertyMenus: View {
    let model: PathwayIssuesModel
    let issue: PathwayIssueRecord
    var selection: [PathwayIssueRecord] = []
    let companies: [PathwayCompany]
    let projects: [PathwayCompanyProject]
    let chooseDueDate: () -> Void
    let onError: (String) -> Void

    private var current: PathwayIssueRecord { model.records.first { $0.identity == issue.identity } ?? issue }
    private var company: PathwayCompany? { companies.first { $0.id == issue.companyId } }
    private var targets: [PathwayIssueRecord] {
        (selection.isEmpty ? [issue] : selection).compactMap { selected in
            model.records.first { $0.identity == selected.identity && !$0.isDeleted }
        }
    }
    private var sharedProjectID: String? {
        guard let first = targets.first?.projectId, targets.allSatisfy({ $0.projectId == first }) else { return nil }
        return first
    }

    var body: some View {
        Menu("Assignee", systemImage: "person.crop.circle") {
            Button("Unassigned") { update(["assignee": .null]) }
            if let company {
                Button("You") { assign("member:\(company.membershipId)") }
            }
            ForEach(entities(model.members)) { member in
                Button(member.name) { assign("member:\(member.id)") }
            }
            Menu("Agent") {
                ForEach(["codex", "claude", "cursor", "grok", "opencode"], id: \.self) { provider in
                    Button(provider.capitalized) { assign("agent:\(provider)") }
                }
            }
        }
        Menu("Due date", systemImage: "calendar") {
            Button("Today") { setDate(days: 0) }
            Button("Tomorrow") { setDate(days: 1) }
            Button("In a week") { setDate(days: 7) }
            Button("In a month") { setDate(days: 30) }
            Button("Choose date…") { chooseDueDate() }
            Button("No due date") { update(["dueDate": .null]) }
        }
        Menu("Labels", systemImage: "tag") {
            if entities(model.labels).isEmpty { Text("No labels configured") }
            ForEach(entities(model.labels)) { label in
                Button {
                    toggleLabel(label.id)
                } label: {
                    if targets.allSatisfy({ $0.labelIds.contains(label.id) }) { Label(label.name, systemImage: "checkmark") }
                    else { Text(label.name) }
                }
            }
            if targets.contains(where: { !$0.labelIds.isEmpty }) { Button("Remove all labels") { update(["labelIds": .array([])]) } }
        }
        .menuActionDismissBehavior(.disabled)
        Menu("Project", systemImage: "folder") {
            Button("No project") { updateProject(nil) }
            ForEach(projects.filter { $0.companyId == issue.companyId && $0.project.archivedAt == nil }) { project in
                Button(project.project.name) { updateProject(project.project.id) }
            }
        }
        Menu("Milestone", systemImage: "flag.checkered") {
            Button("No milestone") { update(["milestoneId": .null]) }
            ForEach(entities(model.milestones).filter {
                sharedProjectID != nil && ($0.string("cloudProjectId") ?? $0.string("projectId")) == sharedProjectID
            }) { milestone in
                Button(milestone.name) { update(["milestoneId": .string(milestone.id)]) }
            }
        }
        Menu("Cycle", systemImage: "arrow.trianglehead.2.clockwise.rotate.90") {
            Button("No cycle") { update(["cycleId": .null]) }
            ForEach(entities(model.cycles)) { cycle in
                Button(cycle.name) { update(["cycleId": .string(cycle.id)]) }
            }
        }
        Menu("Remove", systemImage: "eraser") {
            if targets.contains(where: { $0.assignee != nil }) { Button("Assignee") { update(["assignee": .null]) } }
            if targets.contains(where: { !$0.labelIds.isEmpty }) { Button("Labels") { update(["labelIds": .array([])]) } }
            if targets.contains(where: { $0.projectId != nil }) { Button("Project") { updateProject(nil) } }
            if targets.contains(where: { $0.milestoneId != nil }) { Button("Milestone") { update(["milestoneId": .null]) } }
            if targets.contains(where: { $0.cycleId != nil }) { Button("Cycle") { update(["cycleId": .null]) } }
            if targets.contains(where: { $0.dueDate != nil }) { Button("Due date") { update(["dueDate": .null]) } }
            if targets.contains(where: { $0.parentId != nil }) { Button("Parent") { update(["parentId": .null]) } }
        }
        Menu("Copy", systemImage: "doc.on.doc") {
            Button("Issue ID") { UIPasteboard.general.string = targets.map(\.key).joined(separator: "\n") }
            Button("Issue title") { UIPasteboard.general.string = targets.map(\.title).joined(separator: "\n") }
            Button("Issue link") { UIPasteboard.general.string = targets.compactMap { PathwayIssueShareLink.url($0)?.absoluteString }.joined(separator: "\n") }
            Button("Markdown link") {
                UIPasteboard.general.string = targets.compactMap { item in
                    PathwayIssueShareLink.url(item).map { "[\(item.key) \(item.title)](\($0.absoluteString))" }
                }.joined(separator: "\n")
            }
        }
        ShareLink(item: targets.compactMap { PathwayIssueShareLink.url($0)?.absoluteString }.joined(separator: "\n")) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
    }

    private func entities(_ rows: [PathwayIssueEntity]) -> [PathwayIssueEntity] {
        rows.filter { $0.companyId == issue.companyId }
    }
    private func assign(_ token: String) { update(["assignee": PathwayIssueListConfiguration.assigneeJSON(token)]) }
    private func setDate(days: Int) {
        guard let date = Calendar.current.date(byAdding: .day, value: days, to: Date()) else { return }
        update(["dueDate": .string(PathwayIssueCatalogEditor.dateFormatter.string(from: date))])
    }
    private func update(_ patch: [String: JSONValue]) {
        let issues = targets
        Task {
            do { try await model.bulkUpdate(issues, patch: patch) }
            catch { onError(error.localizedDescription) }
        }
    }
    private func toggleLabel(_ id: String) {
        let issues = targets
        let remove = issues.allSatisfy { $0.labelIds.contains(id) }
        Task {
            do {
                for selected in issues {
                    let ids = remove ? selected.labelIds.filter { $0 != id } : Array(Set(selected.labelIds + [id])).sorted()
                    try await model.update(selected, patch: ["labelIds": .array(ids.map(JSONValue.string))])
                }
            } catch { onError(error.localizedDescription) }
        }
    }
    private func updateProject(_ id: String?) {
        let issues = targets
        Task {
            do {
                for selected in issues {
                    var patch: [String: JSONValue] = ["projectId": id.map(JSONValue.string) ?? .null]
                    if selected.projectId != id { patch["milestoneId"] = .null }
                    try await model.update(selected, patch: patch)
                }
            } catch { onError(error.localizedDescription) }
        }
    }
}

enum PathwayIssueShareLink {
    static func url(_ issue: PathwayIssueRecord) -> URL? {
        var components = URLComponents(string: "https://app.spiritdevs.com/issues")
        components?.queryItems = [URLQueryItem(name: "issue", value: issue.id)]
        return components?.url
    }
}

struct PathwayIssueDueDateSheet: View {
    let model: PathwayIssuesModel
    let issue: PathwayIssueRecord
    var selection: [PathwayIssueRecord] = []
    @Environment(\.dismiss) private var dismiss
    @State private var date = Date()
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Due date", selection: $date, displayedComponents: .date).datePickerStyle(.graphical)
                Button("Remove due date", role: .destructive) { save(nil) }.disabled(saving)
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle("Due date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save(date) }.disabled(saving) }
            }
            .interactiveDismissDisabled(saving)
            .task {
                if let text = issue.dueDate, let existing = PathwayIssueCatalogEditor.dateFormatter.date(from: text) { date = existing }
            }
        }
    }

    private func save(_ date: Date?) {
        saving = true
        Task {
            defer { saving = false }
            do {
                let value = date.map { JSONValue.string(PathwayIssueCatalogEditor.dateFormatter.string(from: $0)) } ?? .null
                try await model.bulkUpdate(selection.isEmpty ? [issue] : selection, patch: ["dueDate": value])
                dismiss()
            } catch { errorMessage = error.localizedDescription }
        }
    }
}
