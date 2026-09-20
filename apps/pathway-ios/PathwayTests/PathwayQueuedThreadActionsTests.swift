import Foundation
import Observation
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
        try await queue.removeFinishedThread(canceled)
        #expect(!queue.isVisible(canceled))
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        #expect(!queue.isVisible(canceled))
        #expect(queue.isVisible(row(state: "queued")))
        #expect(queue.isVisible(row(state: "canceled", updated: 2)))
        await #expect(throws: (any Error).self) { try await queue.removeFinishedThread(row(state: "queued")) }
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

    @Test func deliveredEntryCanBeRemovedWithoutCancelingEnvironmentWork() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = model()
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        let delivered = row(state: "delivered")
        #expect(delivered.status == "Sent to environment")
        #expect(delivered.canRemoveFromList)
        try await queue.removeFinishedThread(delivered)
        #expect(!queue.isVisible(delivered))
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        #expect(!queue.isVisible(delivered))
        #expect(queue.isVisible(row(state: "queued")))
        #expect(queue.isVisible(row(state: "delivered", updated: 2)))
        var withPending = delivered.fields
        withPending["localCount"] = .number(1)
        let pending = PathwayQueuedThread(companyID: "company", fields: withPending)
        #expect(queue.isVisible(pending))
        await #expect(throws: (any Error).self) { try await queue.removeFinishedThread(pending) }
        await #expect(throws: (any Error).self) { try await queue.removeFinishedThread(row(state: "accepted")) }
        queue.stop(clear: true)
    }

    @Test(arguments: ["delivered", "canceled", "accepted"])
    func cancellationRefreshesStaleQueueState(state: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stale = row(state: "queued")
        let fresh = row(state: state, updated: 2)
        let queue = PathwayThreadQueueModel(request: { _, method, _ in
            #expect(method == "threadQueue:getThread")
            return .object(["thread": .object(fresh.fields), "messages": .array([])])
        }, subscribe: { _, _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.object(["page": .array([.object(stale.fields)]), "isDone": .bool(true)]))
            }
        })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company"])
        await withCheckedContinuation { continuation in
            withObservationTracking { _ = queue.threads } onChange: { continuation.resume() }
        }
        #expect(queue.threads.first?.state == "queued")
        if state == "canceled" {
            try await queue.cancelThread(stale)
        } else {
            do {
                try await queue.cancelThread(stale)
                Issue.record("Delivered or accepted work must not report successful cancellation")
            } catch {
                #expect(error.localizedDescription.contains(state == "delivered" ? "already sent" : "already accepted"))
            }
        }
        #expect(queue.threads.first?.state == state)
        #expect(queue.threads.first?.canRemoveFromList == (state != "accepted"))
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
