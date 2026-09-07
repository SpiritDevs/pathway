import SwiftUI
import PhotosUI
import UIKit

struct PathwayIssueDetailView: View {
    let model: PathwayIssuesModel
    let companyID: String
    let issueID: String

    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    @State private var selectedTab = "Details"
    @State private var openedIssueID: String?
    @State private var editor = false
    @State private var showProperties = false
    @State private var commentExpanded = false
    @FocusState private var commentFocused: Bool
    @State private var creatingChild = false
    @State private var showRelationPicker = false
    @State private var showWork = false
    @State private var showMention = false
    @State private var confirmDelete = false
    @State private var errorMessage: String?
    @State private var busy = false
    @State private var todoText = ""
    @State private var editingTodo: PathwayIssueEntity?
    @State private var editedTodoText = ""
    @State private var commentText = ""
    @State private var editingCommentID: String?
    @State private var attachmentIDs: [String] = []
    @State private var photo: PhotosPickerItem?
    @State private var attachmentURLs: [String: URL] = [:]

    private var canNavigate: Bool { !busy }
    private var issue: PathwayIssueRecord? {
        model.records.first { $0.companyId == companyID && $0.id == issueID }
    }

    var body: some View { content }

    private var content: some View {
            Group {
                if let issue {
                    issueContent(issue)
                } else {
                    ContentUnavailableView("Issue unavailable", systemImage: "doc.text.magnifyingglass",
                                           description: Text("This issue may have been removed or moved to another workspace."))
                }
            }
            .navigationTitle(issue?.key ?? "Issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .preference(key: IssueDetailNavigationActiveKey.self, value: true)
            .toolbar {
                ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Edit title and description", systemImage: "square.and.pencil") { editor = true }
                        .accessibilityIdentifier("issue-detail-edit")
                        .disabled(busy)
                    Menu {
                        Button("Edit issue", systemImage: "pencil") { editor = true }
                        Button("Add sub-issue", systemImage: "plus.square.on.square") { creatingChild = true }
                        Button("Add relation", systemImage: "link") { showRelationPicker = true }
                        Button("Agent work & investigation", systemImage: "sparkles") { showWork = true }
                        if let issue {
                            Button("Copy issue key", systemImage: "doc.on.doc") { UIPasteboard.general.string = issue.key }
                                .accessibilityIdentifier("issue-copy-key")
                            if let url = issueURL(issue) {
                                Button("Copy issue link", systemImage: "link") { UIPasteboard.general.url = url }
                                    .accessibilityIdentifier("issue-copy-link")
                                ShareLink("Share issue link", item: url)
                            }
                            ShareLink(item: "\(issue.key): \(issue.title)\n\(issue.description)") {
                                Label("Share issue", systemImage: "square.and.arrow.up")
                            }
                            if issue.isDeleted {
                                Button("Restore issue", systemImage: "arrow.uturn.backward") {
                                    perform { try await model.restore(issue) }
                                }
                            } else {
                                Button("Delete issue", systemImage: "trash", role: .destructive) { confirmDelete = true }
                            }
                        }
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("Issue actions")
                    .accessibilityIdentifier("issue-detail-actions")
                    .disabled(busy)
                }
            }
            .sheet(isPresented: $editor) {
                PathwayIssueEditorView(model: model, companyID: companyID, issueID: issueID)
            }
            .sheet(isPresented: $showProperties) {
                PathwayIssuePropertiesView(model: model, companyID: companyID, issueID: issueID, onOpenIssue: { id in
                    showProperties = false
                    openedIssueID = id
                })
                .presentationBackground(.clear)
                .presentationDetents([.large])
            }
            .sheet(isPresented: $creatingChild) {
                PathwayIssueEditorView(model: model, companyID: companyID, parentID: issueID)
            }
            .sheet(isPresented: $showRelationPicker) {
                if let issue { PathwayIssueRelationPicker(model: model, issue: issue) }
            }
            .navigationDestination(item: $openedIssueID) { id in
                PathwayIssueDetailView(model: model, companyID: companyID, issueID: id)
            }
            .navigationDestination(isPresented: $showWork) {
                if let issue { PathwayIssueWorkView(model: model, issue: issue, embedded: true) }
            }
            .sheet(isPresented: $showMention) {
                if let issue {
                    PathwayIssueWorkView(model: model, issue: issue, commentBody: commentText,
                                         commentAttachmentIDs: attachmentIDs, onCommentSent: clearComment)
                }
            }
            .confirmationDialog("Delete this issue?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete issue", role: .destructive) {
                    if let issue { perform { try await model.remove(issue); dismiss() } }
                }
            } message: { Text("Deleted issues can be restored from the issue menu.") }
            .alert("Couldn’t save change", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK") { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .alert("Edit task", isPresented: Binding(get: { editingTodo != nil }, set: { if !$0 { editingTodo = nil } })) {
                TextField("Task", text: $editedTodoText)
                Button("Save") {
                    if let todo = editingTodo, let issue {
                        mutate(issue, kind: "issueTodo.update", id: todo.id, args: ["text": .string(editedTodoText.trimmingCharacters(in: .whitespacesAndNewlines))])
                    }
                    editingTodo = nil
                }.disabled(editedTodoText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel", role: .cancel) { editingTodo = nil }
            }
            .onChange(of: appModel.pendingThreadRoute) { _, route in
                if route?.companyId == companyID { dismiss() }
            }
            .onChange(of: photo) { _, selected in
                guard let selected, let issue else { return }
                guard attachmentIDs.count < 8 else { errorMessage = "A comment can have up to eight attachments."; photo = nil; return }
                perform {
                    guard let data = try await selected.loadTransferable(type: Data.self) else { return }
                    let type = selected.supportedContentTypes.first
                    let id = try await model.uploadAttachment(issue, data: data, mimeType: type?.preferredMIMEType ?? "image/jpeg",
                                                              fileName: "image.\(type?.preferredFilenameExtension ?? "jpg")")
                    attachmentIDs.append(id)
                    photo = nil
                }
            }
    }

    private func issueContent(_ issue: PathwayIssueRecord) -> some View {
        let detail = model.detail(for: issue)
        return Group {
            if selectedTab == "Details" {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        readingHeader(issue)
                        detailSections(issue, detail: detail)
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 28)
                }
                #if !os(visionOS)
                .scrollDismissesKeyboard(.interactively)
                #endif
                .accessibilityIdentifier("issue-detail-content")
            } else {
                List {
                    Section {
                        Text(issue.title).font(.title3.weight(.semibold))
                    } header: { Text(selectedTab) }
                    switch selectedTab {
                    case "Comments": commentSections(issue, detail: detail)
                    case "Attachments": attachmentSections(issue, detail: detail)
                    case "Sub-issues": subIssueSections(issue)
                    case "AI": aiSections(issue, detail: detail)
                    default: activitySections(detail)
                    }
                }
                .listStyle(.plain)
                .accessibilityIdentifier("issue-detail-content")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { commentDock(issue) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("issue-detail-screen")
        .task(id: issue.identity) { await model.observe(issue) }
        .disabled(busy)
        .overlay(alignment: .topTrailing) { if busy { ProgressView().padding() } }
        .task(id: attachmentFingerprint(detail)) {
            for attachment in detail.attachments where attachmentURLs[attachment.id] == nil {
                attachmentURLs[attachment.id] = try? await model.attachmentURL(issue, attachmentID: attachment.id)
            }
            for comment in detail.comments {
                for id in comment.fields["attachmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] where attachmentURLs[id] == nil {
                    attachmentURLs[id] = try? await model.attachmentURL(issue, attachmentID: id)
                }
            }
        }
    }

    private var sectionMenu: some View {
        Menu {
            ForEach(["Details", "Comments", "Attachments", "Sub-issues", "AI", "Activity"], id: \.self) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    Label(tab, systemImage: selectedTab == tab ? "checkmark" : sectionIcon(tab))
                }
                .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                .accessibilityIdentifier("issue-tab-\(tab)")
            }
        } label: {
            Image(systemName: sectionIcon(selectedTab)).font(.title3)
                .frame(width: 48, height: 48)
                .background(.regularMaterial, in: Circle())
        }
        .accessibilityLabel("Issue sections, \(selectedTab)")
        .accessibilityIdentifier("issue-tabs")
    }

