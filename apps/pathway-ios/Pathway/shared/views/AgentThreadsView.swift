import SwiftUI

// First-stage list, timeline, work cards, and composer remain colocated while their
// visual language is still being tuned together.
// swiftlint:disable file_length

struct AgentThreadsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let newThreadAction: () -> Void

    @State private var isSnoozedExpanded = false
    @State private var isSettledExpanded = false
    @State private var settledVisibleCount = 10
    @State private var routedThreadID: String?
    @State private var threadProviders = PathwayThreadProviders()
    @State private var threadActions = PathwayThreadActions()
    @State private var sleepingThread: PathwayAgentThread?

    var body: some View {
        Group {
            if lifecycleThreadCount == 0 {
                emptyState
            } else {
                threadList
            }
        }
        .navigationTitle("Agent Threads")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New thread", systemImage: "square.and.pencil", action: newThreadAction)
            }
        }
        .refreshable {
            await appModel.cloud.retry()
            if let connect = appModel.connect {
                await appModel.cloud.refreshLifecycleMetadata(using: connect)
            }
        }
        .task(id: lifecycleRefreshKey) {
            guard let connect = appModel.connect else { return }
            await appModel.cloud.refreshLifecycleMetadata(using: connect)
        }
        .task(id: providerEnvironments.map(\.id)) {
            guard let connect = appModel.connect else { return }
            await threadProviders.observe(environments: providerEnvironments, using: connect)
        }
        .navigationDestination(item: $routedThreadID) { threadID in
            if let thread = appModel.cloud.threads.first(where: { $0.id == threadID }) {
                AgentThreadDetailRoute(thread: thread)
            } else {
                ContentUnavailableView(
                    "Thread unavailable",
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
        }
        .task(id: appModel.pendingThreadRoute) {
            await openPendingThread()
        }
        .accessibilityIdentifier("agent-threads-list")
        .confirmationDialog("Sleep thread", isPresented: Binding(
            get: { sleepingThread != nil },
            set: { if !$0 { sleepingThread = nil } }
        ), titleVisibility: .visible, presenting: sleepingThread) { thread in
            Button("For 1 hour") { sleep(thread, hours: 1) }
            Button("For 3 hours") { sleep(thread, hours: 3) }
            Button("For 1 day") { sleep(thread, hours: 24) }
            Button("For 1 week") { sleep(thread, hours: 168) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Couldn’t update thread", isPresented: Binding(
            get: { threadActions.errorMessage != nil },
            set: { if !$0 { threadActions.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { threadActions.errorMessage = nil }
        } message: {
            Text(threadActions.errorMessage ?? "Please try again.")
        }
    }

    @ViewBuilder
    private var threadList: some View {
        List {
            ForEach(appModel.cloud.activeThreads) { thread in
                threadLink(thread)
            }

            if !appModel.cloud.snoozedThreads.isEmpty {
                Section {
                    if isSnoozedExpanded {
                        ForEach(appModel.cloud.snoozedThreads) { thread in
                            compactThreadLink(thread, icon: "clock")
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button("Wake", systemImage: "sun.max") { perform(.wake, on: thread) }
                                        .tint(.blue)
                                }
                        }
                    }
                } header: {
                    ThreadLifecycleShelfHeader(
                        title: "Snoozed",
                        count: appModel.cloud.snoozedThreads.count,
                        isExpanded: isSnoozedExpanded,
                        tint: .blue
                    ) {
                        isSnoozedExpanded.toggle()
                    }
                }
            }

            if !appModel.cloud.settledThreads.isEmpty {
                Section {
                    if isSettledExpanded {
                        ForEach(visibleSettledThreads) { thread in
                            compactThreadLink(thread, icon: "folder.fill")
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button("Reopen", systemImage: "arrow.uturn.backward") { perform(.reopen, on: thread) }
                                        .tint(.blue)
                                }
                        }

                        if hiddenSettledCount > 0 {
                            Button {
                                settledVisibleCount += 25
                            } label: {
                                Label(
                                    "Show \(min(hiddenSettledCount, 25)) more",
                                    systemImage: "plus"
                                )
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("settled-threads-show-more")
                        }
                    }
                } header: {
                    ThreadLifecycleShelfHeader(
                        title: "Settled",
                        count: appModel.cloud.settledThreads.count,
                        isExpanded: isSettledExpanded,
                        tint: .secondary
                    ) {
                        isSettledExpanded.toggle()
                    }
                }
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if usesCompactShell {
                Color.clear
                    .frame(height: CompactAppShellMetrics.scrollContentClearance)
                    .accessibilityHidden(true)
            }
        }
    }

    private var usesCompactShell: Bool {
        #if os(visionOS)
            false
        #else
            horizontalSizeClass != .regular
        #endif
    }

    private var lifecycleThreadCount: Int {
        appModel.cloud.activeThreads.count
            + appModel.cloud.snoozedThreads.count
            + appModel.cloud.settledThreads.count
    }

    private var visibleSettledThreads: [PathwayAgentThread] {
        Array(appModel.cloud.settledThreads.prefix(settledVisibleCount))
    }

    private var hiddenSettledCount: Int {
        max(0, appModel.cloud.settledThreads.count - visibleSettledThreads.count)
    }

    private var lifecycleRefreshKey: String {
        appModel.cloud.threads.map { thread in
            "\(thread.id):\(thread.shell.updatedAt):\(thread.shell.branch ?? "")"
        }.joined(separator: "|")
    }

    private var providerEnvironments: [PathwayCompanyEnvironment] {
        let ids = Set(appModel.cloud.activeThreads.map { "\($0.companyId):\($0.environmentId)" })
        return appModel.cloud.environments.filter { ids.contains($0.id) }
    }

    private func openPendingThread() async {
        guard appModel.pendingThreadRoute != nil else { return }
        // The launched thread arrives through cloud sync moments after the composer
        // dismisses, so wait for it briefly instead of dropping the navigation.
        for _ in 0 ..< 40 {
            guard !Task.isCancelled, let route = appModel.pendingThreadRoute else { return }
            if let thread = appModel.cloud.threads.first(where: {
                $0.companyId == route.companyId
                    && $0.environmentId == route.environmentId
                    && $0.threadId == route.threadId
            }) {
                appModel.pendingThreadRoute = nil
                routedThreadID = thread.id
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        appModel.pendingThreadRoute = nil
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
                Text("Start a thread in one of your Pathway environments.")
            } actions: {
                Button("New thread", action: newThreadAction)
            }
        }
    }
}

private extension AgentThreadsView {
    private func threadLink(_ thread: PathwayAgentThread) -> some View {
        Button {
            routedThreadID = thread.id
        } label: {
            AgentThreadRow(thread: thread, provider: threadProviders.provider(for: thread))
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(thread.shell.pinnedAt == nil ? "Pin" : "Unpin", systemImage: thread.shell.pinnedAt == nil ? "pin" : "pin.slash") {
                perform(thread.shell.pinnedAt == nil ? .pin : .unpin, on: thread)
            }
            .tint(.orange)

            Button("Sleep", systemImage: "moon.zzz") { sleepingThread = thread }
                .tint(.indigo)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button("Settle", systemImage: "checkmark") { perform(.settle, on: thread) }
                .tint(.green)
        }
        .disabled(threadActions.pendingThreadIDs.contains(thread.id))
        .accessibilityValue(threadActions.pendingThreadIDs.contains(thread.id) ? "Updating" : "")
    }

    private func sleep(_ thread: PathwayAgentThread, hours: Double) {
        perform(.sleep(until: Date().addingTimeInterval(hours * 3600)), on: thread)
    }

    private func perform(_ action: PathwayThreadAction, on thread: PathwayAgentThread) {
        Task {
            await threadActions.perform(
                action,
                thread: thread,
                environments: appModel.cloud.environments,
                connect: appModel.connect
            )
        }
    }

    private func compactThreadLink(
        _ thread: PathwayAgentThread,
        icon: String
    ) -> some View {
        NavigationLink {
            AgentThreadDetailRoute(thread: thread)
        } label: {
            CompactAgentThreadRow(thread: thread, icon: icon)
        }
        .listRowSeparator(.hidden)
        .disabled(threadActions.pendingThreadIDs.contains(thread.id))
    }
}

private struct ThreadLifecycleShelfHeader: View {
    let title: String
    let count: Int
    let isExpanded: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(isExpanded ? title : "\(title) (\(count))")
                    .font(.caption.weight(.medium))

                Rectangle()
                    .frame(height: 1)
                    .opacity(0.25)

                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
            }
            .foregroundStyle(tint)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}

private struct CompactAgentThreadRow: View {
    let thread: PathwayAgentThread
    let icon: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .frame(width: 16)

            Text(thread.shell.title)
                .lineLimit(1)

            Spacer(minLength: 8)

            if let pullRequest = thread.shell.attachedPullRequest {
                AgentThreadPullRequestBadge(pullRequest: pullRequest)
            }

            Text(thread.lifecycleSortDate, format: .relative(presentation: .named))
                .font(.caption)
                .lineLimit(1)
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct AgentThreadRow: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread
    let provider: PathwayThreadProvider?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                projectIcon

                Text(projectName ?? "Project unavailable")
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if thread.shell.pinnedAt != nil {
                    Image(systemName: "pin")
                        .font(.caption2)
                        .accessibilityLabel("Pinned")
                }

                Text(activityAge)
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(Text(thread.sortDate, format: .relative(presentation: .named)))
            }
            .foregroundStyle(.secondary)

            Text(thread.shell.title)
                .font(.body)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                workspaceDetails
                    .frame(maxWidth: .infinity, alignment: .leading)

                statusIndicator

                if let pullRequest = thread.shell.attachedPullRequest {
                    AgentThreadPullRequestBadge(pullRequest: pullRequest)
                        .labelStyle(.titleOnly)
                        .foregroundStyle(.purple)
                        .fixedSize()
                }

                providerIcon
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Open thread")
        .accessibilityCustomContent("Model", thread.shell.modelSelection.model)
        .accessibilityCustomContent("Company", companyName ?? "Unknown")
        .task(id: projectIconContext?.key) {
            guard let context = projectIconContext, let connect = appModel.connect else { return }
            await appModel.projectIcons.load(context, using: connect)
        }
    }

    private var projectIcon: some View {
        Group {
            if let context = projectIconContext, let image = appModel.projectIcons.images[context.key] {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "folder.fill")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(width: 14, height: 14)
        .clipShape(.rect(cornerRadius: 2))
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var providerIcon: some View {
        if let provider {
            Group {
                if let asset = provider.iconAssetName {
                    Image(asset)
                        .resizable()
                        .scaledToFit()
                } else {
                    Text(String(provider.name.prefix(2)).uppercased())
                        .font(.caption2.weight(.medium))
                }
            }
            .frame(width: 16, height: 16)
            .foregroundStyle(provider.driver == "claudeAgent" ? Color(red: 0.85, green: 0.47, blue: 0.34) : .secondary)
            .accessibilityLabel("\(provider.name), \(thread.shell.modelSelection.model)")
        }
    }

    private var projectIconContext: PathwayProjectIconContext? {
        PathwayProjectIconContext(
            thread: thread,
            environments: appModel.cloud.environments,
            bindings: appModel.cloud.environmentBindings
        )
    }

    private var workspaceDetails: some View {
        HStack(spacing: 5) {
            if let branch = thread.shell.branch {
                Text(branch)
                    .fontDesign(.monospaced)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if let environmentName {
                if thread.shell.branch != nil {
                    Text("·")
                }

                Text(environmentName)
                    .lineLimit(1)

                Image(systemName: "server.rack")
                    .font(.caption2)
                    .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        if thread.needsAction {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .foregroundStyle(.orange)
                .accessibilityLabel("Needs you")
        } else if thread.isRunning {
            Image(systemName: "sparkles")
                .foregroundStyle(.blue)
                .accessibilityLabel("Working")
        } else if thread.shell.lastError != nil || thread.shell.status == "error" {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(.red)
                .accessibilityLabel("Thread error")
        }
    }

    private var companyName: String? {
        appModel.cloud.companyName(for: thread.companyId)
    }

    private var activityAge: String {
        let seconds = max(0, Date().timeIntervalSince(thread.sortDate))
        guard seconds >= 60 else { return "now" }
        return Duration.seconds(seconds).formatted(
            .units(allowed: [.days, .hours, .minutes], width: .narrow, maximumUnitCount: 1)
        )
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

private struct AgentThreadPullRequestBadge: View {
    let pullRequest: PathwayPullRequestAttachment

    var body: some View {
        Label("#\(pullRequest.number)", systemImage: "arrow.triangle.pull")
            .lineLimit(1)
            .accessibilityLabel("Attached pull request \(pullRequest.number)")
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.compactThreadChrome) private var compactThreadChrome
    let thread: PathwayAgentThread
    @State private var model: PathwayAgentThreadModel
    @State private var isComposerExpanded = false
    @FocusState private var isComposerFocused: Bool

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
            .simultaneousGesture(
                TapGesture().onEnded { collapseInteractiveChrome() }
            )
            .onScrollPhaseChange { _, phase in
                if phase == .interacting {
                    collapseInteractiveChrome()
                }
            }
            .onChange(of: model.items.last?.id) { _, identifier in
                guard let identifier else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(identifier, anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AgentThreadComposer(
                model: model,
                isExpanded: $isComposerExpanded,
                isFocused: $isComposerFocused,
                modelName: thread.shell.modelSelection.model,
                usesCompactPresentation: compactThreadChrome != nil,
                isNavigationExpanded: compactThreadChrome?.isNavigationExpanded == true
            )
        }
        .navigationTitle(thread.shell.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            compactThreadChrome?.enterThreadDetail()
        }
        .onChange(of: isComposerExpanded, initial: true) { _, isExpanded in
            compactThreadChrome?.setComposerExpanded(isExpanded)
        }
        .task { model.start() }
        .onDisappear {
            compactThreadChrome?.leaveThreadDetail()
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

    private func collapseInteractiveChrome() {
        guard isComposerExpanded || compactThreadChrome?.isNavigationExpanded == true else {
            return
        }
        withAnimation(
            reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation
        ) {
            isComposerExpanded = false
            compactThreadChrome?.collapseNavigation()
        }
        isComposerFocused = false
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
