import SwiftUI

struct PathwayWorkspaceView: View {
    let context: PathwayWorkspaceContext
    let request: PathwayWorkspaceRequest
    var subscribe: PathwayWorkspaceSubscribe?
    var assetURL: PathwayWorkspaceAssetURL?
    var postHTTP: PathwayWorkspacePostHTTP?
    var initialSection = "repositories"
    private var client: PathwayWorkspaceClient { .init(context: context, request: request) }

    var body: some View {
        Group {
            switch PathwayWorkspaceSection(rawValue: initialSection) ?? .repositories {
            case .repositories: overview
            case .changes: PathwayWorkspaceGitView(client: client, subscribe: subscribe, assetURL: assetURL)
            case .pullRequests:
                if context.supportsPullRequests {
                    PathwayWorkspacePullRequestsView(client: client, postHTTP: postHTTP)
                } else {
                    ContentUnavailableView("Pull requests unavailable", systemImage: "arrow.triangle.pull",
                        description: Text("Connect to an environment with pull-request support to review its repository."))
                }
            }
        }
    }

    private var overview: some View {
        List {
            Section {
                Text(context.cwd).font(.caption.monospaced()).textSelection(.enabled)
                if !context.canMutate {
                    Label("Workspace changes are unavailable while disconnected or the thread is active.", systemImage: "info.circle")
                }
            }
            NavigationLink {
                PathwayWorkspaceGitView(client: client, subscribe: subscribe, assetURL: assetURL)
            } label: { Label("Source control", systemImage: "arrow.triangle.branch") }
            NavigationLink {
                PathwayWorkspaceFilesView(client: client, assetURL: assetURL)
            } label: { Label("Files", systemImage: "folder") }
            NavigationLink {
                PathwayWorkspaceTerminalView(client: client, subscribe: subscribe)
            } label: { Label("Terminal & scripts", systemImage: "terminal") }
            if context.supportsPullRequests {
                NavigationLink {
                    PathwayWorkspacePullRequestsView(client: client, postHTTP: postHTTP)
                } label: { Label("Pull requests", systemImage: "arrow.triangle.pull") }
            }
        }
        .navigationTitle("Workspace")
    }
}

struct PathwayWorkspaceGitView: View {
    let client: PathwayWorkspaceClient
    var subscribe: PathwayWorkspaceSubscribe?
    var assetURL: PathwayWorkspaceAssetURL?
    @State private var status: PathwayWorkspaceStatus?
    @State private var selected = Set<String>()
    @State private var message = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var pendingAction: String?

