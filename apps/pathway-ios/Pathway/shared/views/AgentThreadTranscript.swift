import SwiftUI
import UIKit

struct AgentThreadTranscript: View {
    let model: PathwayAgentThreadModel
    let onOpenChild: (String) -> Void
    @State private var editingItem: PathwayTimelineItem?
    @State private var queuedEditingRunID: String?
    @State private var errorMessage: String?
    @State private var forkingID: String?
    @State private var preparingEditID: String?
    @State private var layoutCache = AgentThreadTranscriptLayoutCache()

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 22) {
            ForEach(layoutCache.rows(model.items, activeRunID: model.activeRunID)) { row in
                switch row.content {
                case .item(let item):
                    itemView(item)
                case .work(let label, let items, let settled):
                    AgentTranscriptWorkGroup(label: label, items: items, settled: settled, model: model, onOpenChild: onOpenChild)
                }
            }
            Color.clear.frame(height: 1).id("agent-transcript-bottom")
        }
        .sheet(item: $editingItem) { item in
            AgentTranscriptMessageEditor(item: item, model: model, queuedRunID: queuedEditingRunID)
        }
        .alert("Couldn’t complete action", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-transcript")
    }

    @ViewBuilder
    private func itemView(_ item: PathwayTimelineItem) -> some View {
        let queued = queuedRun(for: item)
        if item.isConversation {
            AgentTranscriptMessage(item: item, model: model) {
                if item.isUserMessage && (model.canPrepareEdit(item) || queued != nil) {
                    Button(queued == nil ? "Edit and restart" : "Edit queued message", systemImage: "pencil") { beginEditing(item, queuedRunID: queued?.id) }
                        .accessibilityIdentifier("thread-message-edit-\(item.id)")
                        .disabled(preparingEditID != nil)
                }
                if item.isUserMessage && model.activeRunID == nil && model.canEdit(item) && model.run(for: item)?.status == "failed" {
                    Button("Retry message", systemImage: "arrow.clockwise") {
                        Task { do { try await model.editLatestUserMessage(item, text: AgentTranscriptMessageEditor.editableText(item.text ?? "")) } catch { errorMessage = error.localizedDescription } }
                    }
                }
                if !item.isUserMessage && !item.streaming && item.runID != nil {
                    Button("Fork from here", systemImage: "arrow.triangle.branch") { fork(item) }
                        .accessibilityIdentifier("thread-message-fork-\(item.id)")
                        .disabled(forkingID != nil || model.thread.shell.isTemporary)
                    if model.thread.shell.isTemporary { Text("Keep conversation before forking this thread.") }
                }
            }
            if let run = queued {
                AgentTranscriptQueueActions(run: run, model: model) { beginEditing(item, queuedRunID: run.id) }
            }
        } else if item.type == "approval_request" {
            AgentTranscriptApproval(item: item, model: model)
        } else if item.type == "user_input_request" {
            if item.requiresResponse && model.isNonBlockingQuestion(item) {
                Label("\(item.questions.count) unanswered questions. Open Questions near the composer to reply.", systemImage: "questionmark.bubble")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                AgentTranscriptQuestions(item: item, model: model)
            }
        } else {
            AgentTranscriptEventRow(item: item, model: model, onOpenChild: onOpenChild)
        }
    }

    private func beginEditing(_ item: PathwayTimelineItem, queuedRunID: String?) {
        guard preparingEditID == nil else { return }
        if queuedRunID != nil || model.activeRunID == nil {
            queuedEditingRunID = queuedRunID
            editingItem = item
            return
        }
        guard model.canPrepareEdit(item) else { return }
        preparingEditID = item.id
        Task {
            defer { preparingEditID = nil }
            do {
                try await model.interrupt()
                queuedEditingRunID = nil
                editingItem = item
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func queuedRun(for item: PathwayTimelineItem) -> PathwayThreadRun? {
        guard item.isUserMessage else { return nil }
        return model.queuedRuns.first { $0.id == item.runID || (item.messageID != nil && $0.userMessageID == item.messageID) }
    }

    private func fork(_ item: PathwayTimelineItem) {
        guard forkingID == nil else { return }
        forkingID = item.id
        Task {
            defer { forkingID = nil }
            do { onOpenChild(try await model.fork(from: item)) }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

private struct AgentTranscriptMessage<Actions: View>: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    @ViewBuilder let actions: () -> Actions
    @State private var showingContext = false

    var body: some View {
        VStack(alignment: item.isUserMessage ? .trailing : .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 12) {
                if let text = item.text, !text.isEmpty {
                    if item.isUserMessage {
                        Text(AgentTranscriptMessageEditor.editableText(text)).textSelection(.enabled)
                    } else {
                        AgentTranscriptMarkdown(markdown: text).equatable()
                    }
                }
                ForEach(item.attachments) { attachment in
                    AgentTranscriptAttachment(attachment: attachment, model: model)
                }
                if item.isUserMessage, let text = item.text, AgentTranscriptMessageEditor.editableText(text) != text {
                    DisclosureGroup("Attached context", isExpanded: $showingContext) {
                        Text(String(text.dropFirst(AgentTranscriptMessageEditor.editableText(text).count)))
                            .font(.caption.monospaced()).textSelection(.enabled)
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(item.isUserMessage ? 14 : 0)
            .background {
                if item.isUserMessage { RoundedRectangle(cornerRadius: 22).fill(Color(uiColor: .secondarySystemBackground)) }
            }
            .frame(maxWidth: .infinity, alignment: item.isUserMessage ? .trailing : .leading)
            .contextMenu {
                Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text ?? "" }
                actions()
            }
            if !item.isUserMessage {
                HStack(spacing: 18) {
                    Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text ?? "" }
                        .labelStyle(.iconOnly).accessibilityIdentifier("thread-message-copy-\(item.id)")
                    actions().labelStyle(.iconOnly)
                    if item.streaming {
                        Text("Responding…").font(.caption).accessibilityLabel("Agent is responding")
                    }
                }
                .font(.subheadline).foregroundStyle(.secondary).buttonStyle(.plain)
                .padding(.top, 3)
            }
        }
        .padding(.leading, item.isUserMessage ? 40 : 0)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-message-\(item.id)")
    }
}

private struct AgentTranscriptAttachment: View {
    let attachment: PathwayMessageAttachment
    let model: PathwayAgentThreadModel
    @State private var url: URL?
    @State private var errorMessage: String?
    @State private var attempt = 0
    @State private var showPreview = false

    var body: some View {
        Group {
            if let url {
                if attachment.type == "image" {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            Button { showPreview = true } label: {
                                image.resizable().scaledToFit().frame(maxWidth: 280, maxHeight: 210)
                                    .clipShape(.rect(cornerRadius: 12))
                            }.buttonStyle(.plain)
                        case .failure:
                            unavailable("This image couldn’t be loaded.")
                        default:
                            ProgressView().frame(width: 100, height: 70)
                        }
                    }
                } else {
                    Button { showPreview = true } label: {
                        Label(attachment.name, systemImage: "doc").lineLimit(2)
                            .padding(12).background(.quaternary, in: .rect(cornerRadius: 12))
                    }.buttonStyle(.plain)
                }
            } else if let errorMessage {
                unavailable(errorMessage)
            } else {
                HStack(spacing: 8) { ProgressView(); Text(attachment.name).lineLimit(1) }
                    .foregroundStyle(.secondary)
            }
        }
        .font(.subheadline).accessibilityLabel("Attachment \(attachment.name)")
        .sheet(isPresented: $showPreview) {
            AgentTranscriptAttachmentPreview(attachment: attachment, model: model, initialURL: url)
        }
        .task(id: attempt) {
            do { url = try await model.attachmentURL(attachment); errorMessage = nil }
            catch { errorMessage = error.localizedDescription }
        }
    }
    private func unavailable(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(attachment.name, systemImage: attachment.type == "image" ? "photo" : "doc")
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("Retry") { url = nil; errorMessage = nil; attempt += 1 }
        }.padding(12).background(.quaternary, in: .rect(cornerRadius: 12))
    }
}

private struct AgentTranscriptAttachmentPreview: View {
    let attachment: PathwayMessageAttachment
    let model: PathwayAgentThreadModel
    let initialURL: URL?
    @Environment(\.dismiss) private var dismiss
    @State private var url: URL?
    @State private var attempt = 0
    @State private var errorMessage: String?
    @State private var zoom: CGFloat = 1
    @State private var baseZoom: CGFloat = 1

    var body: some View {
        NavigationStack {
            Group {
                if let url, attachment.type == "image" {
                    GeometryReader { geometry in
                        ScrollView([.horizontal, .vertical]) {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFit()
                                        .frame(width: geometry.size.width * zoom, height: geometry.size.height * zoom)
                                        .onTapGesture(count: 2) { zoom = zoom > 1 ? 1 : 2; baseZoom = zoom }
                                        .simultaneousGesture(MagnifyGesture().onChanged { value in
                                            zoom = min(5, max(1, baseZoom * value.magnification))
                                        }.onEnded { _ in baseZoom = zoom })
                                case .failure:
                                    failure("This image couldn’t be loaded.")
                                        .frame(width: geometry.size.width, height: geometry.size.height)
                                default:
                                    ProgressView().frame(width: geometry.size.width, height: geometry.size.height)
                                }
                            }
                        }
                    }
                } else if let errorMessage {
                    failure(errorMessage)
                } else if let url {
                    VStack(spacing: 18) {
                        Image(systemName: "doc").font(.largeTitle).foregroundStyle(.secondary)
                        Text(attachment.name).font(.headline)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file))
                            .font(.subheadline).foregroundStyle(.secondary)
                        ShareLink("Share file", item: url).buttonStyle(.borderedProminent)
                    }.padding(24)
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if let url { ShareLink(item: url).labelStyle(.iconOnly) }
                }
            }
            .task(id: attempt) {
                do {
                    if attempt == 0, let initialURL { url = initialURL }
                    else { url = try await model.attachmentURL(attachment) }
                    errorMessage = nil
                } catch { errorMessage = error.localizedDescription }
            }
        }
    }
    private func failure(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Preview unavailable", systemImage: "photo")
        } description: { Text(message) } actions: {
            Button("Retry") { url = nil; errorMessage = nil; attempt += 1 }
        }
    }
}

