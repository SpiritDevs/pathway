import SwiftUI

struct PathwayWorkspacePullRequestDiffView: View {
    let row: PathwayWorkspacePullRequestRow
    let postHTTP: PathwayWorkspacePostHTTP
    let canDraft: Bool
    @Binding var drafts: [PathwayWorkspaceReviewDraft]
    @State private var slices: [Slice] = []
    @State private var cursor: String?
    @State private var busy = false
    @State private var error: String?
    @State private var selected: PathwayWorkspaceReviewAnchor?
    private struct Response: Decodable { let patch: String; let truncated: Bool; let nextCursor: String? }
    private struct Slice: Identifiable { let id = UUID(); let lines: [PathwayWorkspaceDiffLine]; let truncated: Bool }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if canDraft { Text("Tap a diff line to draft a comment. Submit your review from the pull request page.").font(.caption).foregroundStyle(.secondary) }
            ForEach(slices) { slice in
                Section {
                    if slice.truncated { Text("Some changes are unavailable from the provider.").foregroundStyle(.orange) }
                    ForEach(slice.lines) { line in
                        if canDraft, let anchor = line.anchor {
                            Button { selected = anchor } label: {
                                HStack(alignment: .top) {
                                    Text("\(anchor.line)").foregroundStyle(.secondary).frame(minWidth: 32, alignment: .trailing)
                                    Text(line.text).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
                                    if drafts.contains(where: { $0.anchor == anchor }) { Image(systemName: "text.bubble.fill").accessibilityLabel("Draft comment") }
                                }.font(.caption.monospaced())
                            }.buttonStyle(.plain)
                        } else { Text(line.text).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                }
            }
            if cursor != nil { Button("Load more changes") { Task { await load() } }.disabled(busy) }
            if busy { ProgressView("Loading diff…") }
        }.navigationTitle("Pull request diff")
            .task { if slices.isEmpty { await load() } }
            .sheet(item: $selected) { anchor in
                PathwayWorkspaceLineCommentView(anchor: anchor, initial: drafts.first(where: { $0.anchor == anchor })?.body ?? "") { body in
                    if let index = drafts.firstIndex(where: { $0.anchor == anchor }) { drafts[index].body = body }
                    else { drafts.append(.init(anchor: anchor, body: body)) }
                }
            }
    }
    private func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            var payload = row.payload
            if let cursor { payload["cursor"] = .string(cursor) }
            let value = try await postHTTP("/api/pull-requests/diff", .object(payload))
            let result = try JSONDecoder().decode(Response.self, from: JSONEncoder().encode(value))
            slices.append(Slice(lines: PathwayWorkspaceDiffLine.parse(result.patch), truncated: result.truncated))
            cursor = result.nextCursor; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct PathwayWorkspaceLineCommentView: View {
    let anchor: PathwayWorkspaceReviewAnchor
    let initial: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var bodyText = ""
    var body: some View {
        NavigationStack {
            Form {
                Text("\(anchor.path):\(anchor.line) · \(anchor.side)").font(.caption.monospaced())
                TextField("Comment", text: $bodyText, axis: .vertical).lineLimit(4...15)
                Text("This draft is sent when you submit the review.").font(.caption).foregroundStyle(.secondary)
            }.navigationTitle("Line comment")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save draft") { save(bodyText); dismiss() }
                            .disabled(bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || bodyText.count > 65_536)
                    }
                }.onAppear { bodyText = initial }
        }
    }
}

struct PathwayWorkspaceReviewersView: View {
    let client: PathwayWorkspaceClient
    let row: PathwayWorkspacePullRequestRow
    @State private var detail: PathwayWorkspacePullRequestDetail?
    @State private var candidates: PathwayWorkspaceReviewerCandidates?
    @State private var query = ""
    @State private var identifier = ""
    @State private var requested = true
    @State private var pending: Request?
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    private struct Request { let id: String; let kind: String; let label: String; let requested: Bool }
    private var visibleCandidates: [PathwayWorkspaceReviewerCandidates.Candidate] {
        (candidates?.candidates ?? []).filter { query.isEmpty || $0.login.localizedCaseInsensitiveContains(query) || ($0.name?.localizedCaseInsensitiveContains(query) ?? false) }
    }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Text(notice).foregroundStyle(.secondary) }
            if busy { ProgressView("Loading reviewers…") }
            if let detail {
                if !detail.canRequestReviewers { Text("Your account cannot change reviewer requests for this pull request.") }
                if detail.capabilities.reviewers.listCandidates {
                    ForEach(visibleCandidates, id: \.identity) { candidate in
                        Button {
                            pending = .init(id: candidate.id, kind: candidate.kind, label: candidate.login, requested: !candidate.isRequested)
                        } label: {
                            VStack(alignment: .leading) {
                                Label(candidate.login, systemImage: candidate.isRequested ? "checkmark.circle.fill" : (candidate.kind == "team" ? "person.3" : "person"))
                                if let name = candidate.name { Text(name).font(.caption).foregroundStyle(.secondary) }
                                Text(candidate.isRequested ? "Take back review request" : "Request review").font(.caption)
                            }
                        }.disabled(busy || !detail.canRequestReviewers || !client.context.canMutate)
                    }
                    if candidates?.truncated == true { Text("More reviewers are available on the provider. Search filters only this list.").font(.caption).foregroundStyle(.secondary) }
                } else if detail.canRequestReviewers {
                    Section("Reviewer") {
                        TextField("Reviewer email or provider ID", text: $identifier).autocorrectionDisabled().textInputAutocapitalization(.never)
                        Picker("Action", selection: $requested) { Text("Request review").tag(true); Text("Take back request").tag(false) }
                        Button("Continue") { pending = .init(id: identifier.trimmingCharacters(in: .whitespacesAndNewlines), kind: "user", label: identifier, requested: requested) }
                            .disabled(identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy || !client.context.canMutate)
                        Text("This provider accepts a reviewer identifier but does not publish a candidate list.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.navigationTitle("Reviewers").searchable(text: $query)
            .task { await load() }.refreshable { await load() }
            .confirmationDialog("\(pending?.requested == false ? "Take back review request" : "Request review") from \(pending?.label ?? "reviewer")?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })) {
                Button(pending?.requested == false ? "Take back request" : "Request review") {
                    if let pending { self.pending = nil; Task { await apply(pending) } }
                }
                Button("Cancel", role: .cancel) { pending = nil }
            }
    }
    private func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { try await refresh(); error = nil } catch { self.error = error.localizedDescription }
    }
    private func refresh() async throws {
        let latest: PathwayWorkspacePullRequestDetail = try await client.call("pullRequests.detail", row.payload)
        detail = latest
        if latest.capabilities.reviewers.listCandidates { candidates = try await client.call("pullRequests.reviewerCandidates", row.payload) }
        else { candidates = nil }
    }
    private func apply(_ request: Request) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let latest: PathwayWorkspacePullRequestDetail = try await client.call("pullRequests.detail", row.payload)
            detail = latest
            guard latest.canRequestReviewers else { throw PathwayRPCError.remote("Reviewer requests are no longer available for your account.") }
            var payload = row.payload
            payload["reviewers"] = .array([.object(["id": .string(request.id), "kind": .string(request.kind)])])
            payload["requested"] = .bool(request.requested)
            _ = try await client.run("pullRequests.requestReviewers", payload)
            notice = request.requested ? "Review requested from \(request.label)" : "Review request taken back from \(request.label)"
            error = nil
            try await refresh()
        } catch { self.error = error.localizedDescription }
    }
}
