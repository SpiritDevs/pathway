import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayIssueEnvironmentClientTests {
    @Test func lateOldStreamErrorCannotRemoveReplacementClient() async throws {
        let stopGate = IssueClientGate()
        let old = ControlledIssueRPC(name: "old", stopGate: stopGate)
        let replacement = ControlledIssueRPC(name: "replacement")
        var created = 0
        let client = PathwayIssueEnvironmentClient { _, _ in
            created += 1
            return created == 1 ? old : replacement
        }
        _ = try await request(client)
        let stopping = Task { await client.stop() }
        await stopGate.waitUntilEntered()
        #expect(try await request(client) == .string("replacement"))
        var stopped = old.stopEvents.makeAsyncIterator()
        #expect(await stopped.next() == 1)
        await stopGate.release()
        await stopping.value
        // The old stream's cleanup has run once its own second stop call arrives.
        #expect(await stopped.next() == 2)
        #expect(try await request(client) == .string("replacement"))
        #expect(created == 2)
        await client.stop()
    }

    @Test func stopDuringSubscriptionPreparationCannotInstallAnOldEventTask() async throws {
        let subscribeGate = IssueClientGate()
        let old = ControlledIssueRPC(name: "old", subscribeGate: subscribeGate)
        let replacement = ControlledIssueRPC(name: "replacement")
        var created = 0
        let client = PathwayIssueEnvironmentClient { _, _ in
            created += 1
            return created == 1 ? old : replacement
        }
        let original = Task { try await request(client) }
        await subscribeGate.waitUntilEntered()
        await client.stop()
        #expect(try await request(client) == .string("replacement"))
        await subscribeGate.release()
        do { _ = try await original.value; Issue.record("The replaced request must be cancelled") }
        catch { #expect(error is CancellationError) }
        #expect(try await request(client) == .string("replacement"))
        #expect(created == 2)
        await client.stop()
    }

    @Test func stoppedClientCannotReturnItsLateRequestToTheReplacementSession() async throws {
        let requestGate = IssueClientGate()
        let old = ControlledIssueRPC(name: "old", requestGate: requestGate)
        let replacement = ControlledIssueRPC(name: "replacement")
        var created = 0
        let client = PathwayIssueEnvironmentClient { _, _ in
            created += 1
            return created == 1 ? old : replacement
        }
        let original = Task { try await request(client) }
        await requestGate.waitUntilEntered()
        await client.stop()
        #expect(try await request(client) == .string("replacement"))
        await requestGate.release()
        do { _ = try await original.value; Issue.record("A stopped client's result must be discarded") }
        catch { #expect(error is CancellationError) }
        await client.stop()
    }

    @Test func completedStreamReleasesOnlyItsOwnConnection() async throws {
        let first = ControlledIssueRPC(name: "first")
        let second = ControlledIssueRPC(name: "second")
        var created = 0
        let client = PathwayIssueEnvironmentClient { _, _ in
            created += 1
            return created == 1 ? first : second
        }
        _ = try await request(client)
        await first.finish()
        var stopped = first.stopEvents.makeAsyncIterator()
        #expect(await stopped.next() == 1)
        #expect(try await request(client) == .string("second"))
        #expect(created == 2)
        await client.stop()
    }

    private func request(_ client: PathwayIssueEnvironmentClient) async throws -> JSONValue {
        let environment = PathwayCompanyEnvironment(companyId: "company", environment: .init(id: "registration", environmentId: "server",
            descriptor: .init(environmentId: "server", label: "Server", serverVersion: "test"), relayLinkState: "linked",
            managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        return try await client.request(environment: environment, connect: connect, method: "issues.getSettings", payload: .object([:]))
    }
}

private actor IssueClientGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var entered: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiters.append($0); entered?.resume(); entered = nil }
    }
    func waitUntilEntered() async {
        if !waiters.isEmpty { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() {
        released = true
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}

private actor ControlledIssueRPC: PathwayIssueRPCClient {
    let name: String
    let subscribeGate: IssueClientGate?
    let stopGate: IssueClientGate?
    let requestGate: IssueClientGate?
    let stopEvents: AsyncStream<Int>
    private let stopped: AsyncStream<Int>.Continuation
    private let events: AsyncThrowingStream<JSONValue, Error>
    private let continuation: AsyncThrowingStream<JSONValue, Error>.Continuation
    private var stopCount = 0
    init(name: String, subscribeGate: IssueClientGate? = nil, stopGate: IssueClientGate? = nil, requestGate: IssueClientGate? = nil) {
        self.name = name; self.subscribeGate = subscribeGate; self.stopGate = stopGate; self.requestGate = requestGate
        (events, continuation) = AsyncThrowingStream.makeStream()
        (stopEvents, stopped) = AsyncStream.makeStream()
    }
    func subscribe(_ tag: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error> {
        await subscribeGate?.wait()
        return events
    }
    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool, waitForSubscription: Bool, timeout: Duration) async throws -> JSONValue {
        #expect(requiresSubscription && waitForSubscription)
        await requestGate?.wait()
        return .string(name)
    }
    func finish() { continuation.finish() }
    func stop() async {
        stopCount += 1
        stopped.yield(stopCount)
        await stopGate?.wait()
        continuation.finish(throwing: URLError(.networkConnectionLost))
    }
}
