import Combine
import Foundation
import Observation
@testable import Pathway
import Testing

@MainActor struct PathwayCloudLifecycleTests {
    @Test func refreshReconnectsActiveEnvironmentsAndReportsOnlyFailedOnes() async throws {
        let client = ControlledCloudClient()
        var requested: [String] = []
        let environmentClient = PathwayIssueEnvironmentClient { environment, _ in
            requested.append(environment.environment.environmentId)
            return RefreshEnvironmentRPC(offline: environment.environment.environmentId == "offline")
        }
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        let model = PathwayCloudModel(client: client, connect: connect, issueEnvironmentClient: environmentClient)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        let entities = ["online", "offline", "disabled"].map { id in
            PathwaySyncChange(version: 10, entityKind: "environmentRegistration", entityId: id, changeKind: "upsert", payload: .object([
                "id": .string(id), "environmentId": .string(id),
                "descriptor": .object(["environmentId": .string(id), "label": .string(id), "serverVersion": .string("test")]),
                "relayLinkState": .string("linked"), "managedEndpointAvailable": .bool(true),
                "state": .string(id == "disabled" ? "revoked" : "active"), "lastSeenAt": .null
            ]))
        }
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: entities))
        await observed { model.connectionState == .connected }
        #expect(model.environments.count == 3)
        client.refreshCompanies = [company()]
        client.refreshHead = .init(version: 10, authorizationEpoch: 1)
        #expect(try await model.refreshThreads() == .unavailable(["offline"]))
        #expect(requested.sorted() == ["offline", "online"])
        requested = []
        #expect(try await model.refreshThreads() == .unavailable(["offline"]))
        #expect(requested.sorted() == ["offline", "online"])
        await model.stop()
    }

    @Test func refreshWaitsForFreshHeadChangesToBeInstalled() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: [change("old")]))
        await observed { model.entities(kind: "test", companyID: "company") == [.string("old")] }
        client.refreshCompanies = [company()]
        client.refreshHead = .init(version: 11, authorizationEpoch: 1)
        var finished = false
        let refresh = Task {
            let result = try await model.refreshThreads()
            finished = true
            return result
        }
        var changes = client.changeEvents.makeAsyncIterator()
        let request = try #require(await changes.next())
        #expect(!finished)
        #expect(request.cursor == 10)
        request.resume(.init(tag: "Changes", changes: [change("old", tombstone: true), change("new")], cursor: 11, hasMore: false, latestVersion: 11, authorizationEpoch: 1))
        #expect(try await refresh.value == .updated)
        #expect(model.entities(kind: "test", companyID: "company") == [.string("new")])
        #expect(client.calls.prefix(2) == ["disconnect", "authenticate"])
        await model.stop()
    }

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

    @Test func optimisticLifecyclePartitionsSurviveDiscoveryAndRollbackToLatestState() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        var drains = client.changeEvents.makeAsyncIterator()
        var shell = makeAgentThread(pinnedAt: "2026-01-01T00:00:00Z").shell
        func threadChange(version: Int) throws -> PathwaySyncChange {
            let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(shell))
            return .init(version: version, entityKind: "agentThread", entityId: shell.id, changeKind: "upsert",
                payload: .object(["environmentId": .string("environment-1"), "shell": encoded, "updatedAt": .number(Double(version))]))
        }
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: [try threadChange(version: 10)]))
        await observed { model.activeThreads.count == 1 }
        let thread = try #require(model.threads.first)
        let mutation = model.beginThreadAction(.settle, thread: thread)
        #expect(model.activeThreads.isEmpty)
        #expect(model.settledThreads.map(\.id) == [thread.id])
        shell.title = "Remote rename"
        model.received(head: .init(version: 11, authorizationEpoch: 1), companyId: "company")
        try #require(await drains.next()).resume(.init(tag: "Changes", changes: [try threadChange(version: 11)],
            cursor: 11, hasMore: false, latestVersion: 11, authorizationEpoch: 1))
        await observed { model.threads.first?.shell.title == "Remote rename" }
        #expect(model.activeThreads.isEmpty)
        model.rollbackThreadAction(mutation)
        #expect(model.activeThreads.first?.shell.title == "Remote rename")
        #expect(model.settledThreads.isEmpty)
        let deletion = model.beginThreadAction(.delete, thread: thread)
        #expect(model.threads.isEmpty)
        #expect(model.threadForNavigation(id: thread.id) != nil)
        model.rollbackThreadAction(deletion)
        #expect(model.activeThreads.count == 1)
        await model.stop()
    }

    @Test func emailDeltasAndTombstonesPreserveUnchangedFeatureProjections() async throws {
        let client = ControlledCloudClient()
        let model = PathwayCloudModel(client: client)
        await model.received(companies: [company()])
        var bootstrap = client.bootstrapEvents.makeAsyncIterator()
        var drains = client.changeEvents.makeAsyncIterator()
        let issue = PathwaySyncChange(version: 10, entityKind: "issue", entityId: "task", changeKind: "upsert",
            payload: .object(["id": .string("task"), "title": .string("Unchanged task")]))
        let email = PathwaySyncChange(version: 10, entityKind: "capturedEmail", entityId: "mail", changeKind: "upsert",
            payload: .object(["id": .string("mail"), "message": .object(["id": .string("mail"), "isRead": .bool(false)])]))
        try #require(await bootstrap.next()).resume(page(epoch: 1, entities: [issue, email]))
        await observed { model.email.messages.count == 1 }
        #expect(model.issues.records.first?.title == "Unchanged task")
        model.received(head: .init(version: 12, authorizationEpoch: 1), companyId: "company")
        try #require(await drains.next()).resume(.init(tag: "Changes", changes: [
            .init(version: 11, entityKind: "capturedEmail", entityId: "mail", changeKind: "upsert",
                  payload: .object(["id": .string("mail"), "message": .object(["id": .string("mail"), "isRead": .bool(true)])]))
        ], cursor: 11, hasMore: true, latestVersion: 12, authorizationEpoch: 1))
        // Publication must progress even while the next network page is suspended.
        let lastPage = try #require(await drains.next())
        await observed { model.email.messages.first?.isRead == true }
        #expect(model.issues.records.first?.title == "Unchanged task")
        lastPage.resume(.init(tag: "Changes", changes: [
            .init(version: 12, entityKind: "capturedEmail", entityId: "mail", changeKind: "tombstone", payload: nil)
        ], cursor: 12, hasMore: false, latestVersion: 12, authorizationEpoch: 1))
        await observed { model.email.messages.isEmpty }
        #expect(model.issues.records.first?.title == "Unchanged task")
        model.received(head: .init(version: 12, authorizationEpoch: 2), companyId: "company")
        #expect(model.issues.records.isEmpty)
        let revokedBootstrap = try #require(await bootstrap.next())
        revokedBootstrap.resume(page(epoch: 2, version: 12, entities: []))
        await observed { model.connectionState == .connected }
        await model.stop()
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

