import SwiftUI

struct PathwayEnvironmentStorageView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var models: [String: PathwayEnvironmentStorageModel] = [:]
    @State private var environmentFilter: Set<String> = []
    @State private var search = ""
    @State private var showAll = false
    @State private var reviewing = false
    @State private var preparingReview = false
    @State private var reviewModels: [PathwayEnvironmentStorageModel] = []

    private var visibleModels: [PathwayEnvironmentStorageModel] {
        appModel.cloud.environments.compactMap { models[$0.id] }.filter {
            environmentFilter.isEmpty || environmentFilter.contains($0.id)
        }
    }

    var body: some View {
        Form {
            Section {
                Menu {
                    Button("All environments") { environmentFilter = [] }
                    ForEach(appModel.cloud.environments) { environment in
                        Toggle(environment.environment.label, isOn: Binding(
                            get: { environmentFilter.contains(environment.id) },
                            set: { if $0 { environmentFilter.insert(environment.id) } else { environmentFilter.remove(environment.id) } }
                        ))
                    }
                } label: {
                    Label(environmentFilter.isEmpty ? "All environments" : "\(environmentFilter.count) environments", systemImage: "line.3.horizontal.decrease")
                }
                Toggle("All threads, including active", isOn: $showAll)
                HStack {
                    Button("Select visible worktrees") {
                        for model in visibleModels {
                            let ids = (model.snapshot?.threads ?? []).filter {
                                (showAll || $0.status != "active") && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
                            }.compactMap(\.worktreeId)
                            let existing = Set((model.snapshot?.worktrees ?? []).filter { !$0.removed && $0.kind == "worktree" }.map(\.id))
                            model.selectedWorktrees.formUnion(ids.filter(existing.contains))
                        }
                    }
                    Spacer()
                    Button("Clear selection") { for model in visibleModels { model.selectedWorktrees = [] } }
                }.font(.caption)
                Button("Review selected worktrees") {
                    let targets = visibleModels.filter { !$0.selectedWorktrees.isEmpty }.map { ($0, Array($0.selectedWorktrees)) }
                    Task { await prepareReview(targets) }
                }
                .disabled(preparingReview || visibleModels.allSatisfy { $0.selectedWorktrees.isEmpty || $0.performingAction })
            } footer: {
                Text("Cleanup removes the entire worktree, including ignored files. Conversation history and branches are kept. Sizes are estimates; shared worktrees are counted once.")
            }
            ForEach(visibleModels) { model in
                PathwayStorageEnvironmentSection(model: model, search: search, showAll: showAll, review: { ids in
                    Task { await prepareReview([(model, ids)]) }
                })
            }
            if appModel.cloud.environments.isEmpty {
                ContentUnavailableView("No environments", systemImage: "externaldrive", description: Text("Connect an environment to view its storage."))
            }
            Section("This device") {
                NavigationLink("Downloaded history") { PathwayStorageSettingsView() }
            }
        }
        .navigationTitle("Storage & cleanup")
        .searchable(text: $search, prompt: "Search threads and worktrees")
        .task(id: appModel.cloud.environments.map(\.id)) {
            guard let connect = appModel.connect else { return }
            let ids = Set(appModel.cloud.environments.map(\.id))
            models = models.filter { ids.contains($0.key) }
            for environment in appModel.cloud.environments where models[environment.id] == nil {
                models[environment.id] = PathwayEnvironmentStorageModel(environment: environment, connect: connect, storageDirectory: appModel.localStorageDirectory)
                models[environment.id]?.setVisibility(cloud: appModel.cloud)
            }
        }
        .refreshable { for model in visibleModels { model.setVisibility(cloud: appModel.cloud); await model.refresh() } }
        .sheet(isPresented: $reviewing, onDismiss: { reviewModels = [] }) {
            NavigationStack {
                List {
                    Text("Remove the selected entire worktrees, including ignored files? History and branches remain. Each environment rechecks eligibility before removal.")
                    ForEach(reviewModels) { model in
                        if let preview = model.preview {
                            Section(model.environment.environment.label) {
                                Text("Estimated recovery: \(pathwayStorageBytes(preview.estimatedBytes))")
                                ForEach(preview.items) { item in
                                    VStack(alignment: .leading) {
                                        Text(item.path).font(.caption).lineLimit(2)
                                        Text(item.eligible ? pathwayStorageBytes(item.estimatedBytes) : item.blockers.joined(separator: ", "))
                                            .foregroundStyle(item.eligible ? Color.secondary : .orange)
                                    }
                                }
                            }
                        }
                        if let error = model.error { Text("\(model.environment.environment.label): \(error)").foregroundStyle(.red) }
                    }
                    Button("Reclaim selected worktrees", role: .destructive) {
                        let selected = reviewModels.compactMap { model -> (PathwayEnvironmentStorageModel, [String])? in
                            let ids = model.preview?.items.filter(\.eligible).map(\.worktreeId) ?? []
                            return ids.isEmpty ? nil : (model, ids)
                        }
                        reviewing = false
                        for (model, ids) in selected { Task { await model.start(ids: ids) } }
                    }
                    .disabled(!reviewModels.contains { $0.preview?.items.contains(where: \.eligible) == true })
                }
                .navigationTitle("Review cleanup")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { reviewing = false } } }
            }
        }
    }

    private func prepareReview(_ targets: [(PathwayEnvironmentStorageModel, [String])]) async {
        guard !preparingReview else { return }
        preparingReview = true
        defer { preparingReview = false }
        reviewModels = targets.map(\.0)
        for (model, ids) in targets { await model.prepare(ids: ids) }
        reviewing = true
    }
}

