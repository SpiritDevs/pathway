import SwiftUI
import PhotosUI

/// One draft owns all edits, so Cancel never changes the replicated issue.
struct PathwayIssueEditorView: View {
    let model: PathwayIssuesModel
    let companyID: String
    var issueID: String?
    var parentID: String?
    var defaultStatusID: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    @State private var title = ""
    @State private var description = ""
    @State private var statusID = ""
    @State private var priority = "none"
    @State private var projectID = ""
    @State private var milestoneID = ""
    @State private var cycleID = ""
    @State private var selectedParentID = ""
    @State private var assigneeID = ""
    @State private var labelIDs: Set<String> = []
    @State private var hasDueDate = false
    @State private var dueDate = Date()
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var loaded = false
    @State private var originalFields: [String: JSONValue] = [:]
    @State private var photo: PhotosPickerItem?
    @State private var images: [PathwayIssueImageDraft] = []
    @State private var loadingImage = false
    @State private var createdIssueID: String?
    @State private var imageCommentID = UUID().uuidString.lowercased()

    private var issue: PathwayIssueRecord? {
        model.records.first { $0.companyId == companyID && $0.id == issueID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Issue title", text: $title, axis: .vertical)
                        .accessibilityIdentifier("issue-title-input")
                        .font(.title3.weight(.semibold))
                    TextField("Add a description…", text: $description, axis: .vertical)
                        .lineLimit(5...20)
                }
                Section("Attachments") {
                    ForEach(images) { draft in
                        HStack {
                            Label(draft.name, systemImage: "photo")
                            Spacer()
                            Button("Remove", systemImage: "xmark.circle") { images.removeAll { $0.id == draft.id } }.labelStyle(.iconOnly)
                        }
                    }
                    PhotosPicker(selection: $photo, matching: .images) { Label("Add image", systemImage: "paperclip") }
                        .disabled(loadingImage || saving || images.count >= 8)
                }
                Section("Properties") {
                    Picker("Status", selection: $statusID) {
                        ForEach(entities(model.statuses)) { Text($0.name).tag($0.id) }
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(["none", "urgent", "high", "medium", "low"], id: \.self) {
                            Text($0 == "none" ? "No priority" : $0.capitalized).tag($0)
                        }
                    }
                    Picker("Assignee", selection: $assigneeID) {
                        Text("Unassigned").tag("")
                        Text("Me").tag("user")
                        ForEach(entities(model.members)) { Text($0.name).tag("member:\($0.id)") }
                        ForEach(["codex", "claude", "cursor", "grok", "opencode"], id: \.self) {
                            Text($0.capitalized).tag("agent:\($0)")
                        }
                    }
                    Picker("Project", selection: $projectID) {
                        Text("No project").tag("")
                        ForEach(appModel.cloud.projects.filter { $0.companyId == companyID }) {
                            Text($0.project.name).tag($0.project.id)
                        }
                    }
                    .onChange(of: projectID) { old, new in
                        if old != new && loaded && !entities(model.milestones).contains(where: {
                            $0.id == milestoneID && ($0.fields["cloudProjectId"]?.stringValue ?? $0.fields["projectId"]?.stringValue) == new
                        }) { milestoneID = "" }
                    }
                    Picker("Milestone", selection: $milestoneID) {
                        Text("No milestone").tag("")
                        ForEach(entities(model.milestones).filter { ($0.fields["cloudProjectId"]?.stringValue ?? $0.fields["projectId"]?.stringValue) == projectID }) {
                            Text($0.name).tag($0.id)
                        }
                    }
                    Picker("Cycle", selection: $cycleID) {
                        Text("No cycle").tag("")
                        ForEach(entities(model.cycles)) { Text($0.name).tag($0.id) }
                    }
                    Picker("Parent issue", selection: $selectedParentID) {
                        Text("No parent").tag("")
                        ForEach(parentOptions, id: \.id) {
                            Text("\($0.key) · \($0.title)").tag($0.id)
                        }
                    }
                    Toggle("Due date", isOn: $hasDueDate)
                    if hasDueDate { DatePicker("Due", selection: $dueDate, displayedComponents: .date) }
                }
                if !entities(model.labels).isEmpty {
                    Section("Labels") {
                        ForEach(entities(model.labels)) { label in
                            Toggle(label.name, isOn: Binding(
                                get: { labelIDs.contains(label.id) },
                                set: { if $0 { labelIDs.insert(label.id) } else { labelIDs.remove(label.id) } }
                            ))
                        }
                    }
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle(issueID == nil ? "New issue" : "Edit issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .accessibilityIdentifier("issue-save")
                        .disabled(saving || loadingImage || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || statusID.isEmpty || title.count > 512 || description.count > 100_000)
                }
            }
            .interactiveDismissDisabled(saving)
            .task { loadDraft() }
            .onChange(of: photo) { _, selection in
                guard let selection else { return }
                loadingImage = true
                Task {
                    defer { loadingImage = false; photo = nil }
                    do {
                        guard let data = try await selection.loadTransferable(type: Data.self) else { return }
                        guard data.count <= 10 * 1_024 * 1_024 else {
                            errorMessage = "Choose an image smaller than 10 MB."; return
                        }
                        let type = selection.supportedContentTypes.first
                        images.append(PathwayIssueImageDraft(data: data, mimeType: type?.preferredMIMEType ?? "image/jpeg",
                                                             name: "image.\(type?.preferredFilenameExtension ?? "jpg")"))
                    } catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func entities(_ items: [PathwayIssueEntity]) -> [PathwayIssueEntity] {
        items.filter { $0.companyId == companyID }
    }

    private var parentOptions: [PathwayIssueRecord] {
        let scoped = model.records.filter { $0.companyId == companyID && !$0.isDeleted }
        var excluded = Set([issueID].compactMap { $0 })
        var previous = -1
        while previous != excluded.count {
            previous = excluded.count
            for item in scoped where item.parentId.map(excluded.contains) == true { excluded.insert(item.id) }
        }
        return scoped.filter { !excluded.contains($0.id) }
    }

    private func loadDraft() {
        guard !loaded else { return }
        originalFields = issue?.fields ?? [:]
        title = issue?.title ?? ""
        description = issue?.description ?? ""
        statusID = issue?.statusId ?? defaultStatusID ?? entities(model.statuses).first?.id ?? ""
        priority = issue?.priority ?? "none"
        let parent = model.records.first { $0.companyId == companyID && $0.id == parentID }
        projectID = issue?.projectId ?? parent?.projectId ?? ""
        milestoneID = issue?.milestoneId ?? ""
        cycleID = issue?.cycleId ?? ""
        selectedParentID = issue?.parentId ?? parentID ?? ""
        labelIDs = Set(issue?.labelIds ?? [])
        if let assignee = issue?.assignee?.objectValue {
            let kind = assignee["kind"]?.stringValue ?? ""
            if kind == "agent" { assigneeID = "agent:\(assignee["provider"]?.stringValue ?? "")" }
            else if kind == "member" { assigneeID = "member:\(assignee["membershipId"]?.stringValue ?? "")" }
            else if kind == "user" { assigneeID = "user" }
        }
        if let rawDate = issue?.dueDate, let date = Self.dateFormatter.date(from: rawDate) {
            hasDueDate = true
            dueDate = date
        }
        loaded = true
    }

    private var assignee: JSONValue {
        if assigneeID == "user", let membershipID = appModel.cloud.companies.first(where: { $0.id == companyID })?.membershipId {
            return .object(["kind": .string("member"), "membershipId": .string(membershipID)])
        }
        if assigneeID.hasPrefix("agent:") {
            return .object(["kind": .string("agent"), "provider": .string(String(assigneeID.dropFirst(6)))])
        }
        if assigneeID.hasPrefix("member:") {
            return .object(["kind": .string("member"), "membershipId": .string(String(assigneeID.dropFirst(7)))])
        }
        return .null
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let fields: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(description), "statusId": .string(statusID),
            "priority": .string(priority), "assignee": assignee,
            "projectId": optional(projectID), "milestoneId": optional(milestoneID),
            "cycleId": optional(cycleID), "parentId": optional(selectedParentID),
            "labelIds": .array(labelIDs.sorted().map(JSONValue.string)),
            "dueDate": hasDueDate ? .string(Self.dateFormatter.string(from: dueDate)) : .null,
        ]
        do {
            let savedIssue: PathwayIssueRecord
            if let issue {
                let patch = fields.filter { (originalFields[$0.key] ?? .null) != $0.value }
                if !patch.isEmpty { try await model.update(issue, patch: patch) }
                savedIssue = issue
            } else {
                let id: String
                if let createdIssueID {
                    id = createdIssueID
                    var retryFields = fields
                    retryFields["id"] = .string(id)
                    let saved = PathwayIssueRecord(companyId: companyID, fields: retryFields)
                    try await model.update(saved, patch: fields)
                }
                else {
                    id = try await model.create(companyID: companyID, fields: fields.filter { $0.value != .null })
                    createdIssueID = id
                }
                var savedFields = fields
                savedFields["id"] = .string(id)
                savedIssue = PathwayIssueRecord(companyId: companyID, fields: savedFields)
            }
            if !images.isEmpty {
                var uploadedIDs: [String] = []
                for image in images {
                    if let uploadedID = image.uploadedID { uploadedIDs.append(uploadedID); continue }
                    let id = try await model.uploadAttachment(savedIssue, data: image.data, mimeType: image.mimeType, fileName: image.name)
                    if let index = images.firstIndex(where: { $0.id == image.id }) { images[index].uploadedID = id }
                    uploadedIDs.append(id)
                }
                _ = try await model.mutate(companyID: companyID, kind: "issueComment.create", entityID: imageCommentID,
                                           args: ["issueId": .string(savedIssue.id),
                                                  "body": .string(images.count == 1 ? "Added an image to this issue." : "Added \(images.count) images to this issue."),
                                                  "attachmentIds": .array(uploadedIDs.map(JSONValue.string))])
            }
            dismiss()
        } catch {
            errorMessage = createdIssueID == nil ? error.localizedDescription : "The issue was created, but its attachments could not be saved. Retry Save to finish: \(error.localizedDescription)"
        }
    }

    private func optional(_ value: String) -> JSONValue { value.isEmpty ? .null : .string(value) }
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}


private struct PathwayIssueImageDraft: Identifiable {
    let id = UUID()
    let data: Data
    let mimeType: String
    let name: String
    var uploadedID: String?
}