    private func sectionIcon(_ tab: String) -> String {
        switch tab {
        case "Comments": "bubble.left.and.bubble.right"
        case "Attachments": "paperclip"
        case "Sub-issues": "square.stack.3d.up"
        case "AI": "sparkles"
        case "Activity": "clock.arrow.circlepath"
        default: "square.grid.2x2"
        }
    }

    private func readingHeader(_ issue: PathwayIssueRecord) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(issue.key).font(.subheadline).foregroundStyle(.secondary)
            Text(issue.title).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let parent = model.records.first(where: { $0.companyId == companyID && $0.id == issue.parentId }) {
                Button { openIssue(parent.id) } label: {
                    HStack(spacing: 7) {
                        Text("Sub-issue of").foregroundStyle(.primary)
                        Image(systemName: "circle").foregroundStyle(.secondary)
                        Text(parent.title).foregroundStyle(.secondary).lineLimit(1)
                    }.font(.subheadline)
                }.buttonStyle(.plain).disabled(!canNavigate)
            }
            compactProperties(issue)
            if issue.triage {
                HStack {
                    Label("Needs triage", systemImage: "tray")
                    Spacer()
                    Button("Accept") { perform { try await model.update(issue, patch: ["triage": .bool(false)]) } }
                    Button("Reject", role: .destructive) { confirmDelete = true }
                }.font(.subheadline)
            }
        }
    }

    @ViewBuilder
    private func commentDock(_ issue: PathwayIssueRecord) -> some View {
        Group {
            if commentExpanded {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        TextField(editingCommentID == nil ? "Comment" : "Edit comment", text: $commentText, axis: .vertical)
                            .lineLimit(2...7).focused($commentFocused)
                            .accessibilityIdentifier("issue-comment-input")
                        Button("Collapse comment", systemImage: "chevron.down") {
                            commentFocused = false
                            commentExpanded = false
                        }.labelStyle(.iconOnly).foregroundStyle(.secondary)
                            .accessibilityIdentifier("issue-comment-collapse")
                    }
                    if !attachmentIDs.isEmpty {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(attachmentIDs, id: \.self) { id in
                                    HStack(spacing: 6) {
                                        Image(systemName: "photo")
                                        Text("Image").font(.caption)
                                        Button("Remove attachment", systemImage: "xmark.circle.fill") { attachmentIDs.removeAll { $0 == id } }
                                            .labelStyle(.iconOnly)
                                    }.padding(8).background(.quaternary, in: Capsule())
                                }
                            }
                        }.scrollIndicators(.hidden)
                    }
                    HStack(spacing: 20) {
                        PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo") }
                            .accessibilityLabel("Attach image").disabled(attachmentIDs.count >= 8)
                        if editingCommentID == nil {
                            Button("Ask agent", systemImage: "at") { commentFocused = false; showMention = true }
                                .labelStyle(.iconOnly)
                                .disabled(commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        } else {
                            Button("Cancel edit") { clearComment() }.font(.subheadline)
                        }
                        Spacer()
                        Button { saveComment(issue) } label: {
                            Image(systemName: "arrow.up").font(.body.weight(.semibold))
                                .frame(width: 32, height: 32)
                                .background(.quaternary, in: Circle())
                        }
                        .accessibilityLabel(editingCommentID == nil ? "Send comment" : "Save comment")
                        .accessibilityIdentifier("issue-comment-send")
                        .disabled(commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }.font(.title3)
                }
                .padding(16)
                .background(.regularMaterial, in: .rect(cornerRadius: 26))
                .task { commentFocused = true }
            } else {
                HStack(spacing: 10) {
                    sectionMenu
                    Button {
                        commentExpanded = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "plus").foregroundStyle(.primary)
                            Text(commentText.isEmpty ? "Comment" : commentText)
                                .foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 0)
                            if !attachmentIDs.isEmpty { Image(systemName: "paperclip").foregroundStyle(.secondary) }
                        }
                        .padding(.horizontal, 16).frame(height: 48)
                        .background(.regularMaterial, in: Capsule())
                    }
                    .accessibilityLabel(commentText.isEmpty ? "Write a comment" : "Continue comment draft")
                    .accessibilityIdentifier("issue-comment-open")
                    Button("Agent work & investigation", systemImage: "sparkles") { showWork = true }
                        .labelStyle(.iconOnly).font(.title3)
                        .frame(width: 48, height: 48)
                        .background(.regularMaterial, in: Circle())
                        .accessibilityIdentifier("issue-ai-dock")
                }
            }
        }
        .buttonStyle(.plain)
        .shadow(color: .black.opacity(0.07), radius: 14, y: 5)
        .frame(maxWidth: 760)
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
    }

    @ViewBuilder
    private func activitySections(_ detail: PathwayIssueDetail) -> some View {
        Section {
            if detail.events.isEmpty { Text("No activity yet").foregroundStyle(.secondary) }
            ForEach(detail.events) { event in
                VStack(alignment: .leading, spacing: 5) {
                    Text(activityTitle(event)).font(.subheadline)
                    Text(event.createdAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func compactProperties(_ issue: PathwayIssueRecord) -> some View {
        let status = model.statuses.first { $0.companyId == companyID && $0.id == issue.statusId }
        let project = appModel.cloud.projects.first { $0.companyId == companyID && $0.project.id == issue.projectId }
        let milestone = model.milestones.first { $0.companyId == companyID && $0.id == issue.milestoneId }
        let cycle = model.cycles.first { $0.companyId == companyID && $0.id == issue.cycleId }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        Button { showProperties = true } label: {
                            HStack(spacing: 5) {
                                PathwayIssueStatusGlyph(category: status?.category ?? "unstarted", hexColor: status?.color)
                                Text(status?.name ?? "Status")
                            }.padding(.horizontal, 8).padding(.vertical, 5).background(Color(uiColor: .tertiarySystemFill).opacity(0.5), in: Capsule())
                        }
                        propertyChip(issue.priority == "none" ? "No priority" : issue.priority.capitalized, icon: "chart.bar.fill", iconOnly: true)
                        propertyChip(issue.assignee == nil ? "Unassigned" : actorName(issue.assignee), icon: issue.assignee?.objectValue?["kind"]?.stringValue == "agent" ? "sparkles" : "person.crop.circle", iconOnly: true)
                        propertyChip(issue.labelIds.isEmpty ? "Labels" : "\(issue.labelIds.count) \(issue.labelIds.count == 1 ? "label" : "labels")", icon: "circle.hexagongrid.fill")
                    }
                }.scrollIndicators(.hidden)
                Button("Properties", systemImage: "plus") { showProperties = true }
                    .labelStyle(.iconOnly).frame(width: 30, height: 30)
                    .background(.quaternary, in: Circle())
                    .accessibilityIdentifier("issue-properties")
            }
            HStack(spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        propertyChip(project?.project.name ?? "Project", icon: "shippingbox", maxWidth: 88)
                        if let milestone { propertyChip(milestone.name, icon: "diamond", maxWidth: 88) }
                        if let cycle { propertyChip(cycle.name, icon: "arrow.trianglehead.2.clockwise.rotate.90", maxWidth: 88) }
                    }
                }.scrollIndicators(.hidden)
                propertyChip(dueDateLabel(issue.dueDate), icon: "calendar").fixedSize()
            }
        }
        .font(.subheadline).buttonStyle(.plain).foregroundStyle(.primary)
        .padding(10).background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 22))
    }

    private func dueDateLabel(_ value: String?) -> String {
        guard let value else { return "Due date" }
        let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return value }
        return date.formatted(date: .numeric, time: .omitted)
    }

    private func propertyChip(_ title: String, icon: String, iconOnly: Bool = false, maxWidth: CGFloat? = nil) -> some View {
        Button { showProperties = true } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).foregroundStyle(.secondary)
                if !iconOnly { Text(title).lineLimit(1) }
            }.frame(maxWidth: maxWidth).padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color(uiColor: .tertiarySystemFill).opacity(0.5), in: Capsule())
        }.accessibilityLabel(title)
    }

    @ViewBuilder
    private func detailSections(_ issue: PathwayIssueRecord, detail: PathwayIssueDetail) -> some View {
        if issue.description.isEmpty {
            Button("Add description…") { editor = true }.foregroundStyle(.secondary)
        } else {
            PathwayIssueMarkdownView(markdown: issue.description) { line in
                toggleDescriptionTask(issue, line: line)
            }
        }
        VStack(alignment: .leading, spacing: 14) {
            Text("Checklist").font(.headline)

            ForEach(detail.todos) { todo in
                HStack {
                    Button {
                        mutate(issue, kind: "issueTodo.update", id: todo.id,
                               args: ["done": .bool(!(todo.fields["done"]?.boolValue ?? false))])
                    } label: {
                        Image(systemName: todo.fields["done"]?.boolValue == true ? "checkmark.circle.fill" : "circle")
                    }.accessibilityLabel(todo.fields["done"]?.boolValue == true ? "Mark incomplete" : "Complete task")
                    Text(todo.fields["text"]?.stringValue ?? "")
                        .strikethrough(todo.fields["done"]?.boolValue == true)
                    Spacer()
                    Menu {
                        Button("Edit", systemImage: "pencil") { editingTodo = todo; editedTodoText = todo.fields["text"]?.stringValue ?? "" }
                        Button("Delete", systemImage: "trash", role: .destructive) { mutate(issue, kind: "issueTodo.delete", id: todo.id) }
                        Button("Move up", systemImage: "arrow.up") { moveTodo(issue, todo: todo, offset: -1) }
                            .disabled(detail.todos.first?.id == todo.id)
                        Button("Move down", systemImage: "arrow.down") { moveTodo(issue, todo: todo, offset: 1) }
                            .disabled(detail.todos.last?.id == todo.id)
                    } label: { Image(systemName: "ellipsis").padding(8) }.accessibilityLabel("Reorder task")
                }
                .swipeActions { Button("Delete", role: .destructive) { mutate(issue, kind: "issueTodo.delete", id: todo.id) } }
                .swipeActions(edge: .leading) {
                    Button("Edit") { editingTodo = todo; editedTodoText = todo.fields["text"]?.stringValue ?? "" }
                }
            }
            HStack {
                TextField("Add a task…", text: $todoText).onSubmit { addTodo(issue) }
                if !todoText.isEmpty { Button("Add", systemImage: "plus") { addTodo(issue) }.labelStyle(.iconOnly) }
            }
        }
        if !detail.relations.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Text("Relations").font(.headline)
                ForEach(detail.relations) { relation in relationRow(issue, relation: relation) }
            }
        }
        if issue.fields["pullRequest"]?.objectValue != nil || issue.fields["slackSource"]?.objectValue != nil {
        VStack(alignment: .leading, spacing: 14) {
            Text("Links").font(.headline)
            if let pr = issue.fields["pullRequest"]?.objectValue, let rawURL = pr["url"]?.stringValue, let url = URL(string: rawURL) {
                Link(destination: url) { Label(pr["title"]?.stringValue ?? "Open pull request", systemImage: "arrow.triangle.pull") }
            }
            if let source = issue.fields["slackSource"]?.objectValue {
                if let rawURL = source["permalink"]?.stringValue, let url = URL(string: rawURL) {
                    Link(destination: url) { slackSourceLabel(source) }
                } else {
                    slackSourceLabel(source).foregroundStyle(.secondary)
                }
            }
        }
        }
    }

    @ViewBuilder
    private func attachmentSections(_ issue: PathwayIssueRecord, detail: PathwayIssueDetail) -> some View {
        Section {
            ForEach(detail.attachments) { attachment in
                attachmentRow(issue, attachment: attachment, detail: detail)
            }
            if detail.attachments.isEmpty { Text("No attachments yet").foregroundStyle(.secondary) }
            Button("Add attachments", systemImage: "paperclip") { editor = true }
        }
    }

    @ViewBuilder
    private func subIssueSections(_ issue: PathwayIssueRecord) -> some View {
        Section {
            ForEach(model.records.filter { $0.companyId == companyID && $0.parentId == issue.id && !$0.isDeleted }, id: \.id) { child in
                Button { openIssue(child.id) } label: {
                    Label(child.title, systemImage: "circle").lineLimit(1).foregroundStyle(.primary)
                }.disabled(!canNavigate)
            }
            Button("Add sub-issue", systemImage: "plus") { creatingChild = true }
        } header: { Text("Sub-issues") }
    }

    @ViewBuilder
    private func aiSections(_ issue: PathwayIssueRecord, detail: PathwayIssueDetail) -> some View {
        let runs = model.enrichmentRuns(for: issue)
        Section("AI review") {
            Button("Agent work & investigation", systemImage: "slider.horizontal.3") { showWork = true }
                .accessibilityIdentifier("issue-ai-controls")
            if runs.isEmpty {
                Text("Investigate this issue or choose an agent to start work.").foregroundStyle(.secondary)
            }
            ForEach(runs) { run in
                VStack(alignment: .leading, spacing: 8) {
                    Text((run.fields["state"]?.stringValue ?? "Investigation").capitalized).font(.subheadline.weight(.semibold))
                    if let result = run.fields["result"]?.objectValue, let summary = result["summary"]?.stringValue {
                        Text(.init(summary)).font(.subheadline).textSelection(.enabled)
                    }
                    if let error = run.fields["error"]?.stringValue { Text(error).font(.caption).foregroundStyle(.red) }
                }
            }
        }
        if !detail.threadLinks.isEmpty {
        Section("Linked work") {
            ForEach(detail.threadLinks) { link in
                Button {
                    guard let threadID = link.fields["threadId"]?.stringValue,
                          let environmentID = link.fields["environmentId"]?.stringValue else { return }
                    appModel.pendingThreadRoute = PathwayPendingThreadRoute(companyId: companyID, environmentId: environmentID, threadId: threadID)
                    dismiss()
                } label: {
                    Label(link.fields["title"]?.stringValue ?? "Open linked thread", systemImage: "bubble.left.and.bubble.right")
                }
                .swipeActions { Button("Unlink", role: .destructive) { mutate(issue, kind: "issueThreadLink.delete", id: link.id) } }
            }
        }
        }
    }

    @ViewBuilder
    private func commentSections(_ issue: PathwayIssueRecord, detail: PathwayIssueDetail) -> some View {
        Section {
            if detail.comments.isEmpty { Text("No comments yet").foregroundStyle(.secondary) }
            ForEach(detail.comments) { comment in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(actorName(comment.fields["author"])).font(.subheadline.weight(.semibold))
                        Spacer()
                        if canEditComment(comment) {
                        Menu {
                            if canEditComment(comment) {
                            Button("Edit", systemImage: "pencil") {
                                editingCommentID = comment.id
                                commentText = comment.fields["body"]?.stringValue ?? ""
                                attachmentIDs = comment.fields["attachmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
                                commentExpanded = true
                                commentFocused = true
                            }
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) { mutate(issue, kind: "issueComment.delete", id: comment.id) }
                        } label: { Image(systemName: "ellipsis").padding(8) }.accessibilityLabel("Comment actions")
                        }
                    }
                    PathwayIssueMarkdownView(markdown: comment.fields["body"]?.stringValue ?? "")
                    ForEach(comment.fields["attachmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], id: \.self) { id in
                        if let url = attachmentURLs[id] {
                            Link(destination: url) {
                                AsyncImage(url: url) { image in image.resizable().scaledToFit() }
                                placeholder: { Label("View attachment", systemImage: "photo") }
                                    .frame(maxHeight: 200).clipShape(.rect(cornerRadius: 10))
                            }
                        }
                    }
                    if let run = comment.fields["agentRun"]?.objectValue {
                        Text(run["error"]?.stringValue ?? run["phase"]?.stringValue ?? run["state"]?.stringValue ?? "")
                            .font(.caption).foregroundStyle(.secondary)
                        let active = ["running", "queued"].contains(run["state"]?.stringValue ?? "")
                        if active || ["failed", "canceled"].contains(run["state"]?.stringValue ?? "") {
                            Button(active ? "Stop agent" : "Retry agent") {
                                perform { _ = try await model.request(issue, method: active ? "issues.cancelCommentAgentRun" : "issues.retryCommentAgentRun", payload: ["commentId": .string(comment.id)]) }
                            }
                        }
                        if let transcript = run["transcript"]?.stringValue, !transcript.isEmpty {
                            DisclosureGroup("Agent log") { Text(transcript).font(.caption.monospaced()).textSelection(.enabled) }
                        }
                    }
                }.padding(.vertical, 6)
            }
        }
    }

    private func relationRow(_ issue: PathwayIssueRecord, relation: PathwayIssueEntity) -> some View {
        let fields = relation.fields["relation"]?.objectValue ?? relation.fields
        let outgoing = fields["issueId"]?.stringValue == issue.id
        let otherID = fields[outgoing ? "relatedIssueId" : "issueId"]?.stringValue
        let other = model.records.first { $0.companyId == companyID && $0.id == otherID }
        let kind = fields["kind"]?.stringValue ?? "relates"
        let label = kind == "blocks" ? (outgoing ? "Blocks" : "Blocked by") : (kind == "duplicate" ? "Duplicate" : "Related")
        return Group {
            if let other {
                Button { openIssue(other.id) } label: {
                    VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); Text(other.title).lineLimit(1).foregroundStyle(.primary) }
                }.disabled(!canNavigate)
                 .contextMenu {
                    Button("Remove relation", systemImage: "link.badge.minus", role: .destructive) { mutate(issue, kind: "issueRelation.delete", id: relation.id) }
                }
            }
        }
    }

    private func issueURL(_ issue: PathwayIssueRecord) -> URL? {
        var components = URLComponents(string: "https://app.spiritdevs.com/issues")
        // The web route resolves immutable IDs before display keys, which can repeat across companies.
        components?.queryItems = [URLQueryItem(name: "issue", value: issue.id)]
        return components?.url
    }

    private func openIssue(_ id: String) {
        guard canNavigate, id != issueID else { return }
        openedIssueID = id
    }

    private func slackSourceLabel(_ source: [String: JSONValue]) -> some View {
        let channel = source["channelName"]?.stringValue ?? source["channelId"]?.stringValue ?? "Slack"
        let author = source["authorName"]?.stringValue
        return Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(channel == "Slack" ? channel : "#\(channel)")
                if let author { Text(author).font(.caption).foregroundStyle(.secondary) }
            }
        } icon: { Image(systemName: "number.square") }
    }

    private func attachmentRow(_ issue: PathwayIssueRecord, attachment: PathwayIssueEntity, detail: PathwayIssueDetail) -> some View {
        let name = attachment.fields["fileName"]?.stringValue ?? "Image"
        let isImage = attachment.fields["mimeType"]?.stringValue?.hasPrefix("image/") == true
        return HStack(spacing: 12) {
            if let url = attachmentURLs[attachment.id] {
                Link(destination: url) {
                    HStack(spacing: 12) {
                        if isImage {
                            AsyncImage(url: url) { image in image.resizable().scaledToFill() }
                            placeholder: { Image(systemName: "photo").foregroundStyle(.secondary) }
                                .frame(width: 72, height: 56).clipShape(.rect(cornerRadius: 8))
                        } else { Image(systemName: "video") }
                        Text(name).lineLimit(2).foregroundStyle(.primary)
                    }
                }.accessibilityLabel("Open attachment \(name)")
            } else { Label(name, systemImage: "photo").foregroundStyle(.secondary) }
            Spacer()
            if canRemoveAttachment(attachment.id, detail: detail) {
                Button("Remove attachment", systemImage: "xmark.circle") {
                    removeAttachment(issue, attachmentID: attachment.id)
                }.labelStyle(.iconOnly).foregroundStyle(.secondary)
                    .accessibilityLabel("Remove attachment \(name)")
            }
        }
    }

    private func attachmentComments(_ attachmentID: String, detail: PathwayIssueDetail) -> [PathwayIssueEntity] {
        detail.comments.filter { $0.fields["attachmentIds"]?.arrayValue?.contains(.string(attachmentID)) == true }
    }

    private func canRemoveAttachment(_ attachmentID: String, detail: PathwayIssueDetail) -> Bool {
        let comments = attachmentComments(attachmentID, detail: detail)
        return !comments.isEmpty && comments.allSatisfy(canEditComment)
    }

    private func removeAttachment(_ issue: PathwayIssueRecord, attachmentID: String) {
        let detail = model.detail(for: issue)
        guard canRemoveAttachment(attachmentID, detail: detail) else {
            errorMessage = "This attachment can no longer be removed from this comment."
            return
        }
        let comments = attachmentComments(attachmentID, detail: detail)
        perform {
            for comment in comments {
                let remaining = (comment.fields["attachmentIds"]?.arrayValue ?? []).filter { $0 != .string(attachmentID) }
                _ = try await model.mutate(companyID: issue.companyId, kind: "issueComment.update", entityID: comment.id,
                                           args: ["attachmentIds": .array(remaining)])
            }
        }
    }

    private func attachmentFingerprint(_ detail: PathwayIssueDetail) -> String {
        let commentIDs = detail.comments.flatMap { $0.fields["attachmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
        return (detail.attachments.map(\.id) + commentIDs).joined(separator: ":")
    }

    private func moveTodo(_ issue: PathwayIssueRecord, todo: PathwayIssueEntity, offset: Int) {
        let todos = model.detail(for: issue).todos
        guard let index = todos.firstIndex(where: { $0.id == todo.id }), todos.indices.contains(index + offset) else { return }
        var reordered = todos
        reordered.swapAt(index, index + offset)
        let target = index + offset
        let before = target > 0 ? reordered[target - 1].fields["sortOrder"]?.stringValue : nil
        let after = target + 1 < reordered.count ? reordered[target + 1].fields["sortOrder"]?.stringValue : nil
        guard let key = PathwayIssueOrder.between(before, after) else {
            errorMessage = "These tasks have conflicting order values. Refresh the issue before reordering."; return
        }
        mutate(issue, kind: "issueTodo.update", id: todo.id, args: ["sortOrder": .string(key)])
    }

    private func addTodo(_ issue: PathwayIssueRecord) {
        let text = todoText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 512 else { return }
        perform {
            _ = try await model.mutate(companyID: companyID, kind: "issueTodo.create", entityID: UUID().uuidString,
                                       args: ["issueId": .string(issue.id), "text": .string(text)])
            todoText = ""
        }
    }

    private func saveComment(_ issue: PathwayIssueRecord) {
        perform {
            var args: [String: JSONValue] = ["body": .string(commentText), "attachmentIds": .array(attachmentIDs.map(JSONValue.string))]
            if editingCommentID == nil { args["issueId"] = .string(issue.id) }
            _ = try await model.mutate(companyID: companyID, kind: editingCommentID == nil ? "issueComment.create" : "issueComment.update",
                                       entityID: editingCommentID ?? UUID().uuidString, args: args)
            clearComment()
        }
    }

    private func clearComment() {
        commentText = ""; attachmentIDs = []; editingCommentID = nil
        commentFocused = false; commentExpanded = false
    }
    private func toggleDescriptionTask(_ issue: PathwayIssueRecord, line: Int) {
        var lines = issue.description.components(separatedBy: "\n")
        guard lines.indices.contains(line), let range = lines[line].range(of: #"\[[ xX]\]"#, options: .regularExpression) else { return }
        let checked = lines[line][range].lowercased() == "[x]"
        lines[line].replaceSubrange(range, with: checked ? "[ ]" : "[x]")
        perform { try await model.update(issue, patch: ["description": .string(lines.joined(separator: "\n"))]) }
    }
    private func mutate(_ issue: PathwayIssueRecord, kind: String, id: String, args: [String: JSONValue] = [:]) {
        perform { _ = try await model.mutate(companyID: issue.companyId, kind: kind, entityID: id, args: args) }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await action() } catch { errorMessage = error.localizedDescription } }
    }
    private func actorName(_ value: JSONValue?) -> String {
        let actor = value?.objectValue ?? [:]
        if actor["kind"]?.stringValue == "agent" { return actor["provider"]?.stringValue?.capitalized ?? "Agent" }
        if let memberID = actor["membershipId"]?.stringValue {
            return model.members.first { $0.companyId == companyID && $0.id == memberID }?.name ?? "Member"
        }
        return actor["kind"]?.stringValue == "system" ? "System" : "You"
    }
    private func canEditComment(_ comment: PathwayIssueEntity) -> Bool {
        guard let issue else { return false }
        return model.canEditComment(comment, issue: issue)
    }
    private func activityTitle(_ event: PathwayIssueEntity) -> String {
        let kind = event.fields["kind"]?.stringValue ?? "updated"
        let payload = event.fields["payload"]?.objectValue ?? event.fields
        if kind == "field_changed" {
            if let changes = payload["changes"]?.objectValue {
                let fields = changes.keys.sorted().joined(separator: ", ")
                return "\(actorName(event.fields["actor"])) changed \(fields)"
            }
            return "\(actorName(event.fields["actor"])) changed \(payload["field"]?.stringValue ?? "issue")"
        }
        return "\(actorName(event.fields["actor"])) · \(kind.replacingOccurrences(of: "_", with: " "))"
    }
}

