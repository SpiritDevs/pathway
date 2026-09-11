import SwiftUI

/// Existing issue properties save individually, keeping the reading screen in sync.
struct PathwayIssuePropertiesView: View {
    let model: PathwayIssuesModel
    let companyID: String
    let issueID: String
    let onOpenIssue: (String) -> Void
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var property: String?
    @State private var dueDate = Date()
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var addRelation = false
    @FocusState private var focusedField: PathwayIssueEditorFocus?

    private var issue: PathwayIssueRecord? { model.records.first { $0.companyId == companyID && $0.id == issueID } }
    private func entities(_ values: [PathwayIssueEntity]) -> [PathwayIssueEntity] { values.filter { $0.companyId == companyID } }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).opacity(0.94).ignoresSafeArea()
            if let issue {
                if let property {
                    if property == "dueDate" { dateCard(issue) }
                    else {
                        PathwayIssueEditorPicker(title: propertyTitle(property), searchPrompt: property == "priority" ? nil : "Search…",
                            options: options(property), selectedIDs: selected(property, issue: issue), multiple: property == "labels",
                            close: closePicker, select: { select($0, property: property, issue: issue) }, focusedField: $focusedField)
                    }
                } else { summary(issue) }
            } else { ContentUnavailableView("Task unavailable", systemImage: "doc.text.magnifyingglass") }
        }
        .allowsHitTesting(!busy)
        .overlay { if busy { ProgressView().padding().background(.regularMaterial, in: Capsule()) } }
        .interactiveDismissDisabled(busy)
        .sheet(isPresented: $addRelation) {
            if let issue { PathwayIssueRelationPicker(model: model, issue: issue) }
        }
        .alert("Couldn’t update task", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }

    private func summary(_ issue: PathwayIssueRecord) -> some View {
        VStack(spacing: 0) {
            PathwayIssuePickerHeader(title: "Properties", close: { dismiss() }).padding(20)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    propertyRow("status", value: options("status").first { $0.id == issue.statusId }?.title ?? "Status", icon: "circle.lefthalf.filled")
                    propertyRow("priority", value: issue.priority == "none" ? "No priority" : issue.priority.capitalized, icon: "chart.bar.fill")
                    propertyRow("assignee", value: options("assignee").first { selected("assignee", issue: issue).contains($0.id) }?.title ?? "Assign", icon: "person.crop.circle.dashed")
                    propertyRow("dueDate", value: issue.dueDate.flatMap(Self.dateFormatter.date(from:))?.formatted(date: .numeric, time: .omitted) ?? "Due date", icon: "calendar")
                    sectionTitle("Labels")
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(entities(model.labels).filter { issue.labelIds.contains($0.id) }) { label in
                                Button { property = "labels" } label: {
                                    HStack(spacing: 6) {
                                        Circle().fill(color(label.color)).frame(width: 8, height: 8)
                                        Text(label.name)
                                    }.padding(.horizontal, 10).padding(.vertical, 8)
                                        .background(Color(uiColor: .tertiarySystemFill).opacity(0.5), in: Capsule())
                                }.buttonStyle(.plain)
                            }
                            Button("Add labels", systemImage: "plus") { property = "labels" }
                                .labelStyle(.iconOnly).frame(width: 36, height: 36).background(.quaternary, in: Circle())
                                .accessibilityIdentifier("issue-properties-labels")
                        }.padding(.horizontal, 20).padding(.bottom, 16)
                    }.scrollIndicators(.hidden)
                    sectionTitle("Project")
                    propertyRow("project", value: options("project").first { $0.id == issue.projectId }?.title ?? "No project", icon: "shippingbox")
                    propertyRow("milestone", value: entities(model.milestones).first { $0.id == issue.milestoneId }?.name ?? "No milestone", icon: "diamond")
                    propertyRow("cycle", value: entities(model.cycles).first { $0.id == issue.cycleId }?.name ?? "No cycle", icon: "arrow.trianglehead.2.clockwise.rotate.90")
                    sectionTitle("Relations")
                    Button("Add relation", systemImage: "plus") { addRelation = true }
                        .padding(.horizontal, 20).padding(.vertical, 12).foregroundStyle(.secondary)
                        .accessibilityIdentifier("issue-properties-add-relation")
                    propertyRow("parent", value: model.records.first { $0.companyId == companyID && $0.id == issue.parentId }?.title ?? "No parent task", icon: "arrow.turn.up.left")
                    ForEach(model.detail(for: issue).relations) { relation in relationRow(relation, issue: issue) }
                }.padding(.bottom, 20)
            }.accessibilityIdentifier("issue-properties-content")
        }
        .frame(maxWidth: 540, maxHeight: 680)
        .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 30))
        .clipShape(.rect(cornerRadius: 30))
        .shadow(color: .black.opacity(0.08), radius: 24, y: 10)
        .padding(.horizontal, 12).padding(.vertical, 16)
    }

    private func sectionTitle(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Divider()
            Text(title).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
        }.padding(.top, 12).padding(.bottom, 8)
    }

    private func propertyRow(_ key: String, value: String, icon: String) -> some View {
        Button {
            if key == "dueDate", let raw = issue?.dueDate, let date = Self.dateFormatter.date(from: raw) { dueDate = date }
            property = key
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(key == "status" ? statusColor : .secondary).frame(width: 22)
                Text(value).lineLimit(2)
                Spacer(minLength: 8)
                if key == "project" { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 13).contentShape(.rect)
        }.buttonStyle(.plain).accessibilityIdentifier("issue-properties-\(key)")
    }

    private var statusColor: Color { color(entities(model.statuses).first { $0.id == issue?.statusId }?.color ?? "") }
    private func color(_ hex: String) -> Color {
        guard let rgb = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else { return .secondary }
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }

    private func propertyTitle(_ key: String) -> String {
        switch key { case "dueDate": "Due date"; case "parent": "Parent task"; default: key.capitalized }
    }

    private func options(_ key: String) -> [PathwayIssuePickerOption] {
        switch key {
        case "status": return entities(model.statuses).map { .init(id: $0.id, title: $0.name, icon: "circle.lefthalf.filled", color: color($0.color)) }
        case "priority": return ["none", "urgent", "high", "medium", "low"].map {
            .init(id: $0, title: $0 == "none" ? "No priority" : $0.capitalized, icon: $0 == "none" ? "ellipsis" : $0 == "urgent" ? "exclamationmark.square.fill" : "chart.bar.fill")
        }
        case "assignee": return [.init(id: "", title: "No assignee", icon: "person.crop.circle.dashed")]
            + entities(model.members).map { .init(id: "member:\($0.id)", title: $0.name, icon: "person.crop.circle.fill") }
            + ["codex", "claude", "cursor", "grok", "opencode"].map { .init(id: "agent:\($0)", title: $0 == "opencode" ? "OpenCode" : $0.capitalized, icon: "sparkles", group: "Agents") }
        case "labels": return entities(model.labels).map { .init(id: $0.id, title: $0.name, icon: "circle.fill", color: color($0.color)) }
        case "project": return [.init(id: "", title: "No project", icon: "shippingbox")]
            + appModel.cloud.projects.filter { $0.companyId == companyID && $0.project.archivedAt == nil }.map { .init(id: $0.project.id, title: $0.project.name, icon: "shippingbox") }
        case "milestone": return [.init(id: "", title: "No milestone", icon: "diamond")]
            + entities(model.milestones).filter { ($0.string("cloudProjectId") ?? $0.string("projectId")) == issue?.projectId }.map { .init(id: $0.id, title: $0.name, icon: "diamond") }
        case "cycle": return [.init(id: "", title: "No cycle", icon: "arrow.trianglehead.2.clockwise.rotate.90")]
            + entities(model.cycles).map { .init(id: $0.id, title: $0.name, icon: "arrow.trianglehead.2.clockwise.rotate.90") }
        case "parent":
            let scoped = model.records.filter { $0.companyId == companyID && !$0.isDeleted }
            var excluded: Set<String> = [issueID]
            var count = -1
            while count != excluded.count {
                count = excluded.count
                for row in scoped where row.parentId.map(excluded.contains) == true { excluded.insert(row.id) }
            }
            return [.init(id: "", title: "No parent task", icon: "arrow.turn.up.left")]
                + scoped.filter { !excluded.contains($0.id) }.map { .init(id: $0.id, title: "\($0.key) · \($0.title)", icon: "circle") }
        default: return []
        }
    }

    private func selected(_ key: String, issue: PathwayIssueRecord) -> Set<String> {
        switch key {
        case "status": return [issue.statusId]
        case "priority": return [issue.priority]
        case "labels": return Set(issue.labelIds)
        case "project": return [issue.projectId ?? ""]
        case "milestone": return [issue.milestoneId ?? ""]
        case "cycle": return [issue.cycleId ?? ""]
        case "parent": return [issue.parentId ?? ""]
        case "assignee":
            guard let value = issue.assignee?.objectValue else { return [""] }
            if value["kind"]?.stringValue == "agent" { return ["agent:\(value["provider"]?.stringValue ?? "")"] }
            if value["kind"]?.stringValue == "user" { return ["member:\(appModel.cloud.companies.first { $0.id == companyID }?.membershipId ?? "")"] }
            return ["member:\(value["membershipId"]?.stringValue ?? "")"]
        default: return []
        }
    }

    private func select(_ id: String, property: String, issue: PathwayIssueRecord) {
        var patch: [String: JSONValue]
        switch property {
        case "assignee": patch = ["assignee": id.isEmpty ? .null : PathwayIssueListConfiguration.assigneeJSON(id)]
        case "labels":
            var ids = Set(issue.labelIds)
            if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
            patch = ["labelIds": .array(ids.sorted().map(JSONValue.string))]
        case "priority": patch = ["priority": .string(id)]
        default:
            let key = property == "parent" ? "parentId" : property + "Id"
            patch = [key: id.isEmpty ? .null : .string(id)]
            if property == "project", id != issue.projectId { patch["milestoneId"] = .null }
        }
        update(issue, patch: patch, close: property != "labels")
    }

    private func update(_ issue: PathwayIssueRecord, patch: [String: JSONValue], close: Bool = true) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await model.update(issue, patch: patch)
                if close { closePicker() }
            } catch { errorMessage = error.localizedDescription }
        }
    }
    private func closePicker() { focusedField = nil; property = nil }

    private func dateCard(_ issue: PathwayIssueRecord) -> some View {
        VStack(spacing: 12) {
            PathwayIssuePickerHeader(title: "Due date", close: closePicker)
            DatePicker("Due date", selection: $dueDate, displayedComponents: .date).datePickerStyle(.graphical)
            HStack {
                Button("No due date") { update(issue, patch: ["dueDate": .null]) }
                Spacer()
                Button("Set date") { update(issue, patch: ["dueDate": .string(Self.dateFormatter.string(from: dueDate))]) }
            }
        }.padding(20).frame(maxWidth: 540)
            .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 30)).padding(12)
    }

    @ViewBuilder
    private func relationRow(_ relation: PathwayIssueEntity, issue: PathwayIssueRecord) -> some View {
        let fields = relation.fields["relation"]?.objectValue ?? relation.fields
        let outgoing = fields["issueId"]?.stringValue == issue.id
        let otherID = fields[outgoing ? "relatedIssueId" : "issueId"]?.stringValue
        if let other = model.records.first(where: { $0.companyId == companyID && $0.id == otherID }) {
            let kind = fields["kind"]?.stringValue ?? "relates"
            let heading = kind == "blocks" ? (outgoing ? "Blocks" : "Blocked by") : kind == "duplicate" ? "Duplicate" : "Related"
            VStack(alignment: .leading, spacing: 12) {
                Text(heading).font(.subheadline).foregroundStyle(.secondary)
                Button { dismiss(); onOpenIssue(other.id) } label: { Label(other.title, systemImage: "circle.lefthalf.filled").lineLimit(1) }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Remove relation", role: .destructive) {
                            busy = true
                            Task {
                                defer { busy = false }
                                do { _ = try await model.mutate(companyID: companyID, kind: "issueRelation.delete", entityID: relation.id, args: [:]) }
                                catch { errorMessage = error.localizedDescription }
                            }
                        }
                    }
            }.padding(.horizontal, 20).padding(.vertical, 14)
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.locale = Locale(identifier: "en_US_POSIX"); return formatter
    }()
}
