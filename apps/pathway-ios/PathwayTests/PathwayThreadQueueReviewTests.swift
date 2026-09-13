import Foundation
import Observation
@testable import Pathway
import Testing

extension PathwayThreadQueueTests {
    @Test func failedThreadDoesNotBlockOtherThreadsOrCompanies() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayThreadQueueStore(directory: directory)
        let entries = [("one", "bad", "first"), ("one", "bad", "followup"), ("one", "good", "second"), ("two", "good", "third")].map { company, thread, command in
            PathwayLocalQueueEntry(companyID: company, environmentID: "offline", threadID: thread, commandID: command,
                                   submission: .object(["kind": .string("message"), "input": .object(["commandId": .string(command)])]), files: [])
        }
        try await store.save(entries)
        var submitted: [String] = []
        let model = PathwayThreadQueueModel(request: { _, path, args in
            if path == "threadQueue:getThread" { return .object(["thread": .object(["threadId": .string("good")])]) }
            let command = args.objectValue?["submission"]?.objectValue?["input"]?.objectValue?["commandId"]?.stringValue ?? ""
            submitted.append(command)
            if command == "first" { throw URLError(.notConnectedToInternet) }
            return .object([:])
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["one", "two"])
        try await model.requireCloudSavedThread(companyID: "two", environmentID: "offline", threadID: "good")
        #expect(submitted == ["first", "second", "third"])
        #expect(try await store.load().map(\.commandID) == ["first", "followup"])
        model.stop(clear: true)
    }

    @Test func cloudSavedGateWaitsForReceiptAndRejectsDeviceOnlyThread() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = QueueDestinationGate()
        var published = false
        var cloudSaved = false
        let queue = PathwayThreadQueueModel(request: { _, path, _ in
            if path == "threadQueue:enqueue" {
                let result = try await gate.request()
                cloudSaved = true
                return result
            }
            return cloudSaved ? .object(["thread": .object(["threadId": .string("thread")])]) : .null
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        await #expect(throws: (any Error).self) {
            try await queue.requireCloudSavedThread(companyID: "company", environmentID: "offline", threadID: "thread")
        }
        try await queue.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                submission: .object(["kind": .string("launch"), "input": .object(["commandId": .string("launch")])]))
        let link = Task {
            try await queue.requireCloudSavedThread(companyID: "company", environmentID: "offline", threadID: "thread")
            published = true
        }
        await gate.waitUntilStarted()
        #expect(!published)
        gate.resume(.object([:]))
        try await link.value
        #expect(published)
        queue.stop(clear: true)
    }

    @Test func repeatedPlanImplementationKeepsOneDurableIdentityAfterRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company-1"])
        let item = try #require(PathwayTimelineItem(json: .object(["id": .string("plan-item"), "type": .string("proposed_plan"), "planId": .string("plan")])))
        let snapshot: JSONValue = .object(["plans": .array([.object(["id": .string("plan"), "kind": .string("proposed_plan"), "status": .string("active"), "markdown": .string("Build it")])])])
        let first = queueConversationModel()
        first.threadQueue = queue
        first.installSnapshot(snapshot, sequence: 1)
        try await first.implementPlan(item)
        try await first.implementPlan(item)
        let original = try await PathwayThreadQueueStore(directory: directory).load()
        #expect(original.count == 1)
        queue.stop(clear: true)
        await queue.configure(directory: directory)
        queue.observe(companies: ["company-1"])
        let reopened = queueConversationModel()
        reopened.threadQueue = queue
        reopened.installSnapshot(snapshot, sequence: 1)
        try await reopened.implementPlan(item)
        let restored = try await PathwayThreadQueueStore(directory: directory).load()
        #expect(restored.count == 1)
        #expect(restored.first?.commandID == original.first?.commandID)
        queue.stop(clear: true)
    }

    @Test func scopedIdentityKeepsSameThreadOnDifferentEnvironmentsSeparate() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let entries = ["mac", "server"].map { environment in
            PathwayLocalQueueEntry(companyID: "company", environmentID: environment, threadID: "thread", commandID: "command",
                                   submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string(environment)])]), files: [])
        }
        try await PathwayThreadQueueStore(directory: directory).save(entries)
        let queue = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        #expect(Set(queue.threads.map(\.id)).count == 2)
        let thread = try #require(queue.threads.first { $0.environmentID == "mac" })
        #expect(queue.cachedDetail(thread).objectValue?["messages"]?.arrayValue?.count == 1)
        try await queue.mutate("cancel", thread: thread, fields: ["commandId": .string("command"), "revision": .number(0)])
        #expect(queue.threads.map(\.environmentID) == ["server"])
        queue.stop(clear: true)
    }

    @Test func rejectionProofAllowsCancelWithoutEditingAcceptedMessage() throws {
        let model = queueConversationModel()
        model.cloudQueueMessages = [.object(["commandId": .string("command"), "state": .string("blocked"), "acceptedAt": .number(1), "rejection": .string("command"),
                                             "submission": .object(["kind": .string("message"), "input": .object(["messageId": .string("message"), "text": .string("Rejected")])])])]
        let item = try #require(model.conversationItems.first)
        #expect(!model.canEditCloudQueueMessage(item))
        #expect(model.canCancelCloudQueueMessage(item))
        var fields = try #require(model.cloudQueueMessages.first?.objectValue)
        fields["rejection"] = .null
        model.cloudQueueMessages = [.object(fields)]
        #expect(!model.canCancelCloudQueueMessage(item))
    }
}