struct PathwayIssueRelationPicker: View {
    let model: PathwayIssuesModel
    let issue: PathwayIssueRecord
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var kind = "relates"
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Picker("Relationship", selection: $kind) {
                    Text("Related to").tag("relates")
                    Text("Blocks").tag("blocks")
                    Text("Blocked by").tag("blockedBy")
                    Text("Duplicate of").tag("duplicate")
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                ForEach(model.records.filter {
                    $0.companyId == issue.companyId && $0.id != issue.id && !$0.isDeleted &&
                    (query.isEmpty || $0.title.localizedStandardContains(query) || $0.key.localizedStandardContains(query))
                }, id: \.id) { other in
                    Button {
                        busy = true
                        Task {
                            defer { busy = false }
                            do {
                                _ = try await model.mutate(companyID: issue.companyId, kind: "issueRelation.create", entityID: UUID().uuidString,
                                                           args: ["issueId": .string(kind == "blockedBy" ? other.id : issue.id),
                                                                  "relatedIssueId": .string(kind == "blockedBy" ? issue.id : other.id),
                                                                  "kind": .string(kind == "blockedBy" ? "blocks" : kind)])
                                dismiss()
                            } catch { errorMessage = error.localizedDescription }
                        }
                    } label: { VStack(alignment: .leading) { Text(other.title); Text(other.key).font(.caption).foregroundStyle(.secondary) } }
                }
            }
            .disabled(busy)
            .searchable(text: $query, prompt: "Find an issue")
            .navigationTitle("Add relation").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}