    var body: some View {
        List {
            if let error { Section { Text(error).foregroundStyle(.red) } }
            if let notice { Section { Text(notice) } }
            if client.context.projectID == nil {
                Section("Conversation folder") {
                    Text(client.context.cwd).font(.caption.monospaced()).textSelection(.enabled)
                    NavigationLink("Files") { PathwayWorkspaceFilesView(client: client, assetURL: assetURL) }
                    NavigationLink("Open terminal in this folder") {
                        PathwayWorkspaceTerminalView(client: client, subscribe: subscribe, openNewOnAppear: true)
                    }.disabled(!client.context.canMutate || subscribe == nil)
                    Text("Use the terminal to review, commit, and push work in repositories inside this folder.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let status {
                Section("Repository") {
                    LabeledContent("Branch", value: status.refName ?? "Detached HEAD")
                    LabeledContent("Ahead / behind", value: "\(status.aheadCount) / \(status.behindCount)")
                    NavigationLink("Review current changes") { PathwayWorkspaceDiffView(client: client) }
                    NavigationLink("Branches") { PathwayWorkspaceBranchesView(client: client) }
                    if client.context.projectID != nil {
                        NavigationLink("Move to a worktree") { PathwayWorkspaceMoveView(client: client) }
                    }
                }
                if status.isRepo {
                    Section("Files to commit") {
                        if status.workingTree.files.isEmpty { Text("No uncommitted changes") }
                        ForEach(status.workingTree.files) { file in
                            Toggle(isOn: Binding(get: { selected.contains(file.path) }, set: { on in
                                if on { selected.insert(file.path) } else { selected.remove(file.path) }
                            })) {
                                VStack(alignment: .leading) {
                                    Text(file.path).font(.subheadline.monospaced())
                                    Text("+\(file.insertions) −\(file.deletions)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Section {
                        TextField("Commit message", text: $message, axis: .vertical)
                        Button("Commit selected files") { pendingAction = "commit" }
                            .disabled(selected.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("Push commits") { pendingAction = "push" }.disabled(!status.hasPrimaryRemote)
                        Button("Pull upstream changes") { pendingAction = "pull" }.disabled(!status.hasUpstream)
                        Button("Create pull request") { pendingAction = "create_pr" }.disabled(!status.canCreatePullRequest)
                        if status.hasWorkingTreeChanges { Text("Commit local changes before creating a pull request.").font(.caption).foregroundStyle(.secondary) }
                    }.disabled(busy || !client.context.canMutate)
                } else { Text("This workspace is not a repository.") }
            } else if busy { ProgressView("Loading repository…") }
        }
        .navigationTitle("Source control")
        .refreshable { await refresh() }
        .task(id: client.context.cwd) { await refresh() }
        .toolbar { if busy { ProgressView() } }
        .confirmationDialog("Confirm Git action", isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } })) {
            Button(actionLabel) { if let action = pendingAction { pendingAction = nil; Task { await perform(action) } } }
            Button("Cancel", role: .cancel) { pendingAction = nil }
        } message: {
            Text(pendingAction == "commit" ? "Commit \(selected.count) selected files in \(client.context.cwd)." : "This changes the repository or its remote for this thread. Refresh and review the current changes before continuing.")
        }
    }
    private var actionLabel: String {
        switch pendingAction { case "commit": "Commit"; case "push": "Push"; case "pull": "Pull"; default: "Create pull request" }
    }
    private func refresh() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        status = nil
        do {
            status = try await client.call("vcs.refreshStatus", client.cwdPayload)
            selected.formIntersection(Set(status?.workingTree.files.map(\.path) ?? []))
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func perform(_ action: String) async {
        busy = true; error = nil; notice = nil
        do {
            if action == "create_pr" {
                let latest: PathwayWorkspaceStatus = try await client.call("vcs.refreshStatus", client.cwdPayload)
                status = latest
                guard latest.canCreatePullRequest else {
                    throw PathwayRPCError.remote(latest.hasWorkingTreeChanges ? "Commit local changes before creating a pull request." : "A repository with a remote is required to create a pull request.")
                }
            }
            if action == "pull" {
                _ = try await client.run("vcs.pull", client.cwdPayload)
                notice = "Upstream pull completed"
            } else { notice = try await client.gitAction(action, message: message, paths: selected) }
            if action == "commit" { message = ""; selected = [] }
        } catch { self.error = error.localizedDescription }
        let actionError = error
        busy = false
        await refresh()
        if let actionError { error = actionError }
    }
}

struct PathwayWorkspaceDiffView: View {
    let client: PathwayWorkspaceClient
    @State private var diff: PathwayWorkspaceDiff?
    @State private var error: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let diff {
                ForEach(diff.sources) { source in
                    Section(source.title) {
                        if source.truncated { Text("The server truncated this diff.").foregroundStyle(.orange) }
                        Text(source.diff.isEmpty ? "No changes" : source.diff).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            } else if error == nil { ProgressView("Loading current diff…") }
        }.navigationTitle("Current changes")
            .task { do { diff = try await client.call("review.getDiffPreview", client.cwdPayload) } catch { self.error = error.localizedDescription } }
    }
}

struct PathwayWorkspaceBranchesView: View {
    let client: PathwayWorkspaceClient
    @State private var refs: [PathwayWorkspaceRefs.Ref] = []
    @State private var nextCursor: Int?
    @State private var newName = ""
    @State private var selectedRef: String?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            Section("Create branch") {
                TextField("Branch name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Create and switch") { selectedRef = newName }
                    .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy || !client.context.canMutate)
            }
            Section("Branches") {
                ForEach(refs) { ref in
                    Button { selectedRef = ref.name } label: {
                        HStack { Text(ref.name); Spacer(); if ref.current { Image(systemName: "checkmark") } }
                    }.disabled(ref.current || (ref.worktreePath != nil && ref.worktreePath != client.context.cwd) || busy || !client.context.canMutate)
                }
                if nextCursor != nil { Button("Load more") { Task { await load(more: true) } }.disabled(busy) }
            }
        }.navigationTitle("Branches").task { await load(more: false) }
            .confirmationDialog("Switch this workspace's branch?", isPresented: Binding(get: { selectedRef != nil }, set: { if !$0 { selectedRef = nil } })) {
                Button("Switch branch") { if let name = selectedRef { selectedRef = nil; Task { await change(name) } } }
                Button("Cancel", role: .cancel) { selectedRef = nil }
            } message: { Text("Other threads using this checkout will see the branch change too.") }
    }
    private func load(more: Bool) async {
        busy = true; defer { busy = false }
        do {
            var payload = client.cwdPayload; payload["limit"] = .number(100)
            if more, let nextCursor { payload["cursor"] = .number(Double(nextCursor)) }
            let result: PathwayWorkspaceRefs = try await client.call("vcs.listRefs", payload)
            refs = more ? refs + result.refs : result.refs; nextCursor = result.nextCursor
        } catch { self.error = error.localizedDescription }
    }
    private func change(_ name: String) async {
        busy = true; error = nil
        do {
            var payload = client.cwdPayload; payload["refName"] = .string(name)
            let create = !refs.contains { $0.name == name }
            if create { payload["switchRef"] = .bool(true) }
            let switched = try await client.run(create ? "vcs.createRef" : "vcs.switchRef", payload)
            let branch = switched.objectValue?["refName"]?.stringValue ?? name
            do {
                _ = try await client.run("orchestration.dispatchCommand", [
                    "type": .string("thread.metadata.update"), "commandId": .string(UUID().uuidString),
                    "threadId": .string(client.context.threadID), "branch": .string(branch),
                    "expectedWorktreePath": client.context.cwd == client.context.projectRoot ? .null : .string(client.context.cwd)
                ])
            } catch { throw PathwayRPCError.remote("Branch switched, but the thread label could not be updated: " + error.localizedDescription) }
            newName = ""
        } catch { self.error = error.localizedDescription }
        busy = false; await load(more: false)
    }
}

struct PathwayWorkspaceMoveView: View {
    let client: PathwayWorkspaceClient
    @State private var preview: PathwayWorkspaceMovePreview?
    @State private var error: String?
    @State private var sent = false
    @State private var busy = false
    @State private var confirm = false
    var body: some View {
        Form {
            Text("Move tracked and untracked checkout changes into an isolated worktree. Ignored files stay in the project folder.")
            if let error { Text(error).foregroundStyle(.red) }
            if sent { Text("Move requested. Return to the thread to follow its workspace preparation and any recovery instructions.") }
            if let preview {
                LabeledContent("Files to move", value: "\(preview.fileCount)")
                LabeledContent("Terminals to stop", value: "\(preview.terminalCount)")
                ForEach(preview.blockers) { Text($0.message).foregroundStyle(.orange) }
                Button("Move to worktree") { confirm = true }
                    .disabled(!preview.blockers.isEmpty || sent || busy || !client.context.canMutate)
            }
        }.navigationTitle("Move workspace")
            .task { do { preview = try await client.call("orchestration.previewWorkspaceMove", ["threadId": .string(client.context.threadID)]) } catch { self.error = error.localizedDescription } }
            .confirmationDialog("Move this thread to a worktree?", isPresented: $confirm) {
                Button("Move and stop its terminals") { Task { await move() } }
                Button("Cancel", role: .cancel) { }
            }
    }
    private func move() async {
        busy = true; defer { busy = false }
        do {
            let latest: PathwayWorkspaceMovePreview = try await client.call("orchestration.previewWorkspaceMove", ["threadId": .string(client.context.threadID)])
            preview = latest
            guard latest.blockers.isEmpty else { return }
            _ = try await client.run("orchestration.dispatchCommand", ["type": .string("thread.workspace-move.request"), "commandId": .string(UUID().uuidString), "threadId": .string(client.context.threadID), "stopTerminals": .bool(latest.terminalCount > 0)])
            sent = true
        } catch { self.error = error.localizedDescription }
    }
}


enum PathwayWorkspaceSection: String {
    case repositories
    case changes
    case pullRequests = "pull-requests"
    var title: String {
        switch self { case .repositories: "Source Control"; case .changes: "Changes"; case .pullRequests: "Pull requests" }
    }
}
