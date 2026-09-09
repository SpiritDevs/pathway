import SwiftUI
import Observation

struct PathwayWorkspacePullRequestsView: View {
    let client: PathwayWorkspaceClient
    var postHTTP: PathwayWorkspacePostHTTP?
    @State private var listing = PathwayWorkspacePullRequestListModel()
    @State private var query = ""
    @State private var state = "open"
    var body: some View {
        List {
            PathwayThreadPullRequestsSection(client: client, postHTTP: postHTTP)
            Picker("State", selection: $state) {
                Text("Open").tag("open"); Text("Closed").tag("closed"); Text("Merged").tag("merged"); Text("All").tag("all")
            }
            if let error = listing.error { Text(error).foregroundStyle(.red) }
            if listing.rows.isEmpty && !listing.busy { Text("No pull requests found") }
            ForEach(listing.rows) { row in
                NavigationLink {
                    PathwayWorkspacePullRequestView(client: client, row: row, postHTTP: postHTTP)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.title)
                        Text("\(row.repository) #\(row.number) · \(row.isDraft ? "draft" : row.state)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if !listing.cursors.isEmpty { Button("Load more") { Task { await load(more: true) } }.disabled(listing.busy) }
            else if listing.truncated { Text("The provider limited this list. Narrow your search.").font(.caption).foregroundStyle(.secondary) }
            if listing.busy { ProgressView("Loading pull requests…") }
        }.navigationTitle("Pull requests").searchable(text: $query)
            .onSubmit(of: .search) { Task { await load(more: false) } }
            .task(id: [client.context.projectID, client.context.cwd, state]) { await load(more: false) }
            .refreshable { await load(more: false) }
    }
    private func load(more: Bool) async {
        await listing.load(client: client, state: state, query: query, more: more)
    }
}

@MainActor @Observable
final class PathwayWorkspacePullRequestListModel {
    private(set) var rows: [PathwayWorkspacePullRequestRow] = []
    private(set) var cursors: [String: String] = [:]
    private(set) var error: String?
    private(set) var busy = false
    private(set) var truncated = false
    private var generation = 0
    private var scope: [String] = []

    func load(client: PathwayWorkspaceClient, state: String, query: String, more: Bool) async {
        guard client.context.supportsPullRequests, let projectID = client.context.projectID else { return }
        let query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        let requestedScope = [projectID, client.context.cwd, state, query]
        if more && (busy || scope != requestedScope || cursors.isEmpty) { return }
        generation += 1
        let requestGeneration = generation
        scope = requestedScope
        if !more { rows = []; cursors = [:]; truncated = false }
        busy = true; error = nil
        defer { if generation == requestGeneration { busy = false } }
        do {
            var payload: [String: JSONValue] = ["projectId": .string(projectID), "state": .string(state), "limit": .number(50)]
            if !query.isEmpty { payload["query"] = .string(query) }
            if more { payload["cursors"] = .object(cursors.mapValues(JSONValue.string)) }
            let result: PathwayWorkspacePullRequestList = try await client.call("pullRequests.list", payload)
            guard !Task.isCancelled, generation == requestGeneration else { return }
            let existing = more ? rows : []
            let ids = Set(existing.map(\.id))
            rows = existing + result.entries.filter { !ids.contains($0.id) }
            cursors = result.nextCursors; truncated = result.truncated
            error = result.errors.isEmpty ? nil : result.errors.map { "\($0.projectTitle): \($0.message)" }.joined(separator: "\n")
        } catch {
            guard !Task.isCancelled, generation == requestGeneration else { return }
            self.error = error.localizedDescription
        }
    }
}

struct PathwayWorkspacePullRequestView: View {
    let client: PathwayWorkspaceClient
    let row: PathwayWorkspacePullRequestRow
    var postHTTP: PathwayWorkspacePostHTTP?
    @State private var detail: PathwayWorkspacePullRequestDetail?
    @State private var activity: PathwayWorkspacePullRequestActivity?
    @State private var comment = ""
    @State private var drafts: [PathwayWorkspaceReviewDraft] = []
    @State private var verdict = "comment"
    @State private var mergeMethod = "squash"
    @State private var pending: String?
    @State private var error: String?
    @State private var busy = false
    @State private var notice: String?
    var body: some View {
        List {
            Section {
                Text(detail?.title ?? row.title).font(.headline)
                if let url = URL(string: row.url), ["http", "https"].contains(url.scheme ?? "") { Link("Open on provider", destination: url) }
                if let detail {
                    Text("\(detail.headBranch) → \(detail.baseBranch)").font(.caption.monospaced())
                    Text("\(detail.state) · +\(detail.additions) −\(detail.deletions)").font(.caption)
                    Text(detail.body).textSelection(.enabled)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Text(notice).foregroundStyle(.secondary) }
            if busy { ProgressView("Working…") }
            if let detail {
                if detail.capabilities.diff, let postHTTP {
                    NavigationLink("Review pull request diff") {
                        PathwayWorkspacePullRequestDiffView(row: row, postHTTP: postHTTP, canDraft: detail.canDraftInline && client.context.canMutate, drafts: $drafts)
                    }
                }
                if detail.capabilities.reviewers.request {
                    NavigationLink("Reviewers") { PathwayWorkspaceReviewersView(client: client, row: row) }
                }
                checksSection(detail)
                actionsSection(detail)
                if let activity { activitySections(activity, detail: detail) }
                composeSection(detail)
            }
        }.navigationTitle("#\(row.number)")
            .task { await load() }.refreshable { await load() }
            .confirmationDialog("Confirm pull request action", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })) {
                Button(confirmationLabel) { if let action = pending { pending = nil; Task { await perform(action) } } }
                Button("Cancel", role: .cancel) { pending = nil }
            } message: { Text("\(confirmationLabel) for \(row.repository) #\(row.number). Comments and reviews are sent to the repository's provider.") }
    }
    private var confirmationLabel: String {
        switch pending { case "comment": "Post comment"; case "review": "Submit review with \(drafts.count) line comments"; case "merge": "Merge using \(mergeMethod)"; default: (pending ?? "Continue").capitalized }
    }
    @ViewBuilder private func checksSection(_ detail: PathwayWorkspacePullRequestDetail) -> some View {
        Section("Checks") {
            if detail.checks.isEmpty { Text("No checks reported") }
            ForEach(detail.checks) { check in
                VStack(alignment: .leading) {
                    Label("\(check.name): \(check.status)", systemImage: check.status == "success" ? "checkmark.circle" : "circle")
                    if let description = check.description { Text(description).font(.caption).foregroundStyle(.secondary) }
                    if let urlString = check.url, let url = URL(string: urlString), ["http", "https"].contains(url.scheme ?? "") { Link("View check", destination: url) }
                }
            }
        }
    }
    @ViewBuilder private func actionsSection(_ detail: PathwayWorkspacePullRequestDetail) -> some View {
        Section("Actions") {
            if detail.availableActions.contains("merge") {
                Picker("Merge method", selection: $mergeMethod) { ForEach(detail.availableMergeMethods, id: \.self) { Text($0.capitalized).tag($0) } }
            }
            ForEach(detail.availableActions, id: \.self) { action in
                Button(action.capitalized) { pending = action }
            }
        }.disabled(busy || !client.context.canMutate)
    }
    @ViewBuilder private func activitySections(_ activity: PathwayWorkspacePullRequestActivity, detail: PathwayWorkspacePullRequestDetail) -> some View {
        Section("Conversation") {
            ForEach(activity.comments) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.author?.login ?? "Unknown author").font(.caption).bold()
                    Text(item.body).textSelection(.enabled)
                }
            }
            if activity.commentsTruncated { Text("Showing \(activity.comments.count) of \(activity.commentCount) comments. Open on provider for the complete history.").font(.caption).foregroundStyle(.secondary) }
        }
        Section("Review threads") {
            ForEach(activity.reviewThreads) { thread in
                NavigationLink {
                    PathwayWorkspaceReviewThreadView(client: client, row: row, thread: thread, canReply: detail.capabilities.review.reply && detail.viewerPermissions.comment, canResolve: detail.capabilities.review.resolve && detail.viewerPermissions.resolve)
                } label: {
                    VStack(alignment: .leading) {
                        Text(thread.path).font(.subheadline.monospaced())
                        Text(thread.isResolved ? "Resolved" : "Unresolved").font(.caption)
                        if thread.isOutdated { Text("Outdated").font(.caption).foregroundStyle(.secondary) }
                        Text(thread.comments.last?.body ?? "").lineLimit(2)
                    }
                }
            }
        }
    }
    @ViewBuilder private func composeSection(_ detail: PathwayWorkspacePullRequestDetail) -> some View {
        if detail.canComment || !detail.availableVerdicts.isEmpty {
            Section("Write a comment or review") {
                TextField("Message", text: $comment, axis: .vertical).lineLimit(3...10)
                if detail.canComment { Button("Post comment") { pending = "comment" }.disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                if !detail.availableVerdicts.isEmpty {
                    Picker("Review", selection: $verdict) { ForEach(detail.availableVerdicts, id: \.self) { Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag($0) } }
                    ForEach($drafts) { $draft in
                        VStack(alignment: .leading) {
                            Text("\(draft.anchor.path):\(draft.anchor.line) · \(draft.anchor.side)").font(.caption.monospaced())
                            TextField("Line comment", text: $draft.body, axis: .vertical).lineLimit(2...6)
                            Button("Remove line comment", role: .destructive) { drafts.removeAll { $0.id == draft.id } }
                        }
                    }
                    Button("Submit review") { pending = "review" }
                        .disabled(!PathwayWorkspaceReviewValidation.canSubmit(verdict: verdict, body: comment, drafts: drafts) || (!drafts.isEmpty && !detail.canDraftInline))
                }
            }.disabled(busy || !client.context.canMutate || comment.count > 65_536)
        }
    }
    private func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            detail = try await client.call("pullRequests.detail", row.payload)
            if let detail {
                if !detail.availableMergeMethods.contains(mergeMethod) { mergeMethod = detail.availableMergeMethods.first ?? "squash" }
                if !detail.availableVerdicts.contains(verdict) { verdict = detail.availableVerdicts.first ?? "comment" }
            }
            activity = try await client.call("pullRequests.activity", row.payload); error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func perform(_ action: String) async {
        busy = true; defer { busy = false }
        do {
            let latest: PathwayWorkspacePullRequestDetail = try await client.call("pullRequests.detail", row.payload)
            detail = latest
            let permitted: Bool
            if action == "comment" { permitted = latest.canComment && !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && comment.count <= 65_536 }
            else if action == "review" { permitted = latest.availableVerdicts.contains(verdict) && PathwayWorkspaceReviewValidation.canSubmit(verdict: verdict, body: comment, drafts: drafts) && (drafts.isEmpty || latest.canDraftInline) }
            else { permitted = latest.availableActions.contains(action) && (action != "merge" || latest.availableMergeMethods.contains(mergeMethod)) }
            guard permitted else { throw PathwayRPCError.remote("This action is no longer available. Review the refreshed pull request.") }
            var payload = row.payload
            let method: String
            if action == "comment" { method = "pullRequests.comment"; payload["body"] = .string(comment) }
            else if action == "review" {
                method = "pullRequests.submitReview"; payload["body"] = .string(comment); payload["verdict"] = .string(verdict); payload["comments"] = .array(drafts.map(\.payload))
            } else {
                method = "pullRequests.runAction"; payload["action"] = .string(action)
                if action == "merge" { payload["mergeMethod"] = .string(mergeMethod) }
            }
            _ = try await client.run(method, payload)
            if action == "comment" || action == "review" { comment = "" }
            if action == "review" { drafts = [] }
            notice = "Action completed"; error = nil
            detail = try await client.call("pullRequests.detail", row.payload)
            activity = try await client.call("pullRequests.activity", row.payload)
        } catch { self.error = error.localizedDescription }
    }
}

