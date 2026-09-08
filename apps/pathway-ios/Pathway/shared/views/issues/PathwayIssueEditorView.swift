import SwiftUI
import PhotosUI

enum PathwayIssueEditorFocus: Hashable { case title, description, search }

/// One draft owns all edits, so Cancel never changes the replicated issue.
struct PathwayIssueEditorView: View {
    let model: PathwayIssuesModel
    let companyID: String
    var issueID: String?
    var parentID: String?
    var defaultStatusID: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var compositionClock = PathwayIssueCompositionClock()
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
    @State private var activePicker: Property?
    @State private var descriptionSelection: TextSelection?
    @State private var focusBeforePicker: PathwayIssueEditorFocus?
    @FocusState private var focusedField: PathwayIssueEditorFocus?
    private enum Property: String, CaseIterable {
        case assignee, priority, labels, project, status, milestone, cycle, parent, dueDate
        var title: String {
            switch self {
            case .dueDate: "Due date"
            case .parent: "Parent issue"
            default: rawValue.capitalized
            }
        }
        var searchable: Bool { self != .priority && self != .dueDate }
    }

    private var issue: PathwayIssueRecord? {
        model.records.first { $0.companyId == companyID && $0.id == issueID }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                composer
                    .disabled(saving || loadingImage)
                    .allowsHitTesting(activePicker == nil)
                    .accessibilityHidden(activePicker != nil)
                if let property = activePicker {
                    Color(uiColor: .systemBackground).opacity(0.96).ignoresSafeArea()
                    picker(property)
                }
            }
            .background(Color(uiColor: .systemBackground))
            .toolbarVisibility(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if activePicker == nil { composerAccessories.disabled(saving) }
            }
            .interactiveDismissDisabled(saving)
            .task {
                loadDraft()
                if issueID == nil { focusedField = .title }
            }
            .onChange(of: title) { _, _ in recordCompositionActivity() }
            .onChange(of: description) { _, _ in recordCompositionActivity() }
            .onChange(of: focusedField) { _, next in
                if next != nil { recordCompositionActivity() }
                else { compositionClock.pause(at: compositionNow) }
            }
            .onChange(of: activePicker) { _, _ in recordCompositionActivity() }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { compositionClock.pause(at: compositionNow) }
            }
            .onDisappear { compositionClock.pause(at: compositionNow) }
            .onChange(of: projectID) { old, new in
                if old != new && loaded && !entities(model.milestones).contains(where: {
                    $0.id == milestoneID && ($0.fields["cloudProjectId"]?.stringValue ?? $0.fields["projectId"]?.stringValue) == new
                }) { milestoneID = "" }
            }
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

    private var composer: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel", systemImage: "xmark") { dismiss() }
                    .labelStyle(.iconOnly).font(.title3.weight(.medium))
                    .frame(width: 42, height: 42).background(Color(uiColor: .secondarySystemBackground), in: Circle())
                    .disabled(saving)
                Spacer()
                HStack(spacing: 8) {
                    Image(systemName: "square.stack.3d.up.fill").foregroundStyle(.teal)
                    Text(appModel.cloud.companies.first { $0.id == companyID }?.name ?? "Pathway")
                        .font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                .padding(.horizontal, 13).padding(.vertical, 11)
                .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                Spacer()
                Button { Task { await save() } } label: {
                    if saving { ProgressView() }
                    else { Image(systemName: "arrow.up").font(.title3.weight(.semibold)) }
                }
                .frame(width: 42, height: 42)
                .background(Color(uiColor: .secondarySystemBackground), in: Circle())
                .accessibilityLabel("Save")
                .accessibilityIdentifier("issue-save")
                .disabled(!canSave)
            }
            .buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Issue title", text: $title, axis: .vertical)
                        .font(.title2.weight(.semibold)).focused($focusedField, equals: .title)
                        .accessibilityIdentifier("issue-title-input")
                    ZStack(alignment: .topLeading) {
                        if description.isEmpty {
                            Text("Description…").foregroundStyle(.tertiary).padding(.top, 8)
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                        TextEditor(text: $description, selection: $descriptionSelection)
                            .scrollContentBackground(.hidden)
                            .padding(.horizontal, -5)
                            .frame(minHeight: 230)
                            .focused($focusedField, equals: .description)
                            .accessibilityLabel("Description")
                            .accessibilityIdentifier("issue-description-input")
                    }.font(.body)
                    if !images.isEmpty {
                        ForEach(images) { draft in
                            HStack {
                                Label(draft.name, systemImage: "photo")
                                Spacer()
                                Button("Remove image", systemImage: "xmark.circle") { images.removeAll { $0.id == draft.id } }
                                    .labelStyle(.iconOnly)
                            }.font(.subheadline).padding(.vertical, 5)
                        }
                    }
                    if let errorMessage { Text(errorMessage).font(.subheadline).foregroundStyle(.red) }
                }.padding(.horizontal, 20).padding(.bottom, 20)
            }
            #if !os(visionOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
        }
    }

    private var canSave: Bool {
        !saving && !loadingImage && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !statusID.isEmpty && title.count <= 512 && description.count <= 100_000
    }

    private var compositionNow: Double { (Date.now.timeIntervalSince1970 * 1_000).rounded(.down) }

    private func recordCompositionActivity() {
        guard issueID == nil, createdIssueID == nil, loaded, !saving, scenePhase == .active else { return }
        compositionClock.activity(at: compositionNow)
    }

    private var composerAccessories: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(Property.allCases, id: \.self) { property in
                        Button { openPicker(property) } label: {
                            Label(propertyLabel(property), systemImage: propertyIcon(property))
                                .lineLimit(1).font(.subheadline).padding(.horizontal, 13).padding(.vertical, 10)
                                .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("issue-property-\(property.rawValue)")
                    }
                }.padding(.horizontal, 12)
            }
            .scrollIndicators(.hidden).accessibilityIdentifier("issue-property-chips")
            HStack(spacing: 0) {
                Menu {
                    Button("Bold") { insertMarkdown(prefix: "**", suffix: "**", placeholder: "bold text") }
                    Button("Italic") { insertMarkdown(prefix: "_", suffix: "_", placeholder: "italic text") }
                    Button("Heading") { insertMarkdown(prefix: "## ", placeholder: "Heading", block: true) }
                    Button("Link") { insertMarkdown(prefix: "[", suffix: "](https://)", placeholder: "link text") }
                } label: { Image(systemName: "textformat").frame(maxWidth: .infinity, minHeight: 44) }
                .accessibilityLabel("Text formatting")
                PhotosPicker(selection: $photo, matching: .images) {
                    Image(systemName: "photo").frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityLabel("Add image")
                .disabled(loadingImage || saving || images.count >= 8)
                formatButton("Insert bullet list", icon: "list.bullet") { insertMarkdown(prefix: "- ", placeholder: "List item", block: true) }
                formatButton("Insert checklist", icon: "checklist") { insertMarkdown(prefix: "- [ ] ", placeholder: "Task", block: true) }
                formatButton("Insert code block", icon: "chevron.left.forwardslash.chevron.right") { insertMarkdown(prefix: "```\n", suffix: "\n```", placeholder: "code", block: true) }
                formatButton("Insert quote", icon: "quote.opening") { insertMarkdown(prefix: "> ", placeholder: "Quote", block: true) }
                if focusedField != nil {
                    formatButton("Dismiss keyboard", icon: "keyboard.chevron.compact.down") { focusedField = nil }
                }
            }
            .font(.title3).buttonStyle(.plain)
            .padding(.horizontal, 10).padding(.vertical, 2)
            .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
            .padding(.horizontal, 12)
        }
        .padding(.top, 8).padding(.bottom, 10)
        .background(Color(uiColor: .systemBackground))
    }

    private func formatButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).frame(maxWidth: .infinity, minHeight: 44) }
            .accessibilityLabel(title)
    }

    @ViewBuilder
    private func picker(_ property: Property) -> some View {
        if property == .dueDate {
            VStack(spacing: 18) {
                PathwayIssuePickerHeader(title: "Due date", close: closePicker)
                DatePicker("Due date", selection: $dueDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                HStack {
                    Button("No due date") { hasDueDate = false; closePicker() }
                    Spacer()
                    Button("Set date") { hasDueDate = true; closePicker() }.fontWeight(.semibold)
                }
            }
            .padding(20).frame(maxWidth: 540)
            .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 30))
            .shadow(color: .black.opacity(0.09), radius: 24, y: 10)
            .padding(.horizontal, 12).padding(.vertical, 20)
        } else {
            PathwayIssueEditorPicker(title: property.title, searchPrompt: property.searchable ? searchPrompt(property) : nil,
                                     options: pickerOptions(property), selectedIDs: selectedValues(property), multiple: property == .labels,
                                     close: closePicker, select: { select($0, for: property) }, focusedField: $focusedField)
                .id(property)
        }
    }

    private func openPicker(_ property: Property) {
        focusBeforePicker = focusedField
        activePicker = property
        if !property.searchable { focusedField = nil }
    }
    private func closePicker() { activePicker = nil; focusedField = focusBeforePicker }

    private func searchPrompt(_ property: Property) -> String {
        switch property {
        case .assignee: "Assign to…"
        case .labels: "Add labels…"
        default: "Search \(property.title.lowercased())…"
        }
    }

    private func selectedValues(_ property: Property) -> Set<String> {
        switch property {
        case .assignee: [assigneeID]
        case .priority: [priority]
        case .labels: labelIDs
        case .status: [statusID]
        case .project: [projectID]
        case .milestone: [milestoneID]
        case .cycle: [cycleID]
        case .parent: [selectedParentID]
        case .dueDate: []
        }
    }

    private func pickerOptions(_ property: Property) -> [PathwayIssuePickerOption] {
        switch property {
        case .assignee:
            return [.init(id: "", title: "No assignee", icon: "person.crop.circle.dashed"), .init(id: "user", title: "Me", icon: "person.crop.circle")]
                + entities(model.members).map { .init(id: "member:\($0.id)", title: $0.name, icon: "person.crop.circle.fill") }
                + ["codex", "claude", "cursor", "grok", "opencode"].map { .init(id: "agent:\($0)", title: $0 == "opencode" ? "OpenCode" : $0.capitalized, icon: "sparkles", group: "Agents") }
        case .priority:
            return ["none", "urgent", "high", "medium", "low"].map {
                .init(id: $0, title: $0 == "none" ? "No priority" : $0.capitalized,
                      icon: $0 == "none" ? "ellipsis" : $0 == "urgent" ? "exclamationmark.square.fill" : "chart.bar.fill")
            }
        case .labels: return entities(model.labels).map { .init(id: $0.id, title: $0.name, icon: "circle.fill", color: pickerColor($0.color)) }
        case .status: return entities(model.statuses).map { .init(id: $0.id, title: $0.name, icon: "circle.lefthalf.filled", color: pickerColor($0.color)) }
        case .project:
            return [.init(id: "", title: "No project", icon: "shippingbox")]
                + appModel.cloud.projects.filter { $0.companyId == companyID }.map { .init(id: $0.project.id, title: $0.project.name, icon: "shippingbox") }
        case .milestone:
            return [.init(id: "", title: "No milestone", icon: "flag")]
                + entities(model.milestones).filter { ($0.fields["cloudProjectId"]?.stringValue ?? $0.fields["projectId"]?.stringValue) == projectID }
                    .map { .init(id: $0.id, title: $0.name, icon: "flag") }
        case .cycle: return [.init(id: "", title: "No cycle", icon: "arrow.trianglehead.2.clockwise.rotate.90")]
                + entities(model.cycles).map { .init(id: $0.id, title: $0.name, icon: "arrow.trianglehead.2.clockwise.rotate.90") }
        case .parent: return [.init(id: "", title: "No parent", icon: "arrow.turn.up.left")]
                + parentOptions.map { .init(id: $0.id, title: "\($0.key) · \($0.title)", icon: "arrow.turn.up.left") }
        case .dueDate: return []
        }
    }

    private func select(_ id: String, for property: Property) {
        switch property {
        case .assignee: assigneeID = id
        case .priority: priority = id
        case .labels:
            if labelIDs.contains(id) { labelIDs.remove(id) } else { labelIDs.insert(id) }
            return
        case .status: statusID = id
        case .project: projectID = id
        case .milestone: milestoneID = id
        case .cycle: cycleID = id
        case .parent: selectedParentID = id
        case .dueDate: break
        }
        closePicker()
    }

    private func propertyLabel(_ property: Property) -> String {
        if property == .labels { return labelIDs.isEmpty ? "Labels" : "Labels · \(labelIDs.count)" }
        if property == .dueDate { return hasDueDate ? Self.dateFormatter.string(from: dueDate) : "Due date" }
        let selected = selectedValues(property).first ?? ""
        if selected.isEmpty || (property == .priority && selected == "none") { return property.title }
        return pickerOptions(property).first { $0.id == selected }?.title ?? property.title
    }

    private func propertyIcon(_ property: Property) -> String {
        switch property {
        case .assignee: "person.crop.circle"
        case .priority: priority == "none" ? "ellipsis" : "chart.bar.fill"
        case .labels: "tag"
        case .project: "shippingbox"
        case .status: "circle.lefthalf.filled"
        case .milestone: "flag"
        case .cycle: "arrow.trianglehead.2.clockwise.rotate.90"
        case .parent: "arrow.turn.up.left"
        case .dueDate: "calendar"
        }
    }

    private func pickerColor(_ hex: String) -> Color {
        guard let rgb = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else { return .secondary }
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }

    private func insertMarkdown(prefix: String, suffix: String = "", placeholder: String, block: Bool = false) {
        let range: Range<String.Index>
        if let selection = descriptionSelection, case let .selection(selectedRange) = selection.indices { range = selectedRange }
        else { range = description.endIndex..<description.endIndex }
        let start = description.distance(from: description.startIndex, to: range.lowerBound)
        let selectedText = String(description[range])
        let content = selectedText.isEmpty ? placeholder : selectedText
        let separator = block && range.lowerBound != description.startIndex && description[description.index(before: range.lowerBound)] != "\n" ? "\n" : ""
        let replacement = separator + prefix + content + suffix
        description.replaceSubrange(range, with: replacement)
        let lower = description.index(description.startIndex, offsetBy: start + separator.count + prefix.count)
        let upper = description.index(lower, offsetBy: content.count)
        descriptionSelection = TextSelection(range: lower..<upper)
        focusedField = .description
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
        compositionClock.pause(at: compositionNow)
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
                    var createFields = fields.filter { $0.value != .null }
                    createFields["timeTracking"] = .object([
                        "intervals": .array(compositionClock.snapshot(at: compositionNow).map {
                            .object(["start": .number($0.start), "end": .number($0.end)])
                        }),
                    ])
                    id = try await model.create(companyID: companyID, fields: createFields)
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
