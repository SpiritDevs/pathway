import SwiftUI

// First-stage list, timeline, work cards, and composer remain colocated while their
// visual language is still being tuned together.
// swiftlint:disable file_length

struct AgentThreadsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let newThreadAction: () -> Void

    @State private var searchText = ""

    var body: some View {
        Group {
            if filteredThreads.isEmpty {
                emptyState
            } else {
                List(filteredThreads) { thread in
                    NavigationLink {
                        AgentThreadDetailRoute(thread: thread)
                    } label: {
                        AgentThreadRow(thread: thread)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Agent Threads")
        .searchable(text: $searchText, prompt: "Search threads")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New thread", systemImage: "square.and.pencil", action: newThreadAction)
            }
        }
        .refreshable {
            await appModel.cloud.retry()
        }
        .accessibilityIdentifier("agent-threads-list")
    }

    private var filteredThreads: [PathwayAgentThread] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return appModel.cloud.threads }
        return appModel.cloud.threads.filter { thread in
            let metadata = [
                thread.shell.title,
                appModel.cloud.companyName(for: thread.companyId),
                appModel.cloud.environmentLabel(
                    companyId: thread.companyId,
                    environmentId: thread.environmentId
                ),
                appModel.cloud.projectName(
                    companyId: thread.companyId,
                    projectId: thread.cloudProjectId
                ),
                thread.shell.modelSelection.model
            ].compactMap(\.self).joined(separator: " ")
            return metadata.localizedCaseInsensitiveContains(query)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch appModel.cloud.connectionState {
        case .connecting, .syncing:
            ProgressView("Syncing Agent Threads…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Threads unavailable", systemImage: "exclamationmark.icloud")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") {
                    Task { await appModel.cloud.retry() }
                }
            }
        default:
            ContentUnavailableView {
                Label("No Agent Threads", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text(
                    searchText.isEmpty
                        ? "Start a thread in one of your Pathway environments."
                        : "No threads match your search."
                )
            } actions: {
                if searchText.isEmpty {
                    Button("New thread", action: newThreadAction)
                }
            }
        }
    }
}

private struct AgentThreadRow: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if thread.shell.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Text(thread.shell.title)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)

                Spacer(minLength: 8)

                Text(thread.sortDate, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            HStack(spacing: 6) {
                status

                if let projectName {
                    Text(projectName)
                        .lineLimit(1)
                }

                if let environmentName {
                    Text("·")
                    Text(environmentName)
                        .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 5) {
                Text(thread.shell.modelSelection.model)
                    .lineLimit(1)

                if let companyName {
                    Text("in \(companyName)")
                        .lineLimit(1)
                }
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var status: some View {
        if thread.needsAction {
            Label("Needs you", systemImage: "person.crop.circle.badge.exclamationmark")
                .foregroundStyle(.orange)
        } else if thread.isRunning {
            Label("Working", systemImage: "sparkles")
                .foregroundStyle(.blue)
        } else {
            Text(thread.shell.status.capitalized)
        }
    }

    private var companyName: String? {
        appModel.cloud.companyName(for: thread.companyId)
    }

    private var projectName: String? {
        appModel.cloud.projectName(companyId: thread.companyId, projectId: thread.cloudProjectId)
    }

    private var environmentName: String? {
        appModel.cloud.environmentLabel(
            companyId: thread.companyId,
            environmentId: thread.environmentId
        )
    }
}

private struct AgentThreadDetailRoute: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread

    var body: some View {
        if let connect = appModel.connect, let environment {
            AgentThreadConversationView(
                thread: thread,
                environment: environment,
                connect: connect
            )
        } else {
            ContentUnavailableView {
                Label("Environment unavailable", systemImage: "network.slash")
            } description: {
                Text("This thread's Pathway environment is not available through Connect.")
            }
            .navigationTitle(thread.shell.title)
        }
    }

    private var environment: PathwayCompanyEnvironment? {
        appModel.cloud.environments.first {
            $0.companyId == thread.companyId
                && $0.environment.environmentId == thread.environmentId
        }
    }
}

private struct AgentThreadConversationView: View {
    let thread: PathwayAgentThread
    @State private var model: PathwayAgentThreadModel

    init(
        thread: PathwayAgentThread,
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient
    ) {
        self.thread = thread
        _model = State(
            initialValue: PathwayAgentThreadModel(
                thread: thread,
                environment: environment,
                connect: connect
            )
        )
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    connectionBanner

                    ForEach(model.items) { item in
                        AgentTimelineItemView(item: item, model: model)
                            .id(item.id)
                    }
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.items.last?.id) { _, identifier in
                guard let identifier else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(identifier, anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentThreadComposer(model: model)
        }
        .navigationTitle(thread.shell.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { model.start() }
        .onDisappear {
            Task { await model.stop() }
        }
        .accessibilityIdentifier("agent-thread-conversation")
    }

    @ViewBuilder
    private var connectionBanner: some View {
        switch model.connectionState {
        case .connecting:
            HStack(spacing: 8) {
                ProgressView()
                Text("Connecting to the environment…")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        case .cached:
            Label("Showing saved messages while the environment reconnects", systemImage: "wifi.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
        default:
            EmptyView()
        }
    }
}

private struct AgentTimelineItemView: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel

    var body: some View {
        if item.isConversation {
            conversation
        } else if item.type == "approval_request" {
            ApprovalCard(item: item, model: model)
        } else if item.type == "user_input_request" {
            UserInputCard(item: item, model: model)
        } else {
            WorkEventCard(item: item)
        }
    }

    private var conversation: some View {
        VStack(alignment: item.isUserMessage ? .trailing : .leading, spacing: 8) {
            if let text = item.text, !text.isEmpty {
                PathwayMarkdownText(markdown: text)
                    .textSelection(.enabled)
            }

            ForEach(item.attachments) { attachment in
                Label(attachment.name, systemImage: attachment.type == "image" ? "photo" : "doc")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if item.streaming {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Agent is responding")
            }
        }
        .frame(maxWidth: .infinity, alignment: item.isUserMessage ? .trailing : .leading)
        .padding(item.isUserMessage ? 12 : 0)
        .background {
            if item.isUserMessage {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.accentColor.opacity(0.13))
            }
        }
        .padding(.leading, item.isUserMessage ? 44 : 0)
        .padding(.trailing, item.isUserMessage ? 0 : 20)
    }
}

private struct PathwayMarkdownText: View {
    let markdown: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .full)
        ) {
            Text(attributed)
        } else {
            Text(markdown)
        }
    }
}