@MainActor
private final class QueuePageFeed {
    private var streams: [String: AsyncThrowingStream<JSONValue, Error>.Continuation] = [:]
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]

    func subscribe(_ args: JSONValue) -> AsyncThrowingStream<JSONValue, Error> {
        let cursor = args.objectValue?["paginationOpts"]?.objectValue?["cursor"]?.stringValue ?? "first"
        return AsyncThrowingStream { continuation in
            streams[cursor] = continuation
            waiting.removeValue(forKey: cursor)?.resume()
        }
    }

    func waitForPage(_ cursor: String) async {
        if streams[cursor] != nil { return }
        await withCheckedContinuation { waiting[cursor] = $0 }
    }

    func send(_ cursor: String, rows: [String], next: String?) {
        streams[cursor]?.yield(.object(["page": .array(rows.map { .object([
            "queueId": .string($0), "threadId": .string($0), "environmentId": .string("offline")
        ]) }), "isDone": .bool(next == nil), "continueCursor": .string(next ?? "")]))
    }
}

extension PathwayThreadQueueTests {
    @Test func paginatedQueueKeepsEveryPageReactiveAndDropsObsoleteBoundaries() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let feed = QueuePageFeed()
        let queue = PathwayThreadQueueModel(request: { _, _, _ in .null }, subscribe: { path, args in
            #expect(path == "threadQueue:listPage")
            #expect(args.objectValue?["paginationOpts"]?.objectValue?["numItems"]?.intValue == 64)
            return feed.subscribe(args)
        })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        await feed.waitForPage("first")
        feed.send("first", rows: ["one"], next: "second")
        await feed.waitForPage("second")
        feed.send("second", rows: ["two"], next: "third")
        await feed.waitForPage("third")
        #expect(Set(queue.threads.map(\.threadID)) == ["one", "two"])
        feed.send("first", rows: ["replacement"], next: nil)
        await waitForQueue(queue) { $0.map(\.threadID) == ["replacement"] }
        feed.send("second", rows: ["stale"], next: nil)
        #expect(queue.threads.map(\.threadID) == ["replacement"])
        queue.stop(clear: true)
    }

    @Test func registryChangeDuringRejectedSubmissionTriggersAnotherDrain() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = QueueDestinationGate()
        let second = QueueDestinationGate()
        var attempts = 0
        let queue = PathwayThreadQueueModel(request: { _, path, _ in
            if path == "threadQueue:enqueue" {
                attempts += 1
                if attempts == 1 {
                    _ = try await first.request()
                    throw PathwayThreadQueueRejected(code: "thread-unavailable", message: "Waiting for shell")
                }
                return try await second.request()
            }
            if path == "threadQueue:getThread" { return .object(["thread": .object(["threadId": .string("thread")])]) }
            return .null
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        try await queue.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command")])]))
        await first.waitUntilStarted()
        queue.retry()
        first.resume(.null)
        await second.waitUntilStarted()
        second.resume(.object([:]))
        try await queue.requireCloudSavedThread(companyID: "company", environmentID: "offline", threadID: "thread")
        #expect(attempts == 2)
        #expect(try await PathwayThreadQueueStore(directory: directory).load().isEmpty)
        queue.stop(clear: true)
    }

    @Test func provenSubmissionConflictWithoutCloudReceiptReopensLocalEditing() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = PathwayThreadQueueModel(request: { _, path, _ in
            if path == "threadQueue:enqueue" { throw PathwayThreadQueueRejected(code: "submission-conflict", message: "Conflict") }
            return .null
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        try await queue.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command")])]))
        await #expect(throws: (any Error).self) {
            try await queue.requireCloudSavedThread(companyID: "company", environmentID: "offline", threadID: "thread")
        }
        let entry = try #require(await PathwayThreadQueueStore(directory: directory).load().first)
        #expect(entry.submissionStarted == false)
        queue.stop(clear: true)
    }

    private func waitForQueue(_ queue: PathwayThreadQueueModel, until predicate: @escaping @MainActor ([PathwayQueuedThread]) -> Bool) async {
        while !predicate(queue.threads) {
            await withCheckedContinuation { receipt in
                withObservationTracking { _ = queue.threads } onChange: {
                    Task { @MainActor in receipt.resume() }
                }
            }
        }
    }
}