private struct AgentTranscriptWorkGroup: View {
    let label: String
    let items: [PathwayTimelineItem]
    let settled: Bool
    let model: PathwayAgentThreadModel
    let onOpenChild: (String) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 7) {
                    if !settled { Image(systemName: "magnifyingglass") }
                    Text(label).lineLimit(2)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption)
                    Spacer(minLength: 0)
                }.foregroundStyle(.secondary).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("thread-work-\(items.first?.runID ?? items.first?.id ?? "group")")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(items) { item in
                        if item.isConversation {
                            AgentTranscriptMarkdown(markdown: item.text ?? "").equatable()
                        } else {
                            AgentTranscriptEventRow(item: item, model: model, onOpenChild: onOpenChild)
                        }
                    }
                }
            }
            if settled { Divider() }
        }
    }
}

struct AgentTranscriptEventRow: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    var onOpenChild: (String) -> Void = { _ in }
    @State private var expanded = false

    private var childID: String? {
        item.childThreadID ?? model.subagents.first { $0.id == item.fields["subagentId"]?.stringValue }?.childThreadID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let childID {
                HStack(spacing: 4) {
                    Button { onOpenChild(childID) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: icon).frame(width: 20)
                            Text(title).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "arrow.up.right").font(.caption)
                        }.contentShape(.rect)
                    }
                    .accessibilityIdentifier("thread-child-\(childID)")
                    .accessibilityValue(item.status.capitalized)
                    Button { expanded.toggle() } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption).frame(width: 36, height: 36).contentShape(.rect)
                    }
                    .accessibilityLabel("Agent activity details")
                    .accessibilityIdentifier("thread-activity-\(item.id)")
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                }
                .font(.subheadline).foregroundStyle(item.status == "failed" ? Color.red : Color.secondary)
                .buttonStyle(.plain)
            } else {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: icon).frame(width: 20)
                        Text(title).lineLimit(expanded ? 3 : 1).frame(maxWidth: .infinity, alignment: .leading)
                        if item.type == "file_change" {
                            Text("+\(item.additions ?? 0)").foregroundStyle(.green)
                            Text("−\(item.deletions ?? 0)").foregroundStyle(.red)
                        }
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption)
                    }
                    .font(.subheadline).foregroundStyle(item.status == "failed" || (item.type == "error" && item.status != "completed") ? Color.red : Color.secondary)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("thread-activity-\(item.id)")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            }
            if model.canRecoverWorkspacePreparation(item) {
                WorkspacePreparationRecoveryActions(item: item, model: model)
            }
            if expanded {
                AgentTranscriptEventContent(item: item, model: model)
                    .padding(.leading, 28)
            }
        }
    }

    private var title: String {
        if let title = item.title, !title.isEmpty { return title }
        switch item.type {
        case "file_change": return item.fileName ?? "Edited file"
        case "command_execution": return "Ran \(item.fields["input"]?.stringValue?.components(separatedBy: .newlines).first ?? "command")"
        case "file_search": return "Searched \(item.fields["pattern"]?.stringValue ?? "files")"
        case "web_search": return "Searched \(item.fields["patterns"]?.arrayValue?.compactMap(\.stringValue).joined(separator: ", ") ?? "the web")"
        case "subagent": return "Agent work"
        case "reasoning": return "Thinking"
        case "dynamic_tool": return item.fields["toolName"]?.stringValue ?? "Tool call"
        case "checkpoint": return "Saved checkpoint"
        default: return item.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
    private var icon: String {
        switch item.type {
        case "command_execution": "terminal"
        case "file_change": "doc.badge.ellipsis"
        case "file_search", "web_search": "magnifyingglass"
        case "subagent", "thread_created": "person.2"
        case "reasoning": "brain"
        case "error": "exclamationmark.triangle"
        case "source_control", "fork": "arrow.triangle.branch"
        case "checkpoint": "clock.arrow.circlepath"
        case "todo_list": "checklist"
        default: "square.stack.3d.up"
        }
    }
}

private struct WorkspacePreparationRecoveryActions: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    @State private var pending: String?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            HStack {
                Spacer()
                Button { recover("work_locally") } label: {
                    Label(pending == "work_locally" ? "Switching to local…" : "Work locally", systemImage: "laptopcomputer")
                }
                Button { recover("retry") } label: {
                    Label(pending == "retry" ? "Retrying…" : "Retry", systemImage: "arrow.clockwise")
                }
            }
            .buttonStyle(.bordered)
            .disabled(pending != nil || !model.isSubscriptionReady)
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func recover(_ action: String) {
        guard pending == nil, model.canRecoverWorkspacePreparation(item), let runID = item.runID else { return }
        pending = action
        errorMessage = nil
        Task { @MainActor in
            defer { pending = nil }
            do { try await model.controlWorkspacePreparation(action: action, runID: runID) }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

struct AgentTranscriptEventContent: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    @State private var confirmRestore = false
    @State private var busy = false
    @State private var errorMessage: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if item.type == "command_execution" {
                if let input = item.fields["input"]?.stringValue { AgentTranscriptCodeBlock(text: input) }
                if let output = item.fields["output"]?.stringValue, !output.isEmpty { AgentTranscriptCodeBlock(text: output) }
                if let code = item.exitCode { Text("Exit code \(code)").font(.caption).foregroundStyle(code == 0 ? Color.secondary : Color.red) }
            } else if item.type == "file_change" {
                if let diff = item.fields["diffStr"]?.stringValue, !diff.isEmpty {
                    AgentTranscriptCodeBlock(text: diff)
                } else {
                    if let old = item.fields["oldStr"]?.stringValue { Text("Before").font(.caption); AgentTranscriptCodeBlock(text: old) }
                    if let new = item.fields["newStr"]?.stringValue { Text("After").font(.caption); AgentTranscriptCodeBlock(text: new) }
                    if item.fields["oldStr"]?.stringValue == nil && item.fields["newStr"]?.stringValue == nil {
                        Text("+\(item.additions ?? 0) additions, −\(item.deletions ?? 0) deletions").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            } else if item.type == "dynamic_tool" {
                if let input = item.fields["input"] { Text("Input").font(.caption); AgentTranscriptCodeBlock(text: formatted(input)) }
                if let output = item.fields["output"] { Text("Result").font(.caption); AgentTranscriptCodeBlock(text: formatted(output)) }
            } else if item.type == "subagent" {
                if let prompt = item.fields["prompt"]?.stringValue { AgentTranscriptMarkdown(markdown: prompt).equatable() }
                if let progress = item.fields["progress"]?.stringValue { Text(progress).font(.subheadline).foregroundStyle(.secondary) }
                if let result = item.fields["result"]?.stringValue { AgentTranscriptMarkdown(markdown: result).equatable() }
            } else if item.type == "todo_list" {
                if let explanation = item.fields["explanation"]?.stringValue { AgentTranscriptMarkdown(markdown: explanation).equatable() }
                ForEach(Array((item.fields["steps"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, step in
                    let state = step.objectValue?["status"]?.stringValue ?? "pending"
                    Label(step.objectValue?["text"]?.stringValue ?? "", systemImage: state == "completed" ? "checkmark.circle.fill" : state == "running" ? "circle.lefthalf.filled" : "circle")
                        .font(.subheadline).foregroundStyle(state == "completed" ? .secondary : .primary)
                }
            } else {
                if let text = item.text, !text.isEmpty { AgentTranscriptMarkdown(markdown: text).equatable() }
                searchResults
                checkpointFiles
                if let url = item.fields["pullRequest"]?.objectValue?["url"]?.stringValue.flatMap(URL.init(string:)) {
                    Link("Open pull request", destination: url)
                }
            }
            if item.type == "proposed_plan", !item.streaming,
               model.plans.contains(where: { $0.objectValue?["id"]?.stringValue == item.fields["planId"]?.stringValue && $0.objectValue?["kind"]?.stringValue == "proposed_plan" && $0.objectValue?["status"]?.stringValue == "active" }) {
                Button("Implement plan", systemImage: "play.fill") {
                    perform { try await model.implementPlan(item) }
                }.buttonStyle(.borderedProminent).disabled(model.activeRunID != nil || model.isConfigurationLocked || model.isSending)
            }
            if item.type == "checkpoint", let checkpointID = item.fields["checkpointId"]?.stringValue, item.fields["scopeId"]?.stringValue != nil,
               model.checkpoints.contains(where: { $0.objectValue?["id"]?.stringValue == checkpointID && $0.objectValue?["status"]?.stringValue == "ready" }) {
                Button("Restore checkpoint", systemImage: "clock.arrow.circlepath") { confirmRestore = true }
                    .disabled(model.activeRunID != nil)
            }
            if let sha = item.fields["commitSha"]?.stringValue {
                Button { UIPasteboard.general.string = sha } label: {
                    Label(String(sha.prefix(10)), systemImage: "doc.on.doc").font(.caption.monospaced())
                }.accessibilityLabel("Copy commit hash")
            }
            Text(item.status.capitalized).font(.caption).foregroundStyle(.secondary)
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
        }
        .disabled(busy)
        .confirmationDialog("Restore this checkpoint?", isPresented: $confirmRestore, titleVisibility: .visible) {
            Button("Restore checkpoint", role: .destructive) {
                guard let checkpointID = item.fields["checkpointId"]?.stringValue, let scopeID = item.fields["scopeId"]?.stringValue else { return }
                perform { try await model.rollbackCheckpoint(checkpointID, scopeID: scopeID) }
            }
        } message: { Text("This restores tracked files to this checkpoint.") }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await action() } catch { errorMessage = error.localizedDescription } }
    }
    private func formatted(_ value: JSONValue) -> String {
        if let text = value.stringValue { return text }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    @ViewBuilder private var searchResults: some View {
        ForEach(Array((item.fields["results"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, result in
            let fields = result.objectValue ?? [:]
            if let url = fields["url"]?.stringValue.flatMap(URL.init(string:)) {
                Link(destination: url) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(fields["title"]?.stringValue ?? url.host() ?? "Search result")
                        if let snippet = fields["snippet"]?.stringValue { Text(snippet).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            } else if let file = fields["fileName"]?.stringValue {
                VStack(alignment: .leading, spacing: 4) {
                    Text(file + (fields["line"]?.intValue.map { ":\($0)" } ?? "")).font(.caption.monospaced())
                    if let preview = fields["preview"]?.stringValue { Text(preview).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
    }
    @ViewBuilder private var checkpointFiles: some View {
        ForEach(Array((item.fields["files"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, file in
            HStack {
                Text(file.objectValue?["path"]?.stringValue ?? "File").lineLimit(1).truncationMode(.middle)
                Spacer()
                Text("+\(file.objectValue?["additions"]?.intValue ?? 0)").foregroundStyle(.green)
                Text("−\(file.objectValue?["deletions"]?.intValue ?? 0)").foregroundStyle(.red)
            }.font(.caption)
        }
    }
}

private struct AgentTranscriptCodeBlock: View {
    let text: String
    var body: some View {
        ScrollView(.horizontal) {
            Text(text).font(.caption.monospaced()).textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false).padding(12)
        }
        .background(.quaternary, in: .rect(cornerRadius: 12))
        .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text } }
    }
}

private struct AgentTranscriptMessageEditor: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    let queuedRunID: String?
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool
    private var queuedMessageDeparted: Bool {
        queuedRunID.map { id in !model.queuedRuns.contains { $0.id == id } } ?? false
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                TextEditor(text: $text).focused($focused).accessibilityIdentifier("thread-message-edit-input")
                if let error { Text(error).font(.subheadline).foregroundStyle(.red) }
                Text(queuedRunID == nil ? "The agent will restart from this message." : "This changes the queued message before the agent starts it.").font(.footnote).foregroundStyle(.secondary)
                if queuedMessageDeparted {
                    Text("This message is no longer queued. Your draft is still here to copy.").font(.footnote).foregroundStyle(.secondary)
                } else if queuedRunID == nil && model.activeRunID != nil {
                    Text("Waiting for the agent to stop before restarting.").font(.footnote).foregroundStyle(.secondary)
                } else if queuedRunID == nil && !model.canEdit(item) {
                    Text("This message can no longer be restarted. Your draft is still here to copy.").font(.footnote).foregroundStyle(.secondary)
                }
            }.padding(20)
            .navigationTitle("Edit message").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(queuedRunID == nil ? "Save and restart" : "Save") {
                        busy = true
                        Task {
                            defer { busy = false }
                            do {
                                if let queuedRunID {
                                    guard !queuedMessageDeparted else { throw PathwayThreadConversationError.message("This message is no longer queued. Your draft has been kept.") }
                                    try await model.editQueuedRun(queuedRunID, text: PathwayAgentThreadModel.preservingMessageContext(original: item.text ?? "", edited: text))
                                } else { try await model.editLatestUserMessage(item, text: text) }
                                dismiss()
                            }
                            catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy || queuedMessageDeparted || (queuedRunID == nil && !model.canEdit(item)) || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .disabled(busy).interactiveDismissDisabled(busy)
            .task { text = Self.editableText(item.text ?? ""); focused = true }
        }
    }
    static func editableText(_ text: String) -> String {
        guard let range = text.range(of: #"\n*<(?:terminal_context|element_context|issue_context|preview_annotation|review_comment)\b"#, options: .regularExpression) else { return text }
        return String(text[..<range.lowerBound])
    }
}

struct AgentThreadChangesView: View {
    let model: PathwayAgentThreadModel
    @Environment(\.dismiss) private var dismiss
    private var changes: [String: [PathwayTimelineItem]] {
        Dictionary(grouping: model.items.filter { $0.type == "file_change" }, by: { $0.fileName ?? "File" })
    }
    var body: some View {
        NavigationStack {
            List {
                ForEach(changes.keys.sorted(), id: \.self) { path in
                    let edits = changes[path] ?? []
                    NavigationLink {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 20) {
                                ForEach(edits) { item in AgentTranscriptEventContent(item: item, model: model) }
                            }.padding(16)
                        }
                        .navigationTitle(URL(filePath: path).lastPathComponent).navigationBarTitleDisplayMode(.inline)
                    } label: {
                        HStack(spacing: 8) {
                            Text(path).lineLimit(2).truncationMode(.middle)
                            Spacer()
                            Text("+\(edits.reduce(0) { $0 + ($1.additions ?? 0) })").foregroundStyle(.green)
                            Text("−\(edits.reduce(0) { $0 + ($1.deletions ?? 0) })").foregroundStyle(.red)
                        }.font(.subheadline)
                    }
                }
                if changes.isEmpty { Text("No file changes in this conversation.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Changes").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Unchanged messages do not reparse Markdown while another message streams.
struct AgentTranscriptMarkdown: View, Equatable {
    let markdown: String
    var body: some View { PathwayIssueMarkdownView(markdown: markdown) }
}