private struct WorkEventCard: View {
    let item: PathwayTimelineItem
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            if let text = item.text, !text.isEmpty {
                PathwayMarkdownText(markdown: text)
                    .font(.callout.monospaced(item.type == "command_execution"))
                    .textSelection(.enabled)
                    .padding(.top, 8)
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(iconColor)

                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.callout.weight(.medium))
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if item.status == "running" {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var label: String {
        item.title ?? item.fileName ?? item.type.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private var detail: String? {
        if item.type == "file_change" {
            return "+\(item.additions ?? 0) −\(item.deletions ?? 0)"
        }
        if let exitCode = item.exitCode { return "Exited with code \(exitCode)" }
        return item.status.capitalized
    }

    private var icon: String {
        switch item.type {
        case "reasoning": "brain"
        case "command_execution": "terminal"
        case "file_change": "doc.badge.ellipsis"
        case "source_control": "arrow.triangle.branch"
        case "subagent": "person.2"
        case "error": "exclamationmark.triangle"
        case "checkpoint": "clock.arrow.circlepath"
        default: "gearshape.2"
        }
    }

    private var iconColor: Color {
        item.type == "error" || item.status == "failed" ? .red : .secondary
    }
}

private struct ApprovalCard: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Approval needed", systemImage: "checkmark.shield")
                .font(.headline)

            if let text = item.text {
                Text(text)
                    .font(.callout)
            }

            if item.requiresResponse, let requestID = item.requestID {
                HStack {
                    Button("Decline", role: .destructive) {
                        Task { await model.respondToApproval(requestID: requestID, decision: "decline") }
                    }
                    .buttonStyle(.bordered)

                    Button("Allow") {
                        Task { await model.respondToApproval(requestID: requestID, decision: "accept") }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(14)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct UserInputCard: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("The agent has a question", systemImage: "questionmark.bubble")
                .font(.headline)

            ForEach(item.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(question.question)

                    if item.requiresResponse, let requestID = item.requestID {
                        ForEach(question.options, id: \.label) { option in
                            Button {
                                Task {
                                    await model.respondToQuestion(
                                        requestID: requestID,
                                        questionID: question.id,
                                        answer: option.label
                                    )
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label)
                                    Text(option.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct AgentThreadComposer: View {
    @Bindable var model: PathwayAgentThreadModel

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message the agent", text: $model.draft, axis: .vertical)
                .lineLimit(1 ... 7)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                .submitLabel(.send)
                .onSubmit {
                    Task { await model.send() }
                }

            Button {
                Task { await model.send() }
            } label: {
                if model.isSending {
                    ProgressView()
                        .frame(width: 34, height: 34)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .frame(width: 34, height: 34)
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.circle)
            .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.bar)
    }
}