private struct PathwayStorageEnvironmentSection: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Bindable var model: PathwayEnvironmentStorageModel
    let search: String
    let showAll: Bool
    let review: ([String]) -> Void
    @State private var editingPolicy = false

    private var threads: [PathwayStorageThread] {
        (model.snapshot?.threads ?? []).filter {
            (showAll || $0.status != "active") && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
        }
    }
    private var orphans: [PathwayStorageWorktree] {
        (model.snapshot?.worktrees ?? []).filter {
            $0.kind == "orphan" && !$0.removed && (search.isEmpty || $0.path.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        Section {
            if let snapshot = model.snapshot {
                ForEach(snapshot.volumes) { volume in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(volume.path).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(volume.pressure.capitalized).foregroundStyle(volume.pressure == "critical" ? Color.red : volume.pressure == "warning" ? .orange : .secondary)
                        }
                        ProgressView(value: volume.usedFraction).tint(volume.pressure == "critical" ? .red : .accentColor)
                            .accessibilityLabel("Used capacity")
                        Text("\(pathwayStorageBytes(volume.availableBytes)) free of \(pathwayStorageBytes(volume.totalBytes))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("Measured \(snapshot.sampledAt)").font(.caption).foregroundStyle(.secondary)
                if let error = snapshot.scanError { Text(error).font(.caption).foregroundStyle(.orange) }
                Button(snapshot.policy.enabled ? "Scheduled cleanup: \(snapshot.policy.afterDays) days" : "Scheduled cleanup: off") { editingPolicy = true }
                if threads.isEmpty { Text("No matching threads").foregroundStyle(.secondary) }
                ForEach(threads) { thread in
                    PathwayStorageThreadRow(model: model, thread: thread,
                        worktree: snapshot.worktrees.first { $0.id == thread.worktreeId })
                }
                if !orphans.isEmpty {
                    DisclosureGroup("Unlinked worktrees · \(orphans.count)") {
                        ForEach(orphans) { worktree in
                            Toggle(isOn: selection(worktree.id)) {
                                VStack(alignment: .leading) {
                                    Text(worktree.path).font(.caption).lineLimit(2)
                                    Text(pathwayStorageBytes(worktree.estimatedBytes)).foregroundStyle(.secondary)
                                    Text(worktree.blockers.joined(separator: ", ")).font(.caption).foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }
                DisclosureGroup("Cleanup history") {
                    ForEach(snapshot.jobs.reversed()) { job in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(job.mode.capitalized) · \(job.status)")
                            Text("Free-space change: \(pathwayStorageBytes(job.actualFreeDeltaBytes))").font(.caption)
                            Text(job.startedAt).font(.caption).foregroundStyle(.secondary)
                            ForEach(job.items.filter { $0.status == "failed" || $0.status == "skipped" }) { item in
                                Text("\(item.worktreeId): \(item.message ?? item.status)").font(.caption).foregroundStyle(.orange)
                            }
                            if job.status == "running" {
                                Button("Cancel after current worktree") { Task { await model.cancel(job) } }
                            }
                            if job.items.contains(where: { $0.status == "failed" }) {
                                Button("Retry failed items") {
                                    review(job.items.filter { $0.status == "failed" }.map(\.worktreeId))
                                }
                            }
                        }
                    }
                }
            } else if model.refreshing { ProgressView("Measuring storage…") }
            if let error = model.error {
                Text("Storage unavailable: \(error)").font(.caption).foregroundStyle(.orange)
                if model.snapshot != nil { Text("Showing the last measurement.").font(.caption).foregroundStyle(.secondary) }
            }
            Button("Refresh measurements") { Task { model.setVisibility(cloud: appModel.cloud); await model.refresh() } }.disabled(model.refreshing)
        } header: {
            Text(model.environment.environment.label)
        }
        .task(id: appModel.cloud.environmentBindings.map { "\($0.id):\($0.binding.status):\($0.binding.localWorkspaceRoot)" } + appModel.cloud.threads.map(\.id)) {
            model.setVisibility(cloud: appModel.cloud)
            await model.refresh()
        }
        .task(id: model.snapshot?.jobs.first(where: { $0.status == "running" })?.id) {
            while model.snapshot?.jobs.contains(where: { $0.status == "running" }) == true && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await model.refresh()
            }
        }
        .sheet(isPresented: $editingPolicy) {
            if let policy = model.snapshot?.policy { PathwayStoragePolicyEditor(model: model, policy: policy) }
        }
    }

    private func selection(_ id: String) -> Binding<Bool> {
        Binding(get: { model.selectedWorktrees.contains(id) }, set: {
            if $0 { model.selectedWorktrees.insert(id) } else { model.selectedWorktrees.remove(id) }
        })
    }
}

private struct PathwayStorageThreadRow: View {
    @Bindable var model: PathwayEnvironmentStorageModel
    let thread: PathwayStorageThread
    let worktree: PathwayStorageWorktree?
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                if let worktree, !worktree.removed {
                    Button {
                        if model.selectedWorktrees.contains(worktree.id) { model.selectedWorktrees.remove(worktree.id) }
                        else { model.selectedWorktrees.insert(worktree.id) }
                    } label: {
                        Image(systemName: model.selectedWorktrees.contains(worktree.id) ? "checkmark.circle.fill" : "circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Select \(thread.title)")
                    .accessibilityValue(model.selectedWorktrees.contains(worktree.id) ? "Selected" : "Not selected")
                }
                Text(thread.title).font(.headline)
                Spacer()
                Menu {
                    if thread.status == "archived" { Button("Restore thread") { Task { await model.threadAction(.restore, thread: thread) } } }
                    if thread.status == "snoozed" { Button("Wake thread") { Task { await model.threadAction(.wake, thread: thread) } } }
                    if thread.status == "settled" { Button("Reopen thread") { Task { await model.threadAction(.reopen, thread: thread) } } }
                    Button(thread.keepWorktree ? "Allow cleanup" : "Keep worktree") { Task { await model.setKeep(thread, keep: !thread.keepWorktree) } }
                    if thread.reclaimedAt != nil { Button("Recreate worktree") { Task { await model.recreate(thread) } } }
                    Button("Delete thread", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("Actions for \(thread.title)")
            }
            Text(thread.status.capitalized + (thread.keepWorktree ? " · Keep worktree" : "")).font(.caption).foregroundStyle(.secondary)
            if thread.temporary == true { Text("Temporary: deleted on settlement").font(.caption).foregroundStyle(.orange) }
            Text("Worktree: \(pathwayStorageBytes(worktree?.estimatedBytes)) · Conversation estimate: \(pathwayStorageBytes(thread.threadDataBytes))").font(.caption)
            Text("Conversation estimates exclude attachments, provider logs, and shared database pages.").font(.caption2).foregroundStyle(.secondary)
            if let worktree, worktree.threadIds.count > 1 { Text("Shared by \(worktree.threadIds.count) threads").font(.caption).foregroundStyle(.secondary) }
            if thread.reclaimedAt != nil {
                Text("Worktree removed to free space. Recreate it before continuing; dependencies may need rebuilding.").font(.caption).foregroundStyle(.secondary)
            } else if let worktree, !worktree.blockers.isEmpty {
                Text(worktree.blockers.joined(separator: ", ")).font(.caption).foregroundStyle(.orange)
            }
        }
        .confirmationDialog("Delete this thread?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete thread", role: .destructive) { Task { await model.threadAction(.delete, thread: thread) } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This deletes conversation history and its server-owned working folder, including ignored files. Shared workspaces are kept. To keep the history, cancel and use worktree reclamation.")
        }
    }
}

private struct PathwayStoragePolicyEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    let model: PathwayEnvironmentStorageModel
    @State private var policy: PathwayStoragePolicy
    @State private var placement = PathwayEnvironmentPlacementPreferences.shared
    @State private var savedDefaults = false

    private var defaultsKey: String? {
        appModel.localStorageDirectory.map { "pathway.storageDefaultPolicy.\($0.lastPathComponent)" }
    }
    private var defaultPolicy: PathwayStoragePolicy? {
        guard let key = defaultsKey, let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PathwayStoragePolicy.self, from: data)
    }

    init(model: PathwayEnvironmentStorageModel, policy: PathwayStoragePolicy) {
        self.model = model
        _policy = State(initialValue: policy)
    }

    var body: some View {
        NavigationStack {
            Form {
                Toggle("Scheduled cleanup", isOn: $policy.enabled)
                Picker("After", selection: $policy.afterDays) {
                    ForEach([7, 14, 30, 60], id: \.self) { Text("\($0) days").tag($0) }
                }
                Text("Reclaims entire eligible worktrees, including ignored files. History and branches remain. Resuming a thread resets its waiting period.").font(.footnote).foregroundStyle(.secondary)
                Section("Storage warning") {
                    threshold("Free GB", value: $policy.warningBytes, divisor: 1_000_000_000)
                    threshold("Free percent", value: $policy.warningPercent)
                }
                Section("Critical storage") {
                    threshold("Free GB", value: $policy.criticalBytes, divisor: 1_000_000_000)
                    threshold("Free percent", value: $policy.criticalPercent)
                    Text("Either limit triggers the warning. Emergency cleanup always requires a user click.").font(.footnote).foregroundStyle(.secondary)
                }
                Toggle("Avoid critically low environments in Auto", isOn: $placement.avoidCriticalStorage)
                Section("Cleanup defaults on this client") {
                    Button("Use saved defaults") { if let defaults = defaultPolicy { policy = defaults } }
                        .disabled(defaultPolicy == nil)
                    Button("Save as defaults") {
                        guard let key = defaultsKey, let data = try? JSONEncoder().encode(policy) else { return }
                        UserDefaults.standard.set(data, forKey: key)
                        savedDefaults = true
                    }.disabled(defaultsKey == nil)
                    Text(savedDefaults ? "Defaults saved for this account on this client." : "Saving defaults does not enable cleanup on other environments. Open an environment's policy and use saved defaults to apply them.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Cleanup policy")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        policy.autoSettleAfterDays = PathwayGeneralPreferences.shared.autoSettleDays == 0 ? nil : PathwayGeneralPreferences.shared.autoSettleDays
                        Task { await model.setPolicy(policy); if model.error == nil { dismiss() } }
                    }
                        .disabled(model.performingAction || policy.criticalBytes >= policy.warningBytes || policy.criticalPercent >= policy.warningPercent)
                }
            }
        }
    }
    private func threshold(_ title: String, value: Binding<Double>, divisor: Double = 1) -> some View {
        HStack {
            Text(title)
            TextField(title, value: Binding(get: { value.wrappedValue / divisor }, set: { value.wrappedValue = max(0, $0) * divisor }), format: .number)
                .multilineTextAlignment(.trailing)
        }
    }
}
