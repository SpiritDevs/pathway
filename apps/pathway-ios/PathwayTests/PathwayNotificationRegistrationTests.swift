import Foundation
import Testing
@testable import Pathway

@MainActor struct PathwayNotificationRegistrationTests {
    @Test func newerSnapshotsCoalesceBehindOneInflightWrite() async throws {
        let writer = PathwayNotificationRegistrationWriter()
        let entered = AsyncStream<Int>.makeStream()
        let queued = AsyncStream<Int>.makeStream()
        let gate = RegistrationTestGate()
        var written: [JSONValue] = []
        let write: PathwayNotificationRegistrationWriter.Write = { payload, _ in
            written.append(payload)
            entered.continuation.yield(written.count)
            if written.count == 1 { await gate.wait() }
        }
        let first = Task { try await writer.submit(.string("old"), write: write) }
        var entries = entered.stream.makeAsyncIterator()
        #expect(await entries.next() == 1)
        var latest = 0
        let tasks = (1...20).map { value in
            Task {
                latest = value
                queued.continuation.yield(value)
                return try await writer.submit(.number(Double(value)), write: write)
            }
        }
        var queuedEntries = queued.stream.makeAsyncIterator()
        for _ in tasks { _ = await queuedEntries.next() }
        let expectedLatest = latest
        #expect(written == [.string("old")])
        gate.release()
        _ = try await first.value
        for task in tasks { _ = try await task.value }
        #expect(written == [.string("old"), .number(Double(expectedLatest))])
        #expect(!writer.isBusy)
        entered.continuation.finish(); queued.continuation.finish()
    }

    @Test func signoutFencesQueuedWritesAndWaitsForInflightWriteBeforeCleanup() async throws {
        let writer = PathwayNotificationRegistrationWriter()
        let entered = AsyncStream<Void>.makeStream()
        let queued = AsyncStream<Void>.makeStream()
        let gate = RegistrationTestGate()
        var operations: [String] = []
        let first = Task {
            try await writer.submit(.string("old")) { _, _ in
                operations.append("post-start")
                entered.continuation.yield(())
                await gate.wait()
                operations.append("post-finish")
            }
        }
        var entries = entered.stream.makeAsyncIterator(); _ = await entries.next()
        let next = Task {
            queued.continuation.yield(())
            return try await writer.submit(.string("queued")) { _, _ in operations.append("unexpected-post") }
        }
        var queuedEntries = queued.stream.makeAsyncIterator(); _ = await queuedEntries.next()
        let drain = writer.fence()
        let cleanup = Task { await drain?.value; operations.append("delete") }
        #expect(operations == ["post-start"])
        gate.release()
        await cleanup.value
        do { _ = try await first.value; Issue.record("Expected fenced registration") } catch is CancellationError {}
        do { _ = try await next.value; Issue.record("Expected fenced registration") } catch is CancellationError {}
        #expect(operations == ["post-start", "post-finish", "delete"])
        await #expect(throws: CancellationError.self) { try await writer.submit(.null) { _, _ in Issue.record("Stopped writer ran") } }
        writer.resume()
        #expect(try await writer.submit(.string("new-account")) { _, _ in operations.append("new-account") })
        #expect(operations.last == "new-account")
        entered.continuation.finish(); queued.continuation.finish()
    }

    @Test func cleanupRequirementSurvivesCoalescedNewTokenSnapshot() async throws {
        let writer = PathwayNotificationRegistrationWriter()
        let entered = AsyncStream<Void>.makeStream()
        let queued = AsyncStream<Void>.makeStream()
        let gate = RegistrationTestGate()
        var resets: [Bool] = []
        let first = Task {
            try await writer.submit(.string("first")) { _, reset in
                resets.append(reset); entered.continuation.yield(()); await gate.wait()
            }
        }
        var entries = entered.stream.makeAsyncIterator(); _ = await entries.next()
        let reset = Task {
            queued.continuation.yield(())
            return try await writer.submit(.string("remove-live-token"), reset: true) { _, value in resets.append(value) }
        }
        var queuedEntries = queued.stream.makeAsyncIterator(); _ = await queuedEntries.next()
        let newest = Task {
            queued.continuation.yield(())
            return try await writer.submit(.string("new-preferences")) { _, value in resets.append(value) }
        }
        _ = await queuedEntries.next()
        gate.release()
        _ = try await first.value; _ = try await reset.value; _ = try await newest.value
        #expect(resets == [false, true])
        entered.continuation.finish(); queued.continuation.finish()
    }
}

@MainActor private final class RegistrationTestGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        guard !released else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}
