import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadQueueTests {
    @Test func queuedPromptAndAttachmentSurviveRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayThreadQueueStore(directory: directory)
        let entry = PathwayLocalQueueEntry(companyID: "company", environmentID: "offline", threadID: "thread", commandID: "command",
                                           submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string("Keep this prompt")])]),
                                           files: [PathwayQueueFile(metadata: .object(["id": .string("file")]), data: Data("context".utf8), cloudID: "uploaded")])
        try await store.save([entry])
        let restored = try await PathwayThreadQueueStore(directory: directory).load()
        #expect(restored.count == 1)
        #expect(restored.first?.submission == entry.submission)
        #expect(restored.first?.files.first?.data == Data("context".utf8))
        #expect(restored.first?.files.first?.cloudID == "uploaded")
        #expect(restored.first?.commandID == "command")
    }

    @Test func accountChangeClearsVisiblePendingWork() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        try await model.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string("Private")])]))
        #expect(model.threads.first?.status == "Waiting to sync")
        await model.configure(directory: nil)
        #expect(model.threads.isEmpty)
        await #expect(throws: (any Error).self) {
            try await model.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                    submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command2")])]))
        }
    }

    @Test func captureRejectsMissingAttachmentBytes() throws {
        let draft = PathwayThreadAttachmentDraft(id: "attachment", name: "context.txt", mimeType: "text/plain", type: "file", sizeBytes: 7, state: .failed("Offline"))
        #expect(throws: (any Error).self) { try PathwayQueueFile.capture(draft, bytes: nil) }
        let captured = try PathwayQueueFile.capture(draft, bytes: Data("context".utf8))
        #expect(captured.metadata.objectValue?["sizeBytes"]?.intValue == 7)
    }
}

@MainActor
private final class QueueDestinationGate {
    private var response: CheckedContinuation<JSONValue, any Error>?
    private var started: CheckedContinuation<Void, Never>?
    private var didStart = false

    func request() async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            response = continuation; didStart = true; started?.resume(); started = nil
        }
    }

    func waitUntilStarted() async {
        if didStart { return }
        await withCheckedContinuation { started = $0 }
    }

    func resume(_ value: JSONValue) { response?.resume(returning: value); response = nil }
}

extension PathwayThreadQueueTests {
    @Test func destinationResponseFromPreviousAccountIsDiscarded() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = QueueDestinationGate()
        let model = PathwayThreadQueueModel(request: { _, _, _ in try await gate.request() },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        let request = Task { try await model.destinations(companyID: "company") }
        await gate.waitUntilStarted()
        await model.configure(directory: nil)
        gate.resume(.array([.string("private environment")]))
        await #expect(throws: CancellationError.self) { try await request.value }
        #expect(model.threads.isEmpty)
    }

    @Test func unsentLocalLaunchCanBeCanceledWithItsFollowups() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayThreadQueueStore(directory: directory)
        let files = [PathwayQueueFile(metadata: .object(["id": .string("file")]), data: Data("context".utf8))]
        let launch = PathwayLocalQueueEntry(companyID: "company", environmentID: "offline", threadID: "thread", commandID: "launch",
                                            submission: .object(["kind": .string("launch"), "input": .object(["commandId": .string("launch"), "title": .string("Keep until canceled")])]), files: files)
        let followup = PathwayLocalQueueEntry(companyID: "company", environmentID: "offline", threadID: "thread", commandID: "followup",
                                              submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("followup"), "text": .string("More context")])]), files: [])
        try await store.save([launch, followup])
        let model = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        let thread = try #require(model.threads.first)
        try await model.mutate("cancel", thread: thread, fields: ["commandId": .string("launch"), "revision": .number(0)])
        #expect(model.threads.isEmpty)
        #expect(try await store.load().isEmpty)
        model.stop(clear: true)
    }

    @Test func lostCloudAcknowledgementKeepsOriginalMessageAndPreventsUnsafeLocalEdits() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayThreadQueueStore(directory: directory)
        let entry = PathwayLocalQueueEntry(companyID: "company", environmentID: "offline", threadID: "thread", commandID: "command",
                                           submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string("Keep original")])]),
                                           files: [], submissionStarted: true)
        try await store.save([entry])
        let model = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        let thread = try #require(model.threads.first)
        await #expect(throws: (any Error).self) {
            try await model.mutate("cancel", thread: thread, fields: ["commandId": .string("command"), "revision": .number(0)])
        }
        let detail = try await model.detail(thread)
        #expect(detail.objectValue?["messages"]?.arrayValue?.first?.objectValue?["editable"] == .bool(false))
        #expect(try await store.load().first?.commandID == "command")
        model.stop(clear: true)
    }
}

extension PathwayThreadQueueTests {
    @Test func cloudQueueStagesAttachmentBytesWithoutEnvironmentConnection() async throws {
        let attachments = PathwayNewThreadAttachments(directory: nil, key: "offline")
        attachments.usesCloudQueue = true
        attachments.supportsUploads = false
        attachments.isConnected = false
        attachments.request = { _, _ in
            Issue.record("Cloud queued attachments must not contact the disconnected environment.")
            throw URLError(.notConnectedToInternet)
        }
        await attachments.add(data: Data("context".utf8), name: "context.txt", mimeType: "text/plain")
        let draft = try #require(attachments.drafts.first)
        #expect(draft.state == .ready)
        #expect(attachments.bytes[draft.id] == Data("context".utf8))
        #expect(attachments.errorMessage == nil)
    }
}

extension PathwayThreadQueueTests {
    @Test func deliveredReceiptReconcilesLostAcknowledgementWhenQueueDetailOmitsBody() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayThreadQueueStore(directory: directory)
        let entry = PathwayLocalQueueEntry(companyID: "company", environmentID: "offline", threadID: "thread", commandID: "command",
                                           submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string("Already delivered")])]),
                                           files: [], submissionStarted: true)
        try await store.save([entry])
        let model = PathwayThreadQueueModel(request: { _, path, _ in
            if path == "threadQueue:getThread" { return .object(["messages": .array([])]) }
            if path == "threadQueue:submissionStatus" { return .object(["commandId": .string("command"), "state": .string("delivered")]) }
            throw URLError(.notConnectedToInternet)
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        let detail = try await model.detail(#require(model.threads.first))
        #expect(detail.objectValue?["messages"]?.arrayValue?.isEmpty == true)
        #expect(try await store.load().isEmpty)
        #expect(model.threads.first?.state == "delivered")
        model.stop(clear: true)
    }
}

extension PathwayThreadQueueTests {
    @Test func failedLocalCaptureCannotLaterBeSubmittedByRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = PathwayThreadQueueModel(request: { _, _, _ in
            Issue.record("An unsaved draft must never reach the cloud.")
            throw URLError(.notConnectedToInternet)
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await model.configure(directory: directory)
        model.observe(companies: ["company"])
        try Data("not a directory".utf8).write(to: directory)
        await #expect(throws: (any Error).self) {
            try await model.enqueue(companyID: "company", environmentID: "offline", threadID: "thread",
                                    submission: .object(["kind": .string("message"), "input": .object(["commandId": .string("command"), "text": .string("Keep in composer")])]))
        }
        #expect(model.threads.isEmpty)
        try FileManager.default.removeItem(at: directory)
        model.retry()
        #expect(try await PathwayThreadQueueStore(directory: directory).load().isEmpty)
        model.stop(clear: true)
    }
}
