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
    @State private var queuedThread: PathwayQueuedThread?
    @State private var reviewingThreadID: String?
    @State private var threadProviders = PathwayThreadProviders()
    @State private var threadActions = PathwayThreadActions()
    @State private var sleepingThread: PathwayAgentThread?
    @State private var query = ""
    @State private var listFilter: PathwayThreadListFilter
    @State private var companyFilter = ""
    @State private var environmentFilter = ""
    @State private var projectFilter = ""
    @State private var providerFilter = ""
    @State private var renamingThread: PathwayAgentThread?
    @State private var renameText = ""
    @State private var deletingThread: PathwayAgentThread?
    @State private var attachingThread: PathwayAgentThread?
    @State private var focuses = PathwayFocusModel()
    @State private var creatingFocus = false
    @State private var editingFocus: PathwayFocus?
    @State private var showingNotifications = false

    init(newThreadAction: @escaping () -> Void, initialFilter: PathwayThreadListFilter = .all) {
        self.newThreadAction = newThreadAction
        _listFilter = State(initialValue: initialFilter)
    }

    var body: some View {
        Group {
            if lifecycleThreadCount == 0 {
                emptyState
            } else {
                threadList
            }
        }
        .navigationTitle("Agent Threads")
        .navigationDestination(isPresented: Binding(get: { queuedThread != nil }, set: { if !$0 { queuedThread = nil } })) {
            if let queuedThread { PathwayQueuedThreadView(thread: queuedThread) }
        }
        .searchable(text: $query, prompt: "Search threads")
        .toolbar {
            ToolbarItem(placement: .primaryAction) { focusMenu }
            ToolbarItem(placement: .primaryAction) {
                Button { showingNotifications = true } label: {
                    Image(systemName: focuses.unreadCount > 0 ? "bell.badge" : "bell").frame(minWidth: 44, minHeight: 44)
                }.accessibilityLabel("Notifications, \(focuses.unreadCount) unread")
            }
            ToolbarItem(placement: .primaryAction) { filtersMenu }
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
                AgentThreadDetailRoute(thread: thread, initiallyReviewChanges: reviewingThreadID == thread.id)
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
        .task(id: appModel.cloud.threads.map(\.id)) { await openPendingThread() }
        .task(id: appModel.cloud.threadQueue.threads.map(\.id)) { await openPendingThread() }
        .task(id: appModel.localStorageDirectory) { await focuses.observe(cloud: appModel.cloud, storageDirectory: appModel.localStorageDirectory) }
        .sheet(isPresented: $creatingFocus) { PathwayFocusEditorView(model: focuses) }
        .sheet(item: $editingFocus) { PathwayFocusEditorView(model: focuses, focus: $0) }
        .sheet(isPresented: $showingNotifications) { PathwayFocusNotificationsView(model: focuses) }
        .accessibilityIdentifier("agent-threads-list")
        .sheet(item: $sleepingThread) { thread in
            sleepSheet(for: thread)
        }
        .sheet(item: $attachingThread) { thread in
            PathwayAttachProjectView(thread: thread) { projectID in
                perform(.attachProject(projectID), on: thread)
            }
        }
        .alert("Unfinished Git work", isPresented: Binding(
            get: { threadActions.unfinishedGitThread != nil },
            set: { if !$0 { threadActions.unfinishedGitThread = nil } }
        )) {
            Button("Review changes") {
                if let thread = threadActions.unfinishedGitThread { reviewingThreadID = thread.id; routedThreadID = thread.id }
                threadActions.unfinishedGitThread = nil
            }
            Button("Cancel", role: .cancel) { threadActions.unfinishedGitThread = nil }
            Button("Discard and delete", role: .destructive) {
                if let thread = threadActions.unfinishedGitThread { perform(.discardAndSettle, on: thread) }
                threadActions.unfinishedGitThread = nil
            }
        } message: { Text("This temporary thread has uncommitted changes or unpushed commits. Review and push the work to keep it, or discard it and delete the thread.") }
        .alert("Rename thread", isPresented: Binding(get: { renamingThread != nil }, set: { if !$0 { renamingThread = nil } })) {
            TextField("Thread title", text: $renameText)
            Button("Cancel", role: .cancel) { renamingThread = nil }
            Button("Save") {
                if let thread = renamingThread { perform(.rename(renameText), on: thread) }
                renamingThread = nil
            }.disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Delete thread?", isPresented: Binding(get: { deletingThread != nil }, set: { if !$0 { deletingThread = nil } }), titleVisibility: .visible) {
            Button("Delete thread", role: .destructive) {
                if let thread = deletingThread { perform(.delete, on: thread) }
                deletingThread = nil
            }
            Button("Cancel", role: .cancel) { deletingThread = nil }
        } message: { Text("This permanently deletes the conversation. Archive it instead if you may need it later.") }
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
            ForEach(pendingQueueThreads) { queued in
                Button { queuedThread = queued } label: {
                    if let thread = try? queued.conversationThread(detail: .object(["thread": .object(queued.fields)])) {
                        AgentThreadRow(thread: thread, provider: threadProviders.provider(for: thread))
                    } else {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(queued.title).foregroundStyle(.primary)
                            Text(queued.status).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let cachedAt = appModel.cloud.cachedAt, !appModel.cloud.isConnected {
                Label("Saved \(cachedAt.formatted(date: .abbreviated, time: .shortened))", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if appModel.pendingThreadRoute != nil || appModel.pendingProductLink != nil {
                HStack {
                    ProgressView()
                    Text("Waiting for the thread to sync…")
                    Spacer()
                    Button("Cancel") { appModel.pendingThreadRoute = nil; appModel.pendingProductLink = nil }
                }.font(.footnote)
            }
            if listFilter == .archived {
                ForEach(archivedThreads) { thread in compactThreadLink(thread, icon: "archivebox") }
            } else {
            ForEach(activeThreads) { thread in
                threadLink(thread)
            }

            if !snoozedThreads.isEmpty {
                Section {
                    if isSnoozedExpanded {
                        ForEach(snoozedThreads) { thread in
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
                        count: snoozedThreads.count,
                        isExpanded: isSnoozedExpanded,
                        tint: .blue
                    ) {
                        isSnoozedExpanded.toggle()
                    }
                }
            }

            if !settledThreads.isEmpty {
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
                        count: settledThreads.count,
                        isExpanded: isSettledExpanded,
                        tint: .secondary
                    ) {
                        isSettledExpanded.toggle()
                    }
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

    private var pendingQueueThreads: [PathwayQueuedThread] {
        guard listFilter != .archived else { return [] }
        return appModel.cloud.threadQueue.threads.filter { queued in
            !appModel.cloud.threads.contains {
                $0.companyId == queued.companyID && $0.threadId == queued.threadID && $0.environmentId == queued.environmentID
            }
        }
    }

    private var lifecycleThreadCount: Int {
        if !pendingQueueThreads.isEmpty { return pendingQueueThreads.count }
        if appModel.pendingThreadRoute != nil || appModel.pendingProductLink != nil { return 1 }
        return listFilter == .archived ? archivedThreads.count : activeThreads.count + snoozedThreads.count + settledThreads.count
    }

    private var visibleSettledThreads: [PathwayAgentThread] {
        Array(settledThreads.prefix(settledVisibleCount))
    }

    private var hiddenSettledCount: Int {
        max(0, settledThreads.count - visibleSettledThreads.count)
    }

    private var lifecycleRefreshKey: String {
        appModel.cloud.threads.map { thread in
            "\(thread.id):\(thread.shell.branch ?? ""):\(thread.shell.worktreePath ?? ""):\(thread.shell.projectId ?? ""):\(thread.shell.linkedPullRequests.map(\.url).joined(separator: ",")):\((thread.shell.detachedPullRequestUrls ?? []).joined(separator: ",")):\(thread.isRunning):\(thread.shell.latestRunCompletedAt ?? "")"
        }.joined(separator: "|")
    }

    private var providerEnvironments: [PathwayCompanyEnvironment] {
        let ids = Set(appModel.cloud.activeThreads.map { "\($0.companyId):\($0.environmentId)" })
        return appModel.cloud.environments.filter { ids.contains($0.id) }
    }

    private var activeThreads: [PathwayAgentThread] { appModel.cloud.activeThreads.filter(matches) }
    private var snoozedThreads: [PathwayAgentThread] { appModel.cloud.snoozedThreads.filter(matches) }
    private var settledThreads: [PathwayAgentThread] { appModel.cloud.settledThreads.filter(matches) }
    private var archivedThreads: [PathwayAgentThread] { appModel.cloud.threads.filter { $0.shell.archivedAt != nil && matches($0) } }

    private func matches(_ thread: PathwayAgentThread) -> Bool {
        if !focuses.includes(thread) { return false }
        if !companyFilter.isEmpty && thread.companyId != companyFilter { return false }
        if !environmentFilter.isEmpty && "\(thread.companyId):\(thread.environmentId)" != environmentFilter { return false }
        if !projectFilter.isEmpty && "\(thread.companyId):\(thread.cloudProjectId ?? "")" != projectFilter { return false }
        if !providerFilter.isEmpty && thread.shell.providerInstanceId != providerFilter { return false }
        if listFilter == .running && !thread.isRunning { return false }
        if listFilter == .needsAttention && !thread.needsAction { return false }
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            let searchable = [thread.shell.title, thread.shell.branch ?? "", thread.shell.providerInstanceId,
                appModel.cloud.projectName(companyId: thread.companyId, projectId: thread.cloudProjectId) ?? "",
                appModel.cloud.environmentLabel(companyId: thread.companyId, environmentId: thread.environmentId) ?? ""].joined(separator: " ")
            if !searchable.localizedStandardContains(text) { return false }
        }
        return true
    }

    private var focusMenu: some View {
        Menu {
            Picker("Focus", selection: $focuses.selectedID) {
                Text("All threads").tag("all")
                ForEach(focuses.focuses) { Text($0.name).tag($0.id) }
                if focuses.selectedID != "all" && !focuses.focuses.contains(where: { $0.id == focuses.selectedID }) {
                    Text("Unavailable Focus").tag(focuses.selectedID)
                }
            }
            Button("New Focus", systemImage: "plus") { creatingFocus = true }
            ForEach(focuses.focuses) { focus in
                Menu(focus.name) {
                    Button("Edit") { editingFocus = focus }
                    Button("Move up") { Task { await focuses.move(focus, offset: -1, cloud: appModel.cloud) } }
                    Button("Move down") { Task { await focuses.move(focus, offset: 1, cloud: appModel.cloud) } }
                }
            }
            if let error = focuses.errorMessage { Text(error) }
        } label: { Image(systemName: "target").frame(minWidth: 44, minHeight: 44) }
        .accessibilityLabel("Choose or manage Focus")
    }

    private var filtersMenu: some View {
        Menu {
            Picker("Status", selection: $listFilter) { ForEach(PathwayThreadListFilter.allCases) { Text($0.title).tag($0) } }
            Picker("Workspace", selection: $companyFilter) {
                Text("All workspaces").tag("")
                ForEach(appModel.cloud.companies) { Text($0.name).tag($0.id) }
            }
            Picker("Environment", selection: $environmentFilter) {
                Text("All environments").tag("")
                ForEach(appModel.cloud.environments) { Text($0.environment.label).tag($0.id) }
            }
            Picker("Project", selection: $projectFilter) {
                Text("All projects").tag("")
                ForEach(appModel.cloud.projects) { Text($0.project.name).tag($0.id) }
            }
            Picker("Provider", selection: $providerFilter) {
                Text("All providers").tag("")
                ForEach(Array(Set(appModel.cloud.threads.map(\.shell.providerInstanceId))).sorted(), id: \.self) { Text($0).tag($0) }
            }
            Button("Clear filters") {
                query = ""; listFilter = .all; companyFilter = ""; environmentFilter = ""; projectFilter = ""; providerFilter = ""
            }
        } label: { Image(systemName: "line.3.horizontal.decrease").frame(minWidth: 44, minHeight: 44) }
        .accessibilityLabel("Filter threads")
    }

    @ViewBuilder private func threadMenu(_ thread: PathwayAgentThread) -> some View {
        Button("Rename", systemImage: "pencil") { renameText = thread.shell.title; renamingThread = thread }
        if thread.shell.isTemporary {
            Button("Keep conversation", systemImage: "tray.and.arrow.down") { perform(.keepConversation, on: thread) }
                .disabled(!supportsConversations(thread))
        }
        Button(thread.shell.settleAfterCompletion == true ? "Cancel settle after completion" : "Settle after completion", systemImage: "checkmark.circle") {
            perform(.settleAfterCompletion(thread.shell.settleAfterCompletion != true), on: thread)
        }
        if thread.shell.isConversation {
            Button("Attach project", systemImage: "folder.badge.plus") { attachingThread = thread }
                .disabled(!thread.canAttachProject || !supportsConversations(thread))
        }
        if thread.shell.archivedAt != nil {
            Button("Restore", systemImage: "tray.and.arrow.up") { perform(.restore, on: thread) }
        } else {
            Button(thread.shell.pinnedAt == nil ? "Pin" : "Unpin", systemImage: "pin") { perform(thread.shell.pinnedAt == nil ? .pin : .unpin, on: thread) }
            if thread.shell.pinnedAt != nil {
                Button("Move up", systemImage: "arrow.up") { movePinned(thread, offset: -1) }
                Button("Move down", systemImage: "arrow.down") { movePinned(thread, offset: 1) }
            }
            Button("Archive", systemImage: "archivebox") { perform(.archive, on: thread) }.disabled(thread.isRunning)
        }
        Button("Delete", systemImage: "trash", role: .destructive) { deletingThread = thread }.disabled(thread.isRunning)
    }

    private func movePinned(_ thread: PathwayAgentThread, offset: Int) {
        var ordered = appModel.cloud.activeThreads.filter { $0.shell.pinnedAt != nil }
        guard let index = ordered.firstIndex(where: { $0.id == thread.id }), ordered.indices.contains(index + offset) else { return }
        ordered.swapAt(index, index + offset)
        let writes = PathwayThreadOrder.plan(ordered: ordered, movedID: thread.id)
        Task {
            threadActions.errorMessage = nil
            for (target, key) in writes {
                await threadActions.perform(.reorder(key), thread: target, environments: appModel.cloud.environments, connect: appModel.connect)
                if threadActions.errorMessage != nil { return }
            }
        }
    }

    private func supportsConversations(_ thread: PathwayAgentThread) -> Bool {
        appModel.cloud.environments.first {
            $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId
        }?.environment.descriptor.capabilities?["threadConversations"]?.boolValue == true
    }

    private func openPendingThread() async {
        guard !Task.isCancelled, let route = appModel.pendingThreadRoute else { return }
        if let pending = pendingQueueThreads.first(where: { $0.companyID == route.companyId && $0.threadID == route.threadId }) {
            appModel.pendingThreadRoute = nil
            queuedThread = pending
            return
        }
            if let thread = appModel.cloud.threads.first(where: {
                $0.companyId == route.companyId
                    && $0.environmentId == route.environmentId
                    && $0.threadId == route.threadId
            }) {
                appModel.pendingThreadRoute = nil
                routedThreadID = thread.id
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
        .contextMenu { threadMenu(thread) }
    }

    private func sleepSheet(for thread: PathwayAgentThread) -> some View {
        NavigationStack {
            List {
                Button("For 1 hour") { sleep(thread, hours: 1) }
                Button("For 3 hours") { sleep(thread, hours: 3) }
                Button("For 1 day") { sleep(thread, hours: 24) }
                Button("For 1 week") { sleep(thread, hours: 168) }
            }
            .navigationTitle("Sleep thread")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                Button("Cancel", role: .cancel) { sleepingThread = nil }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
                    .padding()
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCompactAdaptation(.sheet)
        .accessibilityIdentifier("sleep-thread-sheet")
    }

    private func sleep(_ thread: PathwayAgentThread, hours: Double) {
        sleepingThread = nil
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
        .contextMenu { threadMenu(thread) }
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

            if let pullRequest = thread.shell.linkedPullRequests.first {
                AgentThreadPullRequestBadge(thread: thread, pullRequest: pullRequest)
            }

            Text(PathwayGeneralPreferences.shared.absoluteTimestamps ? thread.lifecycleSortDate.formatted(date: .abbreviated, time: .shortened) : thread.lifecycleSortDate.formatted(.relative(presentation: .named)))
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

                Text(thread.shell.isConversation ? "Conversation" : projectName ?? "Project unavailable")
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if thread.shell.pinnedAt != nil {
                    Image(systemName: "pin")
                        .font(.caption2)
                        .accessibilityLabel("Pinned")
                }
                if thread.shell.isTemporary {
                    Image(systemName: "clock.badge.xmark").font(.caption2).accessibilityLabel("Temporary")
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

                if let pullRequest = thread.shell.linkedPullRequests.first {
                    AgentThreadPullRequestBadge(thread: thread, pullRequest: pullRequest)
                        .labelStyle(.titleOnly)
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
                Image(systemName: thread.shell.isConversation ? "bubble.left.and.bubble.right" : "folder.fill")
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
        if let queued = appModel.cloud.threadQueue.threads.first(where: {
            $0.companyID == thread.companyId && $0.threadID == thread.threadId && $0.state != "delivered"
        }) {
            Text(queued.status).font(.caption).foregroundStyle(.secondary)
        } else if thread.needsAction {
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
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread
    let pullRequest: PathwayPullRequestAttachment

    private var status: PathwayThreadChangeRequestStatus {
        appModel.cloud.changeRequestStatuses[thread.id] ?? .init()
    }

    private var color: Color {
        if status.state == .merged { return .purple }
        if status.state == .closed || status.checksFailed { return .red }
        if status.unavailable || status.checksPending { return .orange }
        if status.state == .open && !status.isDraft { return .green }
        return .secondary
    }

    var body: some View {
        Menu {
            ForEach(thread.shell.linkedPullRequests, id: \.url) { pr in
                if let url = URL(string: pr.url) {
                    let state = appModel.cloud.threadPullRequestStatuses[thread.id]?[pr.url]?.label ?? "Attached"
                    Link("#\(pr.number) · \(state)", destination: url)
                }
            }
        } label: {
            Label(thread.shell.linkedPullRequests.count > 1 ? "\(thread.shell.linkedPullRequests.count) PRs" : "#\(pullRequest.number)", systemImage: "arrow.triangle.pull")
                .foregroundStyle(color).lineLimit(1)
        }
        .accessibilityLabel("Pull requests, \(status.label)")
    }
}

struct AgentThreadDetailRoute: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread
    var initiallyReviewChanges = false

    var body: some View {
        if let connect = appModel.connect, let environment {
            AgentThreadConversationView(
                thread: thread,
                environment: environment,
                connect: connect,
                workspaceRoot: appModel.cloud.environmentBindings.first {
                    $0.companyId == thread.companyId && $0.binding.environmentId == thread.environmentId
                        && $0.binding.localProjectId == thread.shell.projectId
                }?.binding.localWorkspaceRoot ?? thread.shell.conversationPath,
                storageDirectory: appModel.localStorageDirectory,
                initiallyReviewChanges: initiallyReviewChanges
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
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
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
    @State private var isUpdatingLifecycle = false
    @State private var showsAttachment = false
    @State private var showsUnfinishedGit = false
    @State private var showsGitReview = false
    @State private var showsAlternateEnvironment = false
    @State private var showsQueueMove = false
    @FocusState private var isComposerFocused: Bool

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient, workspaceRoot: String? = nil, storageDirectory: URL? = nil, initiallyReviewChanges: Bool = false) {
        self.workspaceRoot = workspaceRoot
        _model = State(initialValue: PathwayAgentThreadModel(thread: thread, environment: environment, connect: connect, storageDirectory: storageDirectory))
        _showsGitReview = State(initialValue: initiallyReviewChanges)
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
                    if let queued = queuedConversation, queued.state != "delivered" {
                        HStack {
                            Label(queued.status, systemImage: "tray.and.arrow.up")
                            Spacer()
                            Menu {
                                Button("Try syncing again", systemImage: "arrow.clockwise") { appModel.cloud.threadQueue.retry() }
                                if queued.fields["acceptedAt"] == .null, queued.fields["launch"] != .null {
                                    Button("Move to another environment", systemImage: "desktopcomputer") { showsQueueMove = true }
                                }
                            } label: { Image(systemName: "ellipsis") }
                            .accessibilityLabel("Message delivery actions")
                        }
                        .font(.footnote).foregroundStyle(.secondary)
                        if model.environment.environment.descriptor.capabilities?["durableThreadQueue"]?.boolValue != true {
                            Text("Update Pathway on this environment to run queued messages.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if let error = model.cloudQueueError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                    AgentThreadTranscript(model: model, onOpenChild: openChild)
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
            }
            .defaultScrollAnchor(.bottom)
            #if !os(visionOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
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
            .onChange(of: model.conversationItems.last?.text) { _, _ in
                if followsLatest && !userIsScrolling { proxy.scrollTo("agent-transcript-bottom", anchor: .bottom) }
            }
            .onChange(of: model.conversationItems.last?.id) { _, _ in
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
                        .labelStyle(.iconOnly)
                        #if os(visionOS)
                        .buttonStyle(.bordered)
                        #else
                        .buttonStyle(.glass)
                        #endif
                        .buttonBorderShape(.circle)
                        .accessibilityIdentifier("agent-thread-jump-bottom")
                    }
            }
            .safeAreaInset(edge: .bottom, spacing: 4) {
                VStack(spacing: 8) {
                    if let connect = appModel.connect {
                        PathwayConversationStorageNotice(environment: model.environment, connect: connect, threadID: model.thread.threadId, isStartingConversation: false,
                            chooseEnvironment: { showsAlternateEnvironment = true },
                            onAvailabilityChanged: { model.storageAllowsSend = $0 })
                            .id(model.environment.id)
                    }
                    HStack(spacing: 8) {
                    if !changedItems.isEmpty {
                        Button { showsChanges = true } label: {
                            HStack(spacing: 8) {
                                Text("\(changedFileCount) \(changedFileCount == 1 ? "file" : "files")")
                                Text("+\(changedItems.reduce(0) { $0 + ($1.additions ?? 0) })").foregroundStyle(.green)
                                Text("−\(changedItems.reduce(0) { $0 + ($1.deletions ?? 0) })").foregroundStyle(.red)
                            }.font(.caption).monospacedDigit()
                        }
                        #if os(visionOS)
                        .buttonStyle(.bordered)
                        #else
                        .buttonStyle(.glass)
                        #endif
                        .buttonBorderShape(.capsule)
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
                    if model.thread.shell.isTemporary {
                        Button("Keep conversation", systemImage: "tray.and.arrow.down") { performLifecycle(.keepConversation) }
                            .disabled(isUpdatingLifecycle || !model.supportsConversations)
                    }
                    if model.thread.shell.isConversation {
                        Button("Attach project", systemImage: "folder.badge.plus") { showsAttachment = true }
                            .disabled(!model.thread.canAttachProject || model.activeRunID != nil || model.isSending || isUpdatingLifecycle || !model.supportsConversations)
                    }
                    Button("Settle", systemImage: "checkmark") { performLifecycle(.settle) }
                        .disabled(model.activeRunID != nil || model.isSending || isUpdatingLifecycle)
                    Button(model.thread.shell.settleAfterCompletion == true ? "Cancel settle after completion" : "Settle after completion", systemImage: "checkmark.circle") {
                        performLifecycle(.settleAfterCompletion(model.thread.shell.settleAfterCompletion != true))
                    }.disabled(isUpdatingLifecycle)
                    if let workspaceRoot = currentWorkspaceRoot, let connect = model.connect {
                        NavigationLink {
                            PathwayWorkspaceDestination(thread: model.thread, environment: model.environment,
                                projectRoot: workspaceRoot, connect: connect, storageDirectory: model.storageDirectory)
                        } label: { Label("Workspace", systemImage: "folder") }
                    }
                    Button("Fork thread", systemImage: "arrow.triangle.branch") { fork() }.disabled(isForking || model.thread.shell.isTemporary)
                    if model.thread.shell.isTemporary { Text("Keep conversation before forking or starting a side chat.") }
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
        .sheet(isPresented: $showsAlternateEnvironment) {
            NewAgentThreadView(initialPrompt: model.draft)
        }
        .sheet(isPresented: $showsAttachment) {
            PathwayAttachProjectView(thread: model.thread) { performLifecycle(.attachProject($0)) }
        }
        .alert("Unfinished Git work", isPresented: $showsUnfinishedGit) {
            Button("Review changes") { showsGitReview = true }
            Button("Cancel", role: .cancel) {}
            Button("Discard and delete", role: .destructive) { performLifecycle(.discardAndSettle) }
        } message: { Text("This temporary thread has uncommitted changes or unpushed commits. Review and push the work to keep it, or discard it and delete the thread.") }
        .navigationDestination(isPresented: $showsGitReview) {
            if let root = currentWorkspaceRoot, let connect = model.connect {
                PathwayWorkspaceDestination(thread: model.thread, environment: model.environment,
                    projectRoot: root, connect: connect, storageDirectory: model.storageDirectory, initialSection: "changes")
            }
        }
        .navigationDestination(item: $childDestination) { destination in
            AgentThreadConversationView(model: destination.model, workspaceRoot: destination.workspaceRoot)
        }
        .alert("Couldn’t open thread", isPresented: Binding(get: { navigationError != nil }, set: { if !$0 { navigationError = nil } })) {
            Button("OK") { navigationError = nil }
        } message: { Text(navigationError ?? "") }
        .onAppear { compactThreadChrome?.enterThreadDetail() }
        .onChange(of: isComposerExpanded, initial: true) { _, expanded in compactThreadChrome?.setComposerExpanded(expanded) }
        .onChange(of: model.thread.shell.deletedAt) { _, deletedAt in
            if deletedAt != nil { dismiss() }
        }
        .task { model.threadQueue = appModel.cloud.threadQueue; model.start() }
        .task(id: model.environment.id) {
            if model.providers.isEmpty { await model.loadSavedQueueProviders(using: appModel.cloud.threadQueue, companyID: model.thread.companyId) }
        }
        .task(id: queuedConversation) {
            model.threadQueue = appModel.cloud.threadQueue
            if let queued = queuedConversation { await model.updateCloudQueue(queued) }
        }
        .task(id: appModel.cloud.threads.contains { $0.companyId == model.thread.companyId && $0.threadId == model.threadID }) {
            if model.cloudQueuedThread != nil, !model.isSubscriptionReady {
                await model.stop()
                guard !Task.isCancelled else { return }
                model.start()
            }
        }
        .sheet(isPresented: $showsQueueMove) {
            if let queued = queuedConversation { PathwayQueuedThreadMoveView(thread: queued) }
        }
        .onDisappear {
            compactThreadChrome?.leaveThreadDetail()
            Task { await model.stop() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-conversation")
    }

    private var changedFileCount: Int { Set(changedItems.compactMap(\.fileName)).count }
    private var currentWorkspaceRoot: String? {
        if let projectID = model.thread.shell.projectId {
            return appModel.cloud.environmentBindings.first {
                $0.binding.environmentId == model.thread.environmentId
                    && $0.binding.localProjectId == projectID && $0.binding.status == "active"
            }?.binding.localWorkspaceRoot ?? workspaceRoot
        }
        return model.thread.shell.conversationPath ?? workspaceRoot
    }
    private func performLifecycle(_ action: PathwayThreadAction) {
        guard !isUpdatingLifecycle else { return }
        isUpdatingLifecycle = true
        Task {
            defer { isUpdatingLifecycle = false }
            do {
                _ = try await model.request("orchestration.dispatchCommand", payload: action.command(threadID: model.threadID),
                    reportsErrors: false, requiresSubscription: true)
                if model.thread.shell.isTemporary && (action == .settle || action == .discardAndSettle) {
                    dismiss()
                } else {
                    let projection = try await model.request("orchestration.getThreadProjection", payload: .object(["threadId": .string(model.threadID)]))
                    model.installSnapshot(projection)
                }
            } catch {
                if action == .settle && model.thread.shell.isTemporary && PathwayThreadActions.requiresDiscardConfirmation(error) {
                    showsUnfinishedGit = true
                } else { navigationError = error.localizedDescription }
            }
        }
    }
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
    private var queuedConversation: PathwayQueuedThread? {
        appModel.cloud.threadQueue.threads.first { $0.companyID == model.thread.companyId && $0.threadID == model.threadID }
    }

    @ViewBuilder private var connectionBanner: some View {
        if queuedConversation != nil, !model.isSubscriptionReady {
            Label(model.items.isEmpty ? "Messages will appear here when the environment reconnects." : "Showing saved messages while the environment reconnects", systemImage: "wifi.slash")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
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
}

private struct AgentThreadDestination: Hashable {
    let id = UUID()
    let model: PathwayAgentThreadModel
    let workspaceRoot: String?
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
