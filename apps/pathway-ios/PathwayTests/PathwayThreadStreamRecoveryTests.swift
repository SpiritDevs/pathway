import Foundation
import Observation
@testable import Pathway
import Testing

/// A thread whose live stream ends on its own recovers while the conversation stays open.
@MainActor
struct PathwayThreadStreamRecoveryTests {
    @Test func aStreamThatFellBehindResubscribesAndGatesActionsUntilTheNewMarker() async throws {
        let streams = ThreadStreams()
        let model = makeModel(streams)
        model.start()
        let first = await streams.next()
        first.yield(snapshot(text: "Before"))
        first.yield(.object(["kind": .string("synchronized")]))
        await waitUntil { model.items.count == 2 }
        let approval = try #require(model.items.first { $0.type == "approval_request" })
        #expect(model.canRespond(to: approval))

        first.finish(throwing: PathwayRPCError.overflowed)
        let second = await streams.next()
        // The previous timeline stays visible, but nothing live is offered until the new stream synchronizes.
        #expect(model.items.map(\.id) == ["message", "approval"])
        #expect(!model.isSubscriptionReady)
        #expect(model.connectionState == .cached)
        #expect(!model.canRespond(to: approval))

        second.yield(snapshot(text: "After"))
        await waitUntil { model.items.first?.text == "After" }
        #expect(!model.canRespond(to: approval))
        second.yield(.object(["kind": .string("synchronized")]))
        await waitUntil { model.isSubscriptionReady }
        #expect(model.connectionState == .live)
        #expect(model.canRespond(to: approval))
        #expect(streams.opened == 2)
        await model.stop()
    }

    @Test func repeatedOverflowBacksOffAndResetsAfterSynchronizing() async throws {
        let streams = ThreadStreams()
        let model = makeModel(streams)
        var attempts: [Int] = []
        model.streamRecoveryDelay = { attempts.append($0); return .zero }
        model.start()
        await streams.next().finish(throwing: PathwayRPCError.overflowed)
        await streams.next().finish(throwing: PathwayRPCError.overflowed)
        let third = await streams.next()
        third.yield(.object(["kind": .string("synchronized")]))
        await waitUntil { model.isSubscriptionReady }
        third.finish(throwing: PathwayRPCError.overflowed)
        _ = await streams.next()
        #expect(attempts == [1, 2, 1])
        await model.stop()
    }

    @Test func backoffIsCapped() {
        #expect(PathwayAgentThreadModel.defaultStreamRecoveryDelay(1) == .milliseconds(250))
        #expect(PathwayAgentThreadModel.defaultStreamRecoveryDelay(3) == .milliseconds(1_000))
        #expect(PathwayAgentThreadModel.defaultStreamRecoveryDelay(5) == .seconds(4))
        #expect(PathwayAgentThreadModel.defaultStreamRecoveryDelay(6) == .seconds(5))
        #expect(PathwayAgentThreadModel.defaultStreamRecoveryDelay(60) == .seconds(5))
    }

    @Test func stoppingDuringTheBackoffCancelsTheRestart() async throws {
        let streams = ThreadStreams()
        let model = makeModel(streams)
        let waiting = AsyncStream<Void>.makeStream()
        model.streamRecoveryDelay = { _ in waiting.continuation.yield(()); return .seconds(60) }
        model.start()
        await streams.next().finish(throwing: PathwayRPCError.overflowed)
        var delays = waiting.stream.makeAsyncIterator()
        _ = await delays.next()
        await model.stop()
        #expect(streams.opened == 1)
        // A later explicit start opens one fresh stream.
        model.start()
        _ = await streams.next()
        #expect(streams.opened == 2)
        await model.stop()
        waiting.continuation.finish()
    }

    @Test func anUnrecoverableEndFailsVisiblyAndReleasesTheStreamForTheNextStart() async throws {
        let streams = ThreadStreams()
        let model = makeModel(streams)
        model.start()
        let first = await streams.next()
        first.yield(snapshot(text: "Saved"))
        first.finish(throwing: PathwayRPCError.remote("Thread not found."))
        await waitUntil { if case .failed = model.connectionState { true } else { false } }
        #expect(model.connectionState == .failed("Thread not found."))
        #expect(model.items.first?.text == "Saved")
        #expect(streams.opened == 1)
        // Reopening the conversation is not blocked by the finished task.
        model.start()
        _ = await streams.next()
        #expect(streams.opened == 2)
        await model.stop()
    }

    private func makeModel(_ streams: ThreadStreams) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let model = PathwayAgentThreadModel(thread: thread, environment: environment, request: { _, _ in .object([:]) })
        model.threadStreamOverride = { streams.open() }
        model.streamRecoveryDelay = { _ in .zero }
        return model
    }

    private func snapshot(text: String) -> JSONValue {
        let message: JSONValue = .object(["id": .string("message"), "ordinal": .number(1), "type": .string("assistant_message"), "text": .string(text)])
        let approval: JSONValue = .object(["id": .string("approval"), "ordinal": .number(2), "type": .string("approval_request"),
                                           "status": .string("waiting"), "requestId": .string("request-1")])
        let request: JSONValue = .object(["id": .string("request-1"), "status": .string("pending"),
                                          "responseCapability": .object(["type": .string("live"), "providerSessionId": .string("session")])])
        return .object(["kind": .string("snapshot"), "snapshotSequence": .number(1), "projection": .object([
            "visibleTurnItems": .array([.object(["item": message]), .object(["item": approval])]),
            "runtimeRequests": .array([request])
        ])])
    }
}

/// Hands each stream the model opens to the test, in order.
@MainActor
final class ThreadStreams {
    typealias Continuation = AsyncThrowingStream<JSONValue, Error>.Continuation
    private(set) var opened = 0
    private var ready: [Continuation] = []
    private var waiter: CheckedContinuation<Continuation, Never>?

    func open() -> AsyncThrowingStream<JSONValue, Error> {
        opened += 1
        let pair = AsyncThrowingStream<JSONValue, Error>.makeStream()
        if let waiter { self.waiter = nil; waiter.resume(returning: pair.continuation) } else { ready.append(pair.continuation) }
        return pair.stream
    }

    func next() async -> Continuation {
        if !ready.isEmpty { return ready.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

/// Waits for observed model state instead of sleeping.
@MainActor
func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
    while !condition() {
        await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
            withObservationTracking { _ = condition() } onChange: { resume.resume() }
        }
    }
}