struct PathwayWorkspaceReviewThreadView: View {
    let client: PathwayWorkspaceClient
    let row: PathwayWorkspacePullRequestRow
    let thread: PathwayWorkspacePullRequestActivity.ReviewThread
    let canReply: Bool
    let canResolve: Bool
    @State private var reply = ""
    @State private var resolved: Bool?
    @State private var error: String?
    @State private var busy = false
    @State private var confirm = false
    @State private var posted: [PostedReply] = []
    private struct PostedReply: Identifiable { let id = UUID(); let body: String }
    var body: some View {
        List {
            Text(thread.path).font(.caption.monospaced())
            ForEach(thread.comments) { item in
                VStack(alignment: .leading) { Text(item.author?.login ?? "Unknown author").font(.caption).bold(); Text(item.body).textSelection(.enabled) }
            }
            ForEach(posted) { Text($0.body) }
            if let error { Text(error).foregroundStyle(.red) }
            if canResolve {
                Button((resolved ?? thread.isResolved) ? "Reopen conversation" : "Resolve conversation") { Task { await resolve() } }.disabled(busy || !client.context.canMutate)
            }
            if canReply {
                TextField("Reply", text: $reply, axis: .vertical)
                Button("Send reply") { confirm = true }.disabled(busy || !client.context.canMutate || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reply.count > 65_536)
            }
        }.navigationTitle("Review conversation")
            .confirmationDialog("Send this reply?", isPresented: $confirm) {
                Button("Send reply") { Task { await send() } }; Button("Cancel", role: .cancel) { }
            }
    }
    private func resolve() async {
        busy = true; defer { busy = false }
        do {
            let next = !(resolved ?? thread.isResolved)
            var payload = row.payload; payload["threadId"] = .string(thread.id); payload["resolved"] = .bool(next)
            _ = try await client.run("pullRequests.setThreadResolution", payload); resolved = next; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func send() async {
        busy = true; defer { busy = false }
        do {
            var payload = row.payload; payload["threadId"] = .string(thread.id); payload["body"] = .string(reply)
            _ = try await client.run("pullRequests.replyToThread", payload); posted.append(PostedReply(body: reply)); reply = ""; error = nil
        } catch { self.error = error.localizedDescription }
    }
}


struct PathwayThreadPullRequestsSection: View {
    let client: PathwayWorkspaceClient
    var postHTTP: PathwayWorkspacePostHTTP?
    var body: some View {
        if !client.context.linkedPullRequests.isEmpty {
            Section("Linked pull requests") {
                ForEach(client.context.linkedPullRequests, id: \.url) { attachment in
                    PathwayThreadPullRequestRow(client: client, attachment: attachment, postHTTP: postHTTP)
                }
            }
        }
    }
}

private struct PathwayThreadPullRequestRow: View {
    let client: PathwayWorkspaceClient
    let attachment: PathwayPullRequestAttachment
    var postHTTP: PathwayWorkspacePostHTTP?
    @State private var detail: PathwayWorkspacePullRequestDetail?
    @State private var error: String?
    @State private var busy = false
    @State private var unlinked = false
    @State private var confirmMerge = false
    @State private var mergeMethod = "squash"
    private var row: PathwayWorkspacePullRequestRow? {
        guard let reference = PathwayAttachedPullRequestReference(attachment), let projectID = client.context.projectID else { return nil }
        return .init(host: reference.host, projectId: projectID, repository: reference.repository,
            number: attachment.number, title: detail?.title ?? "#\(attachment.number)", state: detail?.state ?? "open", isDraft: detail?.isDraft ?? false, url: attachment.url)
    }
    var body: some View {
        if !unlinked {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    if let row {
                        NavigationLink {
                            PathwayWorkspacePullRequestView(client: client, row: row, postHTTP: postHTTP)
                        } label: {
                            VStack(alignment: .leading) {
                                Text("#\(attachment.number): \(detail?.title ?? "Pull request")").lineLimit(2)
                                Text(detail?.state.capitalized ?? "Checking status").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } else { Text("#\(attachment.number)") }
                    if detail?.availableActions.contains("merge") == true {
                        Button("Merge") { confirmMerge = true }.buttonStyle(.borderless).disabled(busy || !client.context.canMutate)
                    }
                    Menu {
                        if let url = URL(string: attachment.url) { Link("Open on provider", destination: url); ShareLink("Share link", item: url) }
                        if let methods = detail?.availableMergeMethods, !methods.isEmpty {
                            Picker("Merge method", selection: $mergeMethod) { ForEach(methods, id: \.self) { Text($0.capitalized).tag($0) } }
                        }
                        if client.context.supportsPullRequestAttachments {
                            Button("Unlink from thread") { Task { await unlink() } }.disabled(busy || !client.context.canMutate)
                        }
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("Actions for pull request \(attachment.number)")
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            .task(id: attachment.url) { await refresh() }
            .confirmationDialog("Merge pull request #\(attachment.number)?", isPresented: $confirmMerge) {
                Button("Merge using \(mergeMethod)") { Task { await merge() } }
                Button("Cancel", role: .cancel) { }
            }
        }
    }
    private func refresh() async {
        guard let row, client.context.supportsPullRequests else { return }
        do {
            detail = try await client.call("pullRequests.detail", row.payload)
            if let methods = detail?.availableMergeMethods, !methods.contains(mergeMethod) { mergeMethod = methods.first ?? "squash" }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func merge() async {
        guard let row, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let latest: PathwayWorkspacePullRequestDetail = try await client.call("pullRequests.detail", row.payload)
            guard latest.availableActions.contains("merge"), latest.availableMergeMethods.contains(mergeMethod) else {
                detail = latest; throw PathwayRPCError.remote("This pull request is not ready to merge.")
            }
            var payload = row.payload; payload["action"] = .string("merge"); payload["mergeMethod"] = .string(mergeMethod)
            _ = try await client.run("pullRequests.runAction", payload)
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    private func unlink() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            _ = try await client.run("orchestration.dispatchCommand", ["type": .string("thread.source-control.record"), "commandId": .string(UUID().uuidString), "threadId": .string(client.context.threadID), "committed": .bool(false), "pullRequestAction": .string("detached"), "pullRequest": .object(["number": .number(Double(attachment.number)), "url": .string(attachment.url)])])
            unlinked = true
        } catch { self.error = error.localizedDescription }
    }
}
