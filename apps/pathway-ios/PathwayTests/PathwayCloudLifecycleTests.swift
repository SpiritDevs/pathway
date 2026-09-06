import Combine
import Foundation
import Observation
@testable import Pathway
import Testing

@MainActor struct PathwayCloudLifecycleTests {
    @Test func mixedAuthorizationPagesRestartWithoutPublishingPartialData() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var requests = client.bootstrapEvents.makeAsyncIterator()
        let first = try #require(await requests.next())
        #expect(first.cursor == nil)
        first.resume(page(epoch: 1, entities: [change("old-first")], cursor: "next", done: false))
        let second = try #require(await requests.next())
        second.resume(page(epoch: 2, entities: [change("old-second")]))
        let restarted = try #require(await requests.next())
        #expect(restarted.cursor == nil)
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
        restarted.resume(page(epoch: 2, entities: [change("authorized")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        #expect(model.entities(kind: "test", companyID: "company") == [.string("authorized")])
        await model.stop()
    }

    @Test func secondEpochAtSameVersionCannotBeLostDuringRebootstrap() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var requests = client.bootstrapEvents.makeAsyncIterator()
        try #require(await requests.next()).resume(page(epoch: 1, entities: [change("private")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        model.received(head: .init(version: 10, authorizationEpoch: 2), companyId: "company")
        let second = try #require(await requests.next())
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
        model.received(head: .init(version: 10, authorizationEpoch: 3), companyId: "company")
        second.resume(page(epoch: 2, entities: [change("revoked-again")]))
        let third = try #require(await requests.next())
        #expect(third.cursor == nil)
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
        third.resume(page(epoch: 3, entities: [change("allowed")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        #expect(model.entities(kind: "test", companyID: "company") == [.string("allowed")])
        await model.stop()
    }

    @Test func revokedMembershipCannotInstallALateBootstrapEvenWhenCompanyReturns() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var requests = client.bootstrapEvents.makeAsyncIterator()
        let old = try #require(await requests.next())
        await model.received(companies: [company(membership: "replacement")])
        let replacement = try #require(await requests.next())
        replacement.resume(page(epoch: 2, entities: [change("new-member")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        old.resume(page(epoch: 1, entities: [change("old-member")]))
        await model.stop(clearContent: false)
        #expect(model.entities(kind: "test", companyID: "company") == [.string("new-member")])
    }

    @Test func epochRevocationCancelsDrainAndRejectsItsLatePage() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        var drains = client.changeEvents.makeAsyncIterator()
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: [change("private")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        model.received(head: .init(version: 11, authorizationEpoch: 1), companyId: "company")
        let staleDrain = try #require(await drains.next())
        model.received(head: .init(version: 11, authorizationEpoch: 2), companyId: "company")
        let replacement = try #require(await bootstrap.next())
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
        staleDrain.resume(.init(tag: "Changes", changes: [change("leaked")], cursor: 11, hasMore: false, latestVersion: 11, authorizationEpoch: 1))
        replacement.resume(page(epoch: 2, version: 11, entities: [change("allowed")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        #expect(model.entities(kind: "test", companyID: "company") == [.string("allowed")])
        await model.stop()
    }

    @Test func expiredCursorClearsReplicaBeforeStartingFreshBootstrap() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        var drains = client.changeEvents.makeAsyncIterator()
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: [change("stale")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        model.received(head: .init(version: 20, authorizationEpoch: 1), companyId: "company")
        try #require(await drains.next()).resume(.init(tag: "CursorExpired", changes: nil, cursor: nil, hasMore: nil, latestVersion: 20, authorizationEpoch: 1))
        let fresh = try #require(await bootstrap.next())
        #expect(fresh.cursor == nil)
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
        fresh.resume(page(epoch: 1, version: 20, entities: [change("fresh")]))
        await observed { model.entities(kind: "test", companyID: "company").count == 1 }
        await model.stop()
    }

    @Test func newerOrdinaryHeadDrainsCapturedSnapshotWithoutRestartingBootstrap() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        var drains = client.changeEvents.makeAsyncIterator()
        let initial = try #require(await bootstrap.next())
        model.received(head: .init(version: 11, authorizationEpoch: 1), companyId: "company")
        initial.resume(page(epoch: 1, entities: [change("initial")]))
        let drain = try #require(await drains.next())
        #expect(drain.cursor == 10)
        drain.resume(.init(tag: "Changes", changes: [change("initial", tombstone: true), change("latest")], cursor: 11, hasMore: false, latestVersion: 11, authorizationEpoch: 1))
        await observed { model.entities(kind: "test", companyID: "company") == [.string("latest")] }
        #expect(client.bootstrapCount == 1)
        await model.stop()
    }

    @Test func oldShutdownFinishesBeforeNewAuthenticationAndCannotClearNewAccount() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        let gate = CloudVoidGate()
        client.disconnectGate = gate
        let stopping = Task { await model.stop() }
        await gate.waitUntilEntered()
        let starting = Task { await model.start() }
        await observed { model.connectionState == .connecting }
        #expect(client.authenticationCount == 0)
        gate.release()
        await stopping.value
        await starting.value
        #expect(client.calls == ["disconnect", "authenticate"])
        #expect(model.connectionState == .syncing)
        client.disconnectGate = nil
        await model.stop()
    }

    @Test func supersededStorageConfigurationCannotRestoreOldAccountCache() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let oldDirectory = root.appending(path: "old")
        let newDirectory = root.appending(path: "new")
        await PathwayDiscoveryCache(directory: oldDirectory).save(.init(companies: [company(name: "Old private workspace")], entities: ["company": [change("old")]], versions: ["company": 10], savedAt: Date()), revision: 1)
        await PathwayDiscoveryCache(directory: newDirectory).save(.init(companies: [company(name: "New workspace")], entities: ["company": [change("new")]], versions: ["company": 10], savedAt: Date()), revision: 1)
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        let gate = CloudVoidGate()
        client.disconnectGate = gate
        let old = Task { await model.configureLocalStorage(directory: oldDirectory) }
        await gate.waitUntilEntered()
        let new = Task { await model.configureLocalStorage(directory: newDirectory) }
        await observed { model.replicaRevision >= 2 }
        gate.release()
        await old.value
        await new.value
        #expect(model.companies.first?.name == "New workspace")
        #expect(model.entities(kind: "test", companyID: "company") == [.string("new")])
        client.disconnectGate = nil
        await model.stop()
    }

    @Test func signOutSupersedesAStorageLoadAlreadyWaitingForShutdown() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        await PathwayDiscoveryCache(directory: directory).save(.init(companies: [company()], entities: ["company": [change("private")]], versions: ["company": 10], savedAt: Date()), revision: 1)
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        let gate = CloudVoidGate()
        client.disconnectGate = gate
        let configuring = Task { await model.configureLocalStorage(directory: directory) }
        await gate.waitUntilEntered()
        let signedOut = Task { await model.stop() }
        await observed { model.replicaRevision >= 2 }
        gate.release()
        await configuring.value
        await signedOut.value
        #expect(model.companies.isEmpty)
        #expect(model.entities(kind: "test", companyID: "company").isEmpty)
    }

    private func company(membership: String = "member", name: String = "Workspace") -> PathwayCompany {
        .init(id: "company", membershipId: membership, name: name, workspaceKind: "personal", issueKeyPrefix: "P", lifecycleState: "active", syncVersion: 10, isOwner: true)
    }
    private func change(_ id: String, tombstone: Bool = false) -> PathwaySyncChange {
        .init(version: 10, entityKind: "test", entityId: id, changeKind: tombstone ? "tombstone" : "upsert", payload: .string(id))
    }
    private func page(epoch: Int, version: Int = 10, entities: [PathwaySyncChange], cursor: String? = nil, done: Bool = true) -> PathwaySyncBootstrapPage {
        .init(version: version, authorizationEpoch: epoch, entities: entities, cursor: cursor, isDone: done)
    }
    private func observed(_ predicate: @escaping @MainActor () -> Bool) async {
        if predicate() { return }
        await withCheckedContinuation { continuation in
            let observation = CloudObservationWaiter(predicate: predicate, continuation: continuation)
            observation.observe()
        }
    }
}

@MainActor private final class CloudObservationWaiter {
    let predicate: @MainActor () -> Bool
    var continuation: CheckedContinuation<Void, Never>?
    init(predicate: @escaping @MainActor () -> Bool, continuation: CheckedContinuation<Void, Never>) {
        self.predicate = predicate; self.continuation = continuation
    }
    func observe() {
        withObservationTracking {
            if predicate() { continuation?.resume(); continuation = nil }
        } onChange: { Task { @MainActor in self.observe() } }
    }
}

private struct CloudPageRequest<Value: Sendable, Cursor: Sendable>: Sendable {
    let cursor: Cursor
    let continuation: CheckedContinuation<Value, Error>
    func resume(_ value: Value) { continuation.resume(returning: value) }
}

@MainActor private final class CloudVoidGate {
    private var waiting: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiting = $0; entered?.resume(); entered = nil }
    }
    func waitUntilEntered() async {
        if waiting != nil { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() { released = true; waiting?.resume(); waiting = nil }
}

@MainActor private final class ControlledCloudClient: PathwayCloudSyncClient {
    let bootstrapEvents: AsyncStream<CloudPageRequest<PathwaySyncBootstrapPage, String?>>
    private let bootstrapContinuation: AsyncStream<CloudPageRequest<PathwaySyncBootstrapPage, String?>>.Continuation
    let changeEvents: AsyncStream<CloudPageRequest<PathwaySyncChangesPage, Int>>
    private let changeContinuation: AsyncStream<CloudPageRequest<PathwaySyncChangesPage, Int>>.Continuation
    var bootstrapCount = 0
    var authenticationCount = 0
    var calls: [String] = []
    var disconnectGate: CloudVoidGate?
    init() {
        (bootstrapEvents, bootstrapContinuation) = AsyncStream.makeStream()
        (changeEvents, changeContinuation) = AsyncStream.makeStream()
    }
    func authenticate() async throws { authenticationCount += 1; calls.append("authenticate") }
    func disconnect() async { calls.append("disconnect"); await disconnectGate?.wait() }
    func companiesPublisher() -> AnyPublisher<[PathwayCompany], Error> { Empty(completeImmediately: false).eraseToAnyPublisher() }
    func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, Error> { Empty(completeImmediately: false).eraseToAnyPublisher() }
    func publisher(name: String, arguments: JSONValue) -> AnyPublisher<JSONValue, Error> { Empty(completeImmediately: false).eraseToAnyPublisher() }
    func provisionCurrentUser() async throws -> PathwayCompany { throw CancellationError() }
    func bootstrapCompany(companyId: String, cursor: String?) async throws -> PathwaySyncBootstrapPage {
        bootstrapCount += 1
        return try await withCheckedThrowingContinuation { bootstrapContinuation.yield(.init(cursor: cursor, continuation: $0)) }
    }
    func listChanges(companyId: String, cursor: Int) async throws -> PathwaySyncChangesPage {
        try await withCheckedThrowingContinuation { changeContinuation.yield(.init(cursor: cursor, continuation: $0)) }
    }
    func applyIssueOperations(companyID: String, operations: JSONValue) async throws -> JSONValue { .null }
    func issueRequest(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue { .null }
}
