import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayQueuedThreadActionsTests {
    @Test func removingCanceledEntryPersistsButRetriedWorkReappears() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = model()
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        let canceled = row(state: "canceled")
        try await queue.removeCanceledThread(canceled)
        #expect(!queue.isVisible(canceled))
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        #expect(!queue.isVisible(canceled))
        #expect(queue.isVisible(row(state: "queued")))
        #expect(queue.isVisible(row(state: "canceled", updated: 2)))
        await #expect(throws: (any Error).self) { try await queue.removeCanceledThread(row(state: "queued")) }
        queue.stop(clear: true)
        #expect(queue.isVisible(canceled))
    }

    @Test func cancelsLaunchUsingItsFreshMessageRevision() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var canceled: [JSONValue] = []
        let queue = PathwayThreadQueueModel(request: { _, method, args in
            if method == "threadQueue:getThread" {
                return .object(["messages": .array([.object([
                    "commandId": .string("launch-command"), "revision": .number(7), "state": .string("queued"),
                    "submission": .object(["kind": .string("launch")])
                ])])])
            }
            #expect(method == "threadQueue:cancel")
            canceled.append(args)
            return .null
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        try await queue.cancelThread(row(state: "queued"))
        #expect(canceled.count == 1)
        #expect(canceled.first?.objectValue?["commandId"] == .string("launch-command"))
        #expect(canceled.first?.objectValue?["revision"] == .number(7))
        #expect(canceled.first?.objectValue?["queueId"] == .string("queue"))
        queue.stop(clear: true)
    }

    @Test func acceptedMessageCannotBeHiddenOrCanceledAsPending() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = PathwayThreadQueueModel(request: { _, method, _ in
            #expect(method == "threadQueue:getThread")
            return .object(["messages": .array([.object(["commandId": .string("command"), "revision": .number(1), "state": .string("accepted")])])])
        }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        await #expect(throws: (any Error).self) { try await queue.cancelThread(row(state: "queued")) }
        #expect(queue.isVisible(row(state: "queued")))
        queue.stop(clear: true)
    }

    private func row(state: String, updated: Int = 1) -> PathwayQueuedThread {
        .init(companyID: "company", fields: ["queueId": .string("queue"), "environmentId": .string("environment"),
            "threadId": .string("thread"), "state": .string(state), "revision": .number(1), "updatedAt": .number(Double(updated))])
    }

    private func model() -> PathwayThreadQueueModel {
        .init(request: { _, _, _ in throw URLError(.notConnectedToInternet) }, subscribe: { _, _ in AsyncThrowingStream { _ in } })
    }
}
