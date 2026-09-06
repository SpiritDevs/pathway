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
                connect: connect,
                workspaceRoot: appModel.cloud.environmentBindings.first {
                    $0.companyId == thread.companyId && $0.binding.environmentId == thread.environmentId
                        && $0.binding.localProjectId == thread.shell.projectId
                }?.binding.localWorkspaceRoot
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

struct AgentThreadConversationView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.compactThreadChrome) private var compactThreadChrome
    @State private var model: PathwayAgentThreadModel
    @State private var isComposerExpanded = false
    @State private var isNearBottom = true
    @State private var followsLatest = true
    @State private var userIsScrolling = false
    private let workspaceRoot: String?
    @State private var childDestination: AgentThreadDestination?
    @State private var isOpeningChild = false
    @State private var showsChanges = false
    @State private var navigationError: String?
    @State private var isForking = false
    @FocusState private var isComposerFocused: Bool

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient, workspaceRoot: String? = nil) {
        self.workspaceRoot = workspaceRoot
        _model = State(initialValue: PathwayAgentThreadModel(thread: thread, environment: environment, connect: connect))
    }

    init(model: PathwayAgentThreadModel, workspaceRoot: String? = nil) {
        self.workspaceRoot = workspaceRoot
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    connectionBanner
                    AgentThreadTranscript(model: model, onOpenChild: openChild)
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height <= geometry.visibleRect.height
                    || geometry.visibleRect.maxY >= geometry.contentSize.height - 100
            } action: { _, value in
                isNearBottom = value
                if userIsScrolling { followsLatest = value }
            }
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { userIsScrolling = true }
                if phase == .idle && userIsScrolling {
                    followsLatest = isNearBottom
                    userIsScrolling = false
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                if old != new && followsLatest && !userIsScrolling && model.activeRunID != nil {
                    proxy.scrollTo("agent-transcript-bottom", anchor: .bottom)
                }
            }
            .onChange(of: model.items.last?.text) { _, _ in
                if followsLatest && !userIsScrolling { proxy.scrollTo("agent-transcript-bottom", anchor: .bottom) }
            }
            .onChange(of: model.items.last?.id) { _, _ in
                if followsLatest && !userIsScrolling { proxy.scrollTo("agent-transcript-bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottom) {
                    if !isNearBottom {
                        Button("Latest message", systemImage: "arrow.down") {
                            followsLatest = true
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                                proxy.scrollTo("agent-transcript-bottom", anchor: .bottom)
                            }
                        }
                        .labelStyle(.iconOnly).buttonStyle(.glass).buttonBorderShape(.circle)
                        .accessibilityIdentifier("agent-thread-jump-bottom")
                    }
            }
            .safeAreaInset(edge: .bottom, spacing: 4) {
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                    if !changedItems.isEmpty {
                        Button { showsChanges = true } label: {
                            HStack(spacing: 8) {
                                Text("\(changedFileCount) \(changedFileCount == 1 ? "file" : "files")")
                                Text("+\(changedItems.reduce(0) { $0 + ($1.additions ?? 0) })").foregroundStyle(.green)
                                Text("−\(changedItems.reduce(0) { $0 + ($1.deletions ?? 0) })").foregroundStyle(.red)
                            }.font(.caption).monospacedDigit()
                        }
                        .buttonStyle(.glass).buttonBorderShape(.capsule)
                        .accessibilityIdentifier("agent-thread-changes")
                    }
                        AgentThreadSubagentPicker(model: model, openThread: openChild)
                    }
                    AgentThreadComposer(model: model, isExpanded: $isComposerExpanded,
                        isFocused: $isComposerFocused, modelName: model.currentModelSelection.model,
                        usesCompactPresentation: true, isNavigationExpanded: false, onOpenThread: openChild, workspaceRoot: workspaceRoot)
                }
            }
        }
        .navigationTitle(model.threadTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.threadTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(model.environmentLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .accessibilityIdentifier("agent-thread-heading")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Write message", systemImage: "square.and.pencil") {
                    isComposerExpanded = true; isComposerFocused = true
                }
                Menu {
                    Button("Fork thread", systemImage: "arrow.triangle.branch") { fork() }.disabled(isForking)
                    Button("Copy conversation", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = model.items.filter(\.isConversation).compactMap(\.text).joined(separator: "\n\n")
                    }
                    if !model.subagents.isEmpty {
                        Section("Subagents") {
                            ForEach(model.subagents) { agent in
                                if let id = agent.childThreadID {
                                    Button(agent.title, systemImage: "person.crop.square") { openChild(id) }
                                        .accessibilityIdentifier("agent-thread-open-child-\(id)")
                                }
                            }
                        }
                    }
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("Thread actions").accessibilityIdentifier("agent-thread-actions")
            }
        }
        .sheet(isPresented: $showsChanges) { AgentThreadChangesView(model: model) }
        .navigationDestination(item: $childDestination) { destination in
            AgentThreadConversationView(model: destination.model, workspaceRoot: destination.workspaceRoot)
        }
        .alert("Couldn’t open thread", isPresented: Binding(get: { navigationError != nil }, set: { if !$0 { navigationError = nil } })) {
            Button("OK") { navigationError = nil }
        } message: { Text(navigationError ?? "") }
        .onAppear { compactThreadChrome?.enterThreadDetail() }
        .onChange(of: isComposerExpanded, initial: true) { _, expanded in compactThreadChrome?.setComposerExpanded(expanded) }
        .task { model.start() }
        .onDisappear {
            compactThreadChrome?.leaveThreadDetail()
            Task { await model.stop() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-conversation")
    }

    private var changedFileCount: Int { Set(changedItems.compactMap(\.fileName)).count }
    private var changedItems: [PathwayTimelineItem] { model.items.filter { $0.type == "file_change" } }
    private func openChild(_ id: String) {
        guard !isOpeningChild else { return }
        isComposerFocused = false
        isOpeningChild = true
        Task {
            defer { isOpeningChild = false }
            do {
                let child = try await model.makeChildModel(threadID: id)
                childDestination = AgentThreadDestination(model: child, workspaceRoot: model.thread.shell.worktreePath ?? workspaceRoot)
            } catch { navigationError = error.localizedDescription }
        }
    }
    private func fork() {
        isForking = true
        Task {
            defer { isForking = false }
            do { openChild(try await model.fork()) }
            catch { navigationError = error.localizedDescription }
        }
    }
    @ViewBuilder private var connectionBanner: some View {
        switch model.connectionState {
        case .connecting:
            HStack(spacing: 8) { ProgressView(); Text("Connecting to the environment…") }
                .font(.footnote).foregroundStyle(.secondary)
        case .cached:
            Label("Showing saved messages while the environment reconnects", systemImage: "wifi.slash")
                .font(.footnote).foregroundStyle(.secondary)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
        default: EmptyView()
        }
    }
}

private struct AgentThreadDestination: Hashable {
    let id = UUID()
    let model: PathwayAgentThreadModel
    let workspaceRoot: String?
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
