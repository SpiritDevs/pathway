import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayPullRequestListRaceTests {
    @Test(arguments: [false, true])
    func newerStateLoadsWhileOldRequestIsOutstanding(cancelOld: Bool) async {
        let harness = PendingPullRequests()
        let listing = PathwayWorkspacePullRequestListModel()
        var events = harness.events.makeAsyncIterator()
        let first = Task { await listing.load(client: harness.client, state: "open", query: "", more: false) }
        #expect(await events.next() == "open")
        if cancelOld { first.cancel() }
        let second = Task { await listing.load(client: harness.client, state: "closed", query: "", more: false) }
        #expect(await events.next() == "closed")
        harness.complete("open")
        await first.value
        #expect(listing.busy)
        #expect(listing.rows.isEmpty)
        harness.complete("closed")
        await second.value
        #expect(!listing.busy)
        #expect(listing.rows.map(\.state) == ["closed"])
        #expect(listing.error == nil)
    }
    @Test func lateFailureDoesNotReplaceTheNewerSuccessfulState() async {
        let harness = PendingPullRequests()
        let listing = PathwayWorkspacePullRequestListModel()
        var events = harness.events.makeAsyncIterator()
        let first = Task { await listing.load(client: harness.client, state: "open", query: "", more: false) }
        #expect(await events.next() == "open")
        let second = Task { await listing.load(client: harness.client, state: "merged", query: "", more: false) }
        #expect(await events.next() == "merged")
        harness.complete("merged")
        await second.value
        harness.fail("open")
        await first.value
        #expect(listing.rows.map(\.state) == ["merged"])
        #expect(listing.error == nil)
        #expect(!listing.busy)
    }
}

@MainActor
private final class PendingPullRequests {
    let events: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]
    init() {
        let stream = AsyncStream<String>.makeStream()
        events = stream.stream; continuation = stream.continuation
    }
    var client: PathwayWorkspaceClient {
        var context = PathwayWorkspaceContext(threadID: "thread", projectID: "project", cwd: "/workspace", projectRoot: "/workspace")
        context.supportsPullRequests = true
        return PathwayWorkspaceClient(context: context) { method, payload in
            #expect(method == "pullRequests.list")
            let state = payload.objectValue?["state"]?.stringValue ?? "missing"
            return try await withCheckedThrowingContinuation { reply in
                self.pending[state] = reply
                self.continuation.yield(state)
            }
        }
    }
    func complete(_ state: String) {
        let row: JSONValue = .object(["host": .string("github"), "projectId": .string("project"), "repository": .string("owner/repo"), "number": .number(1), "title": .string(state), "state": .string(state), "isDraft": .bool(false), "url": .string("https://example.com/pr/1")])
        pending.removeValue(forKey: state)?.resume(returning: .object(["entries": .array([row]), "errors": .array([]), "truncated": .bool(false), "nextCursors": .object([:])]))
    }
    func fail(_ state: String) { pending.removeValue(forKey: state)?.resume(throwing: PathwayRPCError.remote("Old request failed")) }
}