/// Matches client-runtime's base-26 fractional ordering; moving a task changes one row.
enum PathwayIssueOrder {
    static func between(_ before: String?, _ after: String?) -> String? {
        let left = before ?? "", right = after ?? ""
        func valid(_ key: String) -> Bool {
            key.isEmpty || (key.utf8.allSatisfy { (97...122).contains($0) } && key.last != "a")
        }
        guard valid(left), valid(right), right.isEmpty || left < right else { return nil }
        return midpoint(Array(left.utf8), Array(right.utf8))
    }
    private static func midpoint(_ left: [UInt8], _ right: [UInt8]) -> String {
        if !right.isEmpty {
            var prefix = 0
            while prefix < right.count && (prefix < left.count ? left[prefix] : 97) == right[prefix] { prefix += 1 }
            if prefix > 0 {
                return String(decoding: right.prefix(prefix), as: UTF8.self) + midpoint(Array(left.dropFirst(prefix)), Array(right.dropFirst(prefix)))
            }
        }
        let low = Int(left.first ?? 97) - 97
        let high = right.first.map { Int($0) - 97 } ?? 26
        if high - low > 1 { return String(UnicodeScalar(97 + (low + high + 1) / 2)!) }
        if right.count > 1 { return String(UnicodeScalar(Int(right[0]))!) }
        return String(UnicodeScalar(97 + low)!) + midpoint(Array(left.dropFirst()), [])
    }
}
