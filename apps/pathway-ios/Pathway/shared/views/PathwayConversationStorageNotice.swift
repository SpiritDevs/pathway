import SwiftUI

struct PathwayConversationStorageNotice: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var model: PathwayEnvironmentStorageModel
    @State private var continued = false
    @State private var showsDashboard = false
    let threadID: String?
    let isStartingConversation: Bool
    var chooseEnvironment: (() -> Void)?
    var onContinueAnyway: (() -> Void)?
    var onAvailabilityChanged: ((Bool) -> Void)?

    init(environment: PathwayCompanyEnvironment, connect: PathwayConnectClient,
         threadID: String? = nil, isStartingConversation: Bool = true, chooseEnvironment: (() -> Void)? = nil, onContinueAnyway: (() -> Void)? = nil, onAvailabilityChanged: ((Bool) -> Void)? = nil) {
        _model = State(initialValue: PathwayEnvironmentStorageModel(environment: environment, connect: connect))
        self.threadID = threadID
        self.isStartingConversation = isStartingConversation
        self.chooseEnvironment = chooseEnvironment
        self.onContinueAnyway = onContinueAnyway
        self.onAvailabilityChanged = onAvailabilityChanged
    }

    private var reclaimed: PathwayStorageThread? {
        model.snapshot?.threads.first { $0.threadId == threadID && $0.reclaimedAt != nil }
    }

    private var blocksSending: Bool {
        (model.hasCurrentSnapshot && showsCriticalStorage) || reclaimed != nil
    }

    private var showsCriticalStorage: Bool {
        isStartingConversation && model.snapshot?.critical == true && !continued
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reclaimed {
                Text("Worktree removed to free space").font(.headline)
                Text("Your conversation and branch remain. Dependencies and generated files may need rebuilding; ignored files were removed.").font(.caption)
                Button("Recreate worktree") { Task { await model.recreate(reclaimed) } }
                    .disabled(model.performingAction)
            }
            if showsCriticalStorage {
                Label("\(model.environment.environment.label) is critically low on storage", systemImage: "externaldrive.badge.exclamationmark")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                if !model.hasCurrentSnapshot {
                    Text("Last known reading. Current storage is unavailable.").font(.caption).foregroundStyle(.secondary)
                }
                if let preview = model.preview, preview.items.contains(where: \.eligible) {
                    Text("Cleanup removes entire eligible worktrees, including ignored files. History and branches remain.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Free up approximately \(pathwayStorageBytes(preview.estimatedBytes))") {
                        let ids = preview.items.filter(\.eligible).map(\.worktreeId)
                        Task { await model.start(mode: "emergency", ids: ids) }
                    }.disabled(model.performingAction)
                } else {
                    Text("No eligible worktrees are ready for quick cleanup. Review storage for details.").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Review storage") { showsDashboard = true }
                    if let chooseEnvironment { Button("Choose another environment", action: chooseEnvironment) }
                    Button("Continue anyway") { continued = true; onContinueAnyway?() }
                }.font(.caption)
                if threadID != nil, chooseEnvironment != nil {
                    Text("Choosing another environment starts a new conversation. Your current conversation and draft stay here.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if isStartingConversation, let job = model.snapshot?.runningJob {
                HStack {
                    ProgressView("Reclaiming worktrees…")
                    Button("Cancel") { Task { await model.cancel(job) } }
                }.font(.caption)
            }
            if let error = model.error, showsCriticalStorage || reclaimed != nil {
                Text(error).font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(showsCriticalStorage || reclaimed != nil ? 12 : 0)
        .onChange(of: blocksSending, initial: true) { _, blocked in
            onAvailabilityChanged?(!blocked)
        }
        .task {
            while !Task.isCancelled {
                model.setVisibility(cloud: appModel.cloud)
                await model.refresh()
                if isStartingConversation && model.snapshot?.critical == true {
                    let ids = model.snapshot?.emergencyWorktreeIDs ?? []
                    if !model.performingAction { await model.prepare(mode: "emergency", ids: ids) }
                } else { continued = false }
                do { try await Task.sleep(for: .seconds(model.snapshot?.runningJob != nil ? 2 : 30)) }
                catch { return }
            }
        }
        .sheet(isPresented: $showsDashboard) {
            NavigationStack {
                PathwayEnvironmentStorageView()
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showsDashboard = false } } }
            }
        }
    }
}