private actor RefreshEnvironmentRPC: PathwayIssueRPCClient {
    let offline: Bool
    private var continuation: AsyncThrowingStream<JSONValue, Error>.Continuation?
    init(offline: Bool) { self.offline = offline }
    func subscribe(_ tag: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error> {
        #expect(tag == "issues.stream")
        return AsyncThrowingStream { continuation = $0 }
    }
    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool, waitForSubscription: Bool, timeout: Duration) async throws -> JSONValue {
        #expect(tag == "server.getConfig")
        #expect(requiresSubscription && waitForSubscription)
        #expect(timeout == .seconds(5))
        if offline { throw PathwayRPCError.timedOut }
        return .object([:])
    }
    func stop() async { continuation?.finish(); continuation = nil }
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
    var refreshCompanies: [PathwayCompany]?
    var refreshHead: PathwaySyncHead?
    init() {
        (bootstrapEvents, bootstrapContinuation) = AsyncStream.makeStream()
        (changeEvents, changeContinuation) = AsyncStream.makeStream()
    }
    func authenticate() async throws { authenticationCount += 1; calls.append("authenticate") }
    func disconnect() async { calls.append("disconnect"); await disconnectGate?.wait() }
    func companiesPublisher() -> AnyPublisher<[PathwayCompany], Error> {
        if let refreshCompanies { return Just(refreshCompanies).setFailureType(to: Error.self).eraseToAnyPublisher() }
        return Empty(completeImmediately: false).eraseToAnyPublisher()
    }
    func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, Error> {
        if let refreshHead { return Just(refreshHead).setFailureType(to: Error.self).eraseToAnyPublisher() }
        return Empty(completeImmediately: false).eraseToAnyPublisher()
    }
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
