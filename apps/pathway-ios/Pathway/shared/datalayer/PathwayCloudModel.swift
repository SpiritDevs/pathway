import Combine
import Foundation
import Observation
import OSLog

// Convex discovery owns one coordinated subscription state machine.
// swiftlint:disable file_length

private let pathwayCloudLogger = Logger(
    subsystem: "com.spiritdevs.pathway",
    category: "PathwayCloud"
)

@MainActor
protocol PathwayCloudSyncClient: AnyObject {
    func authenticate() async throws
    func disconnect() async
    func companiesPublisher() -> AnyPublisher<[PathwayCompany], Error>
    func provisionCurrentUser() async throws -> PathwayCompany
    func bootstrapCompany(companyId: String, cursor: String?) async throws -> PathwaySyncBootstrapPage
    func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, Error>
    func listChanges(companyId: String, cursor: Int) async throws -> PathwaySyncChangesPage
    func applyIssueOperations(companyID: String, operations: JSONValue) async throws -> JSONValue
    func issueRequest(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue
    func publisher(name: String, arguments: JSONValue) -> AnyPublisher<JSONValue, Error>
}

extension PathwayConvexClient: PathwayCloudSyncClient {}

@MainActor
@Observable
final class PathwayCloudModel {
    private(set) var connectionState: PathwayCloudConnectionState = .disconnected
    private(set) var companies: [PathwayCompany] = []
    private(set) var environments: [PathwayCompanyEnvironment] = []
    private(set) var projects: [PathwayCompanyProject] = []
    private(set) var environmentBindings: [PathwayCompanyEnvironmentBinding] = []
    private(set) var threads: [PathwayAgentThread] = []
    private(set) var activeThreads: [PathwayAgentThread] = []
    private(set) var snoozedThreads: [PathwayAgentThread] = []
    private(set) var settledThreads: [PathwayAgentThread] = []
    private(set) var replicaRevision = 0
    private(set) var cachedAt: Date?
    private(set) var connectedEnvironmentIDs: Set<String> = []

    @ObservationIgnored lazy var issues = PathwayIssuesModel(
        sendOperations: { [weak self] companyID, operations in
            guard let client = self?.client else { throw URLError(.notConnectedToInternet) }
            return try await client.applyIssueOperations(companyID: companyID, operations: operations)
        },
        environmentRequest: { [weak self] companyID, projectID, method, payload in
            guard let self else { throw CancellationError() }
            return try await requestIssueEnvironment(
                companyID: companyID, projectID: projectID, method: method, payload: payload
            )
        },
        cloudRequest: { [weak self] kind, name, arguments in
            guard let client = self?.client else { throw URLError(.notConnectedToInternet) }
            return try await client.issueRequest(kind: kind, name: name, arguments: arguments)
        }
    )

    @ObservationIgnored lazy var calendar = PathwayCalendarModel(cloudRequest: { [weak self] kind, name, arguments in
        guard let self else { throw CancellationError() }
        return try await request(kind: kind, name: name, arguments: arguments)
    }, mutateWorkItem: { [weak self] companyID, kind, entityID, arguments in
        guard let self else { throw CancellationError() }
        return try await issues.mutate(companyID: companyID, kind: kind, entityID: entityID, args: arguments)
    })
    @ObservationIgnored lazy var email = PathwayEmailModel(
        cloudRequest: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try await request(kind: kind, name: name, arguments: arguments)
        },
        environmentRequest: { [weak self] companyID, environmentID, method, payload in
            guard let self, let environment = environments.first(where: {
                $0.companyId == companyID && $0.environment.environmentId == environmentID
            }) else { throw URLError(.notConnectedToInternet) }
            return try await environmentRequest(environment: environment, method: method, payload: payload)
        }
    )

    @ObservationIgnored private let client: (any PathwayCloudSyncClient)?
    @ObservationIgnored lazy var connectedMail = makeConnectedMailModel()

    private func makeConnectedMailModel() -> PathwayConnectedMailModel {
        PathwayConnectedMailModel(
        request: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try await request(kind: kind, name: name, arguments: arguments)
        }, subscribe: { [weak self] name, arguments in
            self?.subscribe(name: name, arguments: arguments) ?? AsyncThrowingStream { $0.finish(throwing: CancellationError()) }
        }, relayRequest: { [weak self] path, payload in
            guard let connect = self?.connect else { throw URLError(.notConnectedToInternet) }
            return try await connect.relayAccountRequest(method: "POST", path: "/v1/mail/\(path)", payload: payload)
        }, environmentRequest: { [weak self] environment in
            guard let self else { throw CancellationError() }
            return try await environmentRequest(environment: environment, method: "server.getConfig", payload: .object([:]))
        }
    )
    }

    @ObservationIgnored lazy var contacts = PathwayContactsModel(
        request: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try await request(kind: kind, name: name, arguments: arguments)
        }, subscribe: { [weak self] name, arguments in
            self?.subscribe(name: name, arguments: arguments) ?? AsyncThrowingStream { $0.finish(throwing: CancellationError()) }
        }
    )
    @ObservationIgnored lazy var time = PathwayTimeModel(
        request: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try await request(kind: kind, name: name, arguments: arguments)
        }, subscribe: { [weak self] name, arguments in
            self?.subscribe(name: name, arguments: arguments) ?? AsyncThrowingStream { $0.finish(throwing: CancellationError()) }
        }
    )
    @ObservationIgnored private let connect: PathwayConnectClient?
    @ObservationIgnored private let issueEnvironmentClient = PathwayIssueEnvironmentClient()
    @ObservationIgnored private var companiesSubscription: AnyCancellable?
    @ObservationIgnored private var headSubscriptions: [String: AnyCancellable] = [:]
    @ObservationIgnored private var bootstrapTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var bootstrapTaskIDs: [String: UUID] = [:]
    @ObservationIgnored private var drainTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var drainTaskIDs: [String: UUID] = [:]
    @ObservationIgnored private var entitiesByCompany: [String: [PathwaySyncEntityKey: PathwaySyncChange]] = [:]
    @ObservationIgnored private var decodedDiscovery: [String: [PathwaySyncEntityKey: PathwayDecodedDiscovery]] = [:]
    @ObservationIgnored private var discoveryThreads: [PathwayAgentThread] = []
    @ObservationIgnored private var cursorByCompany: [String: Int] = [:]
    @ObservationIgnored private var latestVersionByCompany: [String: Int] = [:]
    @ObservationIgnored private var authorizationEpochByCompany: [String: Int] = [:]
    @ObservationIgnored private var latestHeadByCompany: [String: PathwaySyncHead] = [:]
    @ObservationIgnored private var lifecycleGeneration = 0
    @ObservationIgnored private var lifecycleTask: Task<Void, Never>?
    @ObservationIgnored private var lifecycleTaskID: UUID?
    @ObservationIgnored private var storageConfigurationID = UUID()
    @ObservationIgnored private var lifecycleMetadataID: UUID?
    @ObservationIgnored private var changeRequestStates: [String: PathwayChangeRequestState] = [:]
    @ObservationIgnored private var isRefreshingLifecycleMetadata = false
    @ObservationIgnored private var isProvisioning = false
    @ObservationIgnored private var storageDirectory: URL?
    @ObservationIgnored private var discoveryCache: PathwayDiscoveryCache?
    @ObservationIgnored private var cacheTask: Task<Void, Never>?

    init(client: (any PathwayCloudSyncClient)? = nil, connect: PathwayConnectClient? = nil) {
        self.client = client
        self.connect = connect
    }

    var isConnected: Bool {
        connectionState == .connected
    }

    func configureLocalStorage(directory: URL?) async {
        guard storageDirectory != directory else { return }
        let configurationID = UUID()
        storageConfigurationID = configurationID
        storageDirectory = directory
        discoveryCache = directory.map { PathwayDiscoveryCache(directory: $0) }
        // Clear private content before the first suspension; transport shutdown is serialized
        // with authentication so an older logout cannot tear down a newer account's login.
        let generation = lifecycleGeneration + 1
        await stop()
        guard storageConfigurationID == configurationID, storageDirectory == directory,
              lifecycleGeneration == generation, !Task.isCancelled else { return }
        guard let cache = discoveryCache, entitiesByCompany.isEmpty else { return }
        let snapshot = await cache.load()
        guard storageConfigurationID == configurationID, storageDirectory == directory,
              lifecycleGeneration == generation, entitiesByCompany.isEmpty,
              !Task.isCancelled, let snapshot else { return }
        companies = snapshot.companies
        entitiesByCompany = snapshot.entities.mapValues { changes in
            Dictionary(uniqueKeysWithValues: changes.map {
                (PathwaySyncEntityKey(kind: $0.entityKind, id: $0.entityId), $0)
            })
        }
        cachedAt = snapshot.savedAt
        cursorByCompany = [:]
        rebuildDiscoveryModels(persist: false)
    }

    func entities(kind: String, companyID: String) -> [JSONValue] {
        _ = replicaRevision
        return (entitiesByCompany[companyID] ?? [:]).values.compactMap { change in
            guard change.entityKind == kind, change.changeKind != "tombstone" else { return nil }
            return change.payload
        }
    }

    func browserPasswordRequest(_ operation: String, arguments: JSONValue) async throws -> JSONValue {
        let kind: String
        switch operation {
        case "list": kind = "query"
        case "save", "getForAutofill": kind = "action"
        case "remove": kind = "mutation"
        default: throw URLError(.unsupportedURL)
        }
        return try await request(kind: kind, name: "browserPasswords:\(operation)", arguments: arguments)
    }

    func request(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue {
        guard let client else { throw URLError(.notConnectedToInternet) }
        return try await client.issueRequest(kind: kind, name: name, arguments: arguments)
    }

    func subscribe(name: String, arguments: JSONValue = .object([:])) -> AsyncThrowingStream<JSONValue, Error> {
        guard let client else { return AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) } }
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                do {
                    for try await value in client.publisher(name: name, arguments: arguments).values {
                        try Task.checkCancellation()
                        continuation.yield(value)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func applyOperations(companyID: String, operations: JSONValue) async throws -> JSONValue {
        guard let client else { throw URLError(.notConnectedToInternet) }
        return try await client.applyIssueOperations(companyID: companyID, operations: operations)
    }

    func environmentRequest(environment: PathwayCompanyEnvironment, method: String, payload: JSONValue) async throws -> JSONValue {
        guard let connect, environments.contains(where: { $0.id == environment.id }) else {
            throw URLError(.notConnectedToInternet)
        }
        observeEnvironmentEvents()
        return try await issueEnvironmentClient.request(environment: environment, connect: connect, method: method, payload: payload)
    }

    /// Placement probes own their protocol subscription and close it after the two reads.
    func environmentPlacementSnapshot(environment: PathwayCompanyEnvironment) async throws -> PathwayEnvironmentPlacementSnapshot {
        guard let connect, environments.contains(where: { $0.id == environment.id }) else {
            throw URLError(.notConnectedToInternet)
        }
        return try await PathwayIssueEnvironmentClient.placementSnapshot(environment: environment, connect: connect)
    }

    func environmentSubscription(environment: PathwayCompanyEnvironment, method: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error> {
        guard let connect, environments.contains(where: { $0.id == environment.id }) else {
            return AsyncThrowingStream { $0.finish(throwing: URLError(.notConnectedToInternet)) }
        }
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await value in await rpc.subscribe(method, payload: payload) {
                        try Task.checkCancellation()
                        continuation.yield(value)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
                await rpc.stop()
            }
            continuation.onTermination = { _ in
                task.cancel()
                Task { await rpc.stop() }
            }
        }
    }

    #if DEBUG
    func installIssueSimulatorSnapshot(company: PathwayCompany, changes: [PathwaySyncChange], version: Int) {
        guard client == nil else { return }
        companies = [company]
        entitiesByCompany = [company.id: Dictionary(uniqueKeysWithValues: changes.map {
            (PathwaySyncEntityKey(kind: $0.entityKind, id: $0.entityId), $0)
        })]
        cursorByCompany = [company.id: version]
        rebuildDiscoveryModels()
        connectionState = .connected
    }
    #endif

    var errorMessage: String? {
        guard case let .failed(message) = connectionState else { return nil }
        return message
    }

    func start() async {
        guard let client else { return }
        guard connectionState != .connecting, connectionState != .syncing, connectionState != .connected else { return }
        cancelWork()
        let generation = lifecycleGeneration
        connectionState = .connecting
        let previous = lifecycleTask
        let taskID = UUID()
        lifecycleTaskID = taskID
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, lifecycleGeneration == generation, !Task.isCancelled else { return }
            do {
                try await client.authenticate()
                guard lifecycleGeneration == generation, !Task.isCancelled else { return }
                connectionState = .syncing
                subscribeToCompanies(using: client)
            } catch {
                guard lifecycleGeneration == generation, !Task.isCancelled else { return }
                fail(error)
            }
        }
        lifecycleTask = task
        await task.value
        if lifecycleTaskID == taskID { lifecycleTask = nil; lifecycleTaskID = nil }
    }

    func retry() async {
        let generationAfterStop = lifecycleGeneration + 1
        await stop(clearContent: false)
        guard lifecycleGeneration == generationAfterStop, connectionState == .disconnected, !Task.isCancelled else { return }
        await start()
    }

    func stop(clearContent: Bool = true) async {
        cancelWork()
        connectedEnvironmentIDs = []
        connectionState = .disconnected
        if clearContent { clearDiscoveryContent() }
        let previous = lifecycleTask
        let taskID = UUID()
        lifecycleTaskID = taskID
        let environmentClient = issueEnvironmentClient
        let client = client
        let task = Task { @MainActor in
            await previous?.value
            await environmentClient.stop()
            await client?.disconnect()
        }
        lifecycleTask = task
        await task.value
        if lifecycleTaskID == taskID { lifecycleTask = nil; lifecycleTaskID = nil }
    }

    private func clearDiscoveryContent() {
        cachedAt = nil
        companies = []
        environments = []
        projects = []
        environmentBindings = []
        threads = []
        activeThreads = []
        snoozedThreads = []
        settledThreads = []
        entitiesByCompany = [:]
        decodedDiscovery = [:]
        discoveryThreads = []
        cursorByCompany = [:]
        latestVersionByCompany = [:]
        authorizationEpochByCompany = [:]
        latestHeadByCompany = [:]
        changeRequestStates = [:]
        issues.replaceReplica([:])
        calendar.replaceReplica([:])
        email.replaceReplica([:])
        contacts.clear()
        connectedMail.clear()
        time.clear()
        replicaRevision += 1
    }

    func requestIssueEnvironment(
        companyID: String, projectID: String?, method: String, payload: JSONValue
    ) async throws -> JSONValue {
        guard let connect else { throw URLError(.notConnectedToInternet) }
        observeEnvironmentEvents()
        var fields = payload.objectValue ?? [:]
        let requestedEnvironment = fields.removeValue(forKey: "_environmentId")?.stringValue
        let bindings = environmentBindings.filter {
            $0.companyId == companyID && $0.binding.status == "active"
                && (projectID == nil || $0.binding.cloudProjectId == projectID)
        }
        let available = environments.filter { candidate in
            candidate.companyId == companyID && candidate.environment.state == "active"
                && (requestedEnvironment == nil || candidate.environment.environmentId == requestedEnvironment)
                && (projectID == nil || bindings.contains { binding in
                    binding.binding.environmentId == candidate.environment.environmentId
                })
        }
        guard let environment = available.first(where: { $0.environment.relayLinkState == "linked" })
            ?? available.first else {
            throw NSError(domain: "PathwayIssues", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Connect an environment for this project to use this action."
            ])
        }
        return try await issueEnvironmentClient.request(
            environment: environment, connect: connect, method: method, payload: .object(fields)
        )
    }

    func refreshThreadPartition() { rebuildThreadPartition() }

    func companyName(for companyId: String) -> String? {
        companies.first { $0.id == companyId }?.name
    }

    private func observeEnvironmentEvents() {
        let generation = lifecycleGeneration
        issueEnvironmentClient.onEvent = { [weak self] companyID, environmentID, event in
            guard let self, lifecycleGeneration == generation, companies.contains(where: { $0.id == companyID }) else { return }
            let key = "\(companyID):\(environmentID)"
            if event.objectValue?["_pathwayTransport"] != nil {
                connectedEnvironmentIDs.remove(key)
            } else {
                connectedEnvironmentIDs.insert(key)
                issues.receiveEnvironmentEvent(companyID: companyID, environmentID: environmentID, event: event)
            }
        }
    }

    func environmentLabel(companyId: String, environmentId: String) -> String? {
        environments.first {
            $0.companyId == companyId && $0.environment.environmentId == environmentId
        }?.environment.label
    }

    func projectName(companyId: String, projectId: String) -> String? {
        projects.first { $0.companyId == companyId && $0.project.id == projectId }?.project.name
    }

    func refreshLifecycleMetadata(using connect: PathwayConnectClient) async {
        guard !isRefreshingLifecycleMetadata, !activeThreads.isEmpty else { return }
        isRefreshingLifecycleMetadata = true
        let metadataID = UUID()
        lifecycleMetadataID = metadataID
        let generation = lifecycleGeneration
        defer { if lifecycleMetadataID == metadataID { isRefreshingLifecycleMetadata = false; lifecycleMetadataID = nil } }

        let accountDirectory = storageDirectory
        let requestedThreads = Dictionary(uniqueKeysWithValues: activeThreads.map { ($0.id, $0) })
        let resolutions = await PathwayThreadChangeRequestResolver.resolve(
            threads: activeThreads,
            environments: environments,
            bindings: environmentBindings,
            connect: connect
        )
        guard !Task.isCancelled, storageDirectory == accountDirectory, lifecycleGeneration == generation, lifecycleMetadataID == metadataID else { return }
        for resolution in resolutions {
            guard let requested = requestedThreads[resolution.threadID],
                  let current = threads.first(where: { $0.id == resolution.threadID }),
                  current.shell.branch == requested.shell.branch,
                  current.shell.worktreePath == requested.shell.worktreePath else { continue }
            changeRequestStates[resolution.threadID] = resolution.state
        }
        let currentThreadIDs = Set(threads.map(\.id))
        changeRequestStates = changeRequestStates.filter { currentThreadIDs.contains($0.key) }
        rebuildThreadPartition()
    }
}

extension PathwayCloudModel {
    private func subscribeToCompanies(using client: any PathwayCloudSyncClient) {
        let generation = lifecycleGeneration
        companiesSubscription = client.companiesPublisher()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard case let .failure(error) = completion else { return }
                Task { @MainActor [weak self] in
                    guard let self, lifecycleGeneration == generation else { return }
                    fail(error)
                }
            } receiveValue: { [weak self] companies in
                Task { @MainActor [weak self] in
                    guard let self, lifecycleGeneration == generation else { return }
                    await received(companies: companies)
                }
            }
    }

    func received(companies newCompanies: [PathwayCompany]) async {
        guard let client else { return }
        let generation = lifecycleGeneration
        let unchangedMemberships = Set(newCompanies.filter { incoming in
            !companies.contains { $0.id == incoming.id && $0.membershipId != incoming.membershipId }
        }.map(\.id))
        removeCompanies(notIn: unchangedMemberships)
        companies = newCompanies.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        removeCompanies(notIn: Set(newCompanies.map(\.id)))

        if newCompanies.isEmpty {
            guard !isProvisioning else { return }
            isProvisioning = true
            do {
                let company = try await client.provisionCurrentUser()
                guard lifecycleGeneration == generation else { return }
                isProvisioning = false
                guard companies.isEmpty else { return }
                await received(companies: [company])
            } catch {
                guard lifecycleGeneration == generation else { return }
                isProvisioning = false
                fail(error)
            }
            return
        }

        let activeCompanyIds = Set(newCompanies.map(\.id))
        removeCompanies(notIn: activeCompanyIds)
        for company in newCompanies {
            if cursorByCompany[company.id] == nil {
                startBootstrap(companyId: company.id)
            } else {
                // A restart (session refresh, retry) cancels head subscriptions but keeps the
                // replica and its cursor. Resubscribing emits the current head immediately, so
                // the drain catches up on anything missed while unsubscribed.
                subscribeToHead(companyId: company.id)
            }
        }
        updateConnectionStateIfReady()
    }

    private func startBootstrap(companyId: String) {
        guard bootstrapTasks[companyId] == nil,
              let membershipID = companies.first(where: { $0.id == companyId })?.membershipId else { return }
        let taskID = UUID()
        let generation = lifecycleGeneration
        bootstrapTaskIDs[companyId] = taskID
        connectionState = .syncing
        subscribeToHead(companyId: companyId)
        bootstrapTasks[companyId] = Task { @MainActor [weak self] in
            guard let self else { return }
            var completed = false
            defer {
                if bootstrapTaskIDs[companyId] == taskID {
                    bootstrapTasks[companyId] = nil
                    bootstrapTaskIDs[companyId] = nil
                    if completed, !Task.isCancelled, lifecycleGeneration == generation,
                       let head = latestHeadByCompany[companyId] { received(head: head, companyId: companyId) }
                }
            }
            do {
                try await bootstrap(companyId: companyId, membershipID: membershipID, generation: generation, taskID: taskID)
                completed = true
            } catch is CancellationError {
                return
            } catch {
                guard lifecycleGeneration == generation, bootstrapTaskIDs[companyId] == taskID,
                      companies.contains(where: { $0.id == companyId && $0.membershipId == membershipID }) else { return }
                fail(error)
            }
        }
    }

    private func bootstrap(companyId: String, membershipID: String, generation: Int, taskID: UUID) async throws {
        guard let client else { return }
        while true {
            var bootstrapCursor: String?
            var snapshot: [PathwaySyncEntityKey: PathwaySyncChange] = [:]
            var snapshotVersion: Int?
            var snapshotEpoch: Int?
            var restart = false
            repeat {
                try validateWork(companyId: companyId, membershipID: membershipID, generation: generation,
                                 taskID: taskID, bootstrap: true)
                let page = try await client.bootstrapCompany(companyId: companyId, cursor: bootstrapCursor)
                try validateWork(companyId: companyId, membershipID: membershipID, generation: generation,
                                 taskID: taskID, bootstrap: true)
                if let snapshotEpoch, snapshotEpoch != page.authorizationEpoch {
                    restart = true
                    break
                }
                if let head = latestHeadByCompany[companyId], head.authorizationEpoch > page.authorizationEpoch {
                    restart = true
                    break
                }
                if let snapshotVersion, snapshotVersion != page.version {
                    throw PathwayThreadConversationError.message("The workspace returned inconsistent bootstrap versions.")
                }
                snapshotEpoch = page.authorizationEpoch
                snapshotVersion = page.version
                apply(page.entities, to: &snapshot)
                if page.isDone { break }
                guard let next = page.cursor, next != bootstrapCursor else {
                    throw PathwayThreadConversationError.message("The workspace bootstrap did not advance.")
                }
                bootstrapCursor = next
            } while true
            if restart { continue }
            try validateWork(companyId: companyId, membershipID: membershipID, generation: generation,
                             taskID: taskID, bootstrap: true)
            guard let epoch = snapshotEpoch, let version = snapshotVersion else { return }
            if let head = latestHeadByCompany[companyId], head.authorizationEpoch > epoch { continue }
            entitiesByCompany[companyId] = snapshot
            authorizationEpochByCompany[companyId] = epoch
            cursorByCompany[companyId] = version
            rebuildDiscoveryModels()
            updateConnectionStateIfReady()
            return
        }
    }

    private func subscribeToHead(companyId: String) {
        guard let client, headSubscriptions[companyId] == nil,
              let membershipID = companies.first(where: { $0.id == companyId })?.membershipId else { return }
        let generation = lifecycleGeneration
        headSubscriptions[companyId] = client.syncHeadPublisher(companyId: companyId)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard case let .failure(error) = completion else { return }
                Task { @MainActor [weak self] in
                    guard let self, lifecycleGeneration == generation,
                          companies.contains(where: { $0.id == companyId && $0.membershipId == membershipID }) else { return }
                    fail(error)
                }
            } receiveValue: { [weak self] head in
                Task { @MainActor [weak self] in
                    guard let self, lifecycleGeneration == generation,
                          companies.contains(where: { $0.id == companyId && $0.membershipId == membershipID }) else { return }
                    received(head: head, companyId: companyId)
                }
            }
    }

    @discardableResult
    private func record(head: PathwaySyncHead, companyId: String) -> Bool {
        if let previous = latestHeadByCompany[companyId],
           head.authorizationEpoch < previous.authorizationEpoch ||
           (head.authorizationEpoch == previous.authorizationEpoch && head.version < previous.version) { return false }
        if let installed = authorizationEpochByCompany[companyId], head.authorizationEpoch < installed { return false }
        latestHeadByCompany[companyId] = head
        latestVersionByCompany[companyId] = max(latestVersionByCompany[companyId] ?? 0, head.version)
        return true
    }

    func received(head: PathwaySyncHead, companyId: String) {
        guard companies.contains(where: { $0.id == companyId }), record(head: head, companyId: companyId) else { return }
        if let epoch = authorizationEpochByCompany[companyId], epoch != head.authorizationEpoch {
            invalidateReplica(companyId: companyId)
        }
        guard bootstrapTasks[companyId] == nil else { return }
        guard let cursor = cursorByCompany[companyId] else { startBootstrap(companyId: companyId); return }
        guard cursor < head.version, drainTasks[companyId] == nil,
              let membershipID = companies.first(where: { $0.id == companyId })?.membershipId else { return }
        let taskID = UUID()
        let generation = lifecycleGeneration
        drainTaskIDs[companyId] = taskID
        drainTasks[companyId] = Task { @MainActor [weak self] in
            guard let self else { return }
            var completed = false
            defer {
                if drainTaskIDs[companyId] == taskID {
                    drainTasks[companyId] = nil
                    drainTaskIDs[companyId] = nil
                    if completed, lifecycleGeneration == generation, !Task.isCancelled,
                       let head = latestHeadByCompany[companyId] { received(head: head, companyId: companyId) }
                }
            }
            do {
                try await drainChanges(companyId: companyId, membershipID: membershipID, generation: generation, taskID: taskID)
                completed = true
            } catch is CancellationError {
                return
            } catch {
                guard lifecycleGeneration == generation, drainTaskIDs[companyId] == taskID,
                      companies.contains(where: { $0.id == companyId && $0.membershipId == membershipID }) else { return }
                fail(error)
            }
        }
    }

    private func drainChanges(companyId: String, membershipID: String, generation: Int, taskID: UUID) async throws {
        guard let client else { return }
        while let cursor = cursorByCompany[companyId], cursor < (latestVersionByCompany[companyId] ?? cursor) {
            try validateWork(companyId: companyId, membershipID: membershipID, generation: generation, taskID: taskID, bootstrap: false)
            let page = try await client.listChanges(companyId: companyId, cursor: cursor)
            try validateWork(companyId: companyId, membershipID: membershipID, generation: generation, taskID: taskID, bootstrap: false)
            if page.tag == "CursorExpired" || page.authorizationEpoch != authorizationEpochByCompany[companyId] {
                record(head: .init(version: page.latestVersion, authorizationEpoch: page.authorizationEpoch), companyId: companyId)
                invalidateReplica(companyId: companyId)
                startBootstrap(companyId: companyId)
                return
            }
            guard let nextCursor = page.cursor, nextCursor > cursor else {
                throw PathwayThreadConversationError.message("The workspace change feed did not advance.")
            }
            var entities = entitiesByCompany[companyId] ?? [:]
            apply(page.changes ?? [], to: &entities)
            entitiesByCompany[companyId] = entities
            cursorByCompany[companyId] = nextCursor
            latestVersionByCompany[companyId] = max(latestVersionByCompany[companyId] ?? 0, page.latestVersion)
            rebuildDiscoveryModels()
            if page.hasMore != true, nextCursor >= page.latestVersion { break }
        }
    }

    private func validateWork(companyId: String, membershipID: String, generation: Int, taskID: UUID, bootstrap: Bool) throws {
        try Task.checkCancellation()
        guard lifecycleGeneration == generation,
              companies.contains(where: { $0.id == companyId && $0.membershipId == membershipID }),
              (bootstrap ? bootstrapTaskIDs[companyId] : drainTaskIDs[companyId]) == taskID else { throw CancellationError() }
    }

    private func invalidateReplica(companyId: String) {
        drainTasks.removeValue(forKey: companyId)?.cancel()
        drainTaskIDs.removeValue(forKey: companyId)
        entitiesByCompany[companyId] = [:]
        cursorByCompany.removeValue(forKey: companyId)
        authorizationEpochByCompany.removeValue(forKey: companyId)
        rebuildDiscoveryModels()
    }

    private func apply(
        _ changes: [PathwaySyncChange],
        to entities: inout [PathwaySyncEntityKey: PathwaySyncChange]
    ) {
        for change in changes {
            let key = PathwaySyncEntityKey(kind: change.entityKind, id: change.entityId)
            if change.changeKind == "tombstone" {
                entities.removeValue(forKey: key)
            } else {
                entities[key] = change
            }
        }
    }

    private func rebuildDiscoveryModels(persist: Bool = true) {
        var snapshot = PathwayDiscoverySnapshot()
        var nextDecoded: [String: [PathwaySyncEntityKey: PathwayDecodedDiscovery]] = [:]
        let discoveryKinds: Set<String> = ["environmentRegistration", "cloudProject", "environmentBinding", "agentThread"]
        for (companyId, entities) in entitiesByCompany {
            var companyDecoded: [PathwaySyncEntityKey: PathwayDecodedDiscovery] = [:]
            for (key, change) in entities where discoveryKinds.contains(change.entityKind) {
                let decoded: PathwayDecodedDiscovery
                if let cached = decodedDiscovery[companyId]?[key], cached.change == change {
                    decoded = cached
                } else {
                    var item = PathwayDiscoverySnapshot()
                    item.apply(change, companyId: companyId)
                    decoded = PathwayDecodedDiscovery(change: change, snapshot: item)
                }
                companyDecoded[key] = decoded
                snapshot.environments += decoded.snapshot.environments
                snapshot.projects += decoded.snapshot.projects
                snapshot.bindings += decoded.snapshot.bindings
                snapshot.threads += decoded.snapshot.threads
            }
            nextDecoded[companyId] = companyDecoded
        }
        decodedDiscovery = nextDecoded

        let nextEnvironments = snapshot.environments.sorted {
            $0.environment.label.localizedStandardCompare($1.environment.label) == .orderedAscending
        }
        let nextProjects = snapshot.projects.sorted {
            $0.project.name.localizedStandardCompare($1.project.name) == .orderedAscending
        }
        let nextBindings = snapshot.bindings.sorted { $0.id < $1.id }
        let nextThreads = snapshot.threads.sorted { $0.id < $1.id }
        if environments != nextEnvironments { environments = nextEnvironments }
        if projects != nextProjects { projects = nextProjects }
        if environmentBindings != nextBindings { environmentBindings = nextBindings }
        if discoveryThreads != nextThreads {
            let previous = Dictionary(uniqueKeysWithValues: discoveryThreads.map { ($0.id, $0) })
            for thread in nextThreads {
                if let old = previous[thread.id], old.shell.branch != thread.shell.branch || old.shell.worktreePath != thread.shell.worktreePath {
                    changeRequestStates.removeValue(forKey: thread.id)
                }
            }
            discoveryThreads = nextThreads
            threads = nextThreads
            rebuildThreadPartition()
        }
        let replica = entitiesByCompany.mapValues { Array($0.values) }
        issues.replaceReplica(
            replica,
            companies: companies,
            versions: cursorByCompany
        )
        calendar.replaceReplica(replica, companies: companies)
        email.replaceReplica(replica, companies: companies)
        replicaRevision += 1
        if persist { persistDiscovery() }
    }

    private func persistDiscovery() {
        guard discoveryCache != nil, cacheTask == nil else { return }
        cacheTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
            guard let self, !Task.isCancelled, let cache = discoveryCache else { return }
            cacheTask = nil
            let date = Date()
            let generation = lifecycleGeneration
            let directory = storageDirectory
            let snapshot = PathwayDiscoveryCache.Snapshot(companies: companies,
                entities: entitiesByCompany.mapValues { Array($0.values) }, versions: cursorByCompany, savedAt: date)
            await cache.save(snapshot, revision: DispatchTime.now().uptimeNanoseconds)
            if storageDirectory == directory, lifecycleGeneration == generation, !Task.isCancelled { cachedAt = date }
        }
    }

    private func rebuildThreadPartition() {
        let partition = PathwayThreadLifecyclePartition(
            threads: threads,
            now: Date(),
            changeRequestStates: changeRequestStates,
            autoSettleAfterDays: PathwayGeneralPreferences.shared.autoSettleDays == 0 ? nil : PathwayGeneralPreferences.shared.autoSettleDays
        )
        threads = partition.all
        activeThreads = partition.active
        snoozedThreads = partition.snoozed
        settledThreads = partition.settled
    }

    private func updateConnectionStateIfReady() {
        guard !companies.isEmpty else { return }
        let isReady = companies.allSatisfy { cursorByCompany[$0.id] != nil }
        connectionState = isReady ? .connected : .syncing
    }

    private func removeCompanies(notIn activeCompanyIds: Set<String>) {
        let tracked = Set(entitiesByCompany.keys).union(bootstrapTasks.keys).union(headSubscriptions.keys).union(drainTasks.keys)
        let removedIds = tracked.subtracting(activeCompanyIds)
        for companyId in removedIds {
            entitiesByCompany.removeValue(forKey: companyId)
            cursorByCompany.removeValue(forKey: companyId)
            latestVersionByCompany.removeValue(forKey: companyId)
            authorizationEpochByCompany.removeValue(forKey: companyId)
            latestHeadByCompany.removeValue(forKey: companyId)
            headSubscriptions.removeValue(forKey: companyId)?.cancel()
            bootstrapTasks.removeValue(forKey: companyId)?.cancel()
            bootstrapTaskIDs.removeValue(forKey: companyId)
            drainTasks.removeValue(forKey: companyId)?.cancel()
            drainTaskIDs.removeValue(forKey: companyId)
        }
        if !removedIds.isEmpty {
            rebuildDiscoveryModels()
        }
    }

    private func fail(_ error: any Error) {
        pathwayCloudLogger.error("Convex sync failed: \(error.localizedDescription, privacy: .public)")
        connectionState = .failed(
            "Pathway couldn’t sync your workspace. Check your connection and try again."
        )
    }

    private func cancelWork() {
        lifecycleGeneration += 1
        cacheTask?.cancel()
        cacheTask = nil
        lifecycleMetadataID = nil
        isRefreshingLifecycleMetadata = false
        companiesSubscription?.cancel()
        companiesSubscription = nil
        headSubscriptions.values.forEach { $0.cancel() }
        headSubscriptions = [:]
        bootstrapTasks.values.forEach { $0.cancel() }
        bootstrapTasks = [:]
        bootstrapTaskIDs = [:]
        drainTasks.values.forEach { $0.cancel() }
        drainTasks = [:]
        drainTaskIDs = [:]
        isProvisioning = false
    }
}

private struct PathwaySyncEntityKey: Hashable {
    let kind: String
    let id: String
}

private struct PathwayAgentThreadPayload: Decodable {
    let environmentId: String
    let cloudProjectId: String
    let shell: PathwayAgentThreadShell
    let updatedAt: Double

    func thread(companyId: String) -> PathwayAgentThread {
        PathwayAgentThread(
            companyId: companyId,
            environmentId: environmentId,
            cloudProjectId: cloudProjectId,
            shell: shell,
            cloudUpdatedAt: updatedAt
        )
    }
}

private struct PathwayDiscoverySnapshot {
    var environments: [PathwayCompanyEnvironment] = []
    var projects: [PathwayCompanyProject] = []
    var bindings: [PathwayCompanyEnvironmentBinding] = []
    var threads: [PathwayAgentThread] = []

    mutating func apply(_ change: PathwaySyncChange, companyId: String) {
        guard let payload = change.payload else { return }
        do {
            switch change.entityKind {
            case "environmentRegistration":
                let value = try decodePathwayPayload(PathwayEnvironment.self, from: payload)
                environments.append(
                    PathwayCompanyEnvironment(companyId: companyId, environment: value)
                )
            case "cloudProject":
                let value = try decodePathwayPayload(PathwayCloudProject.self, from: payload)
                projects.append(PathwayCompanyProject(companyId: companyId, project: value))
            case "environmentBinding":
                let value = try decodePathwayPayload(
                    PathwayEnvironmentBinding.self,
                    from: payload
                )
                if value.status == "active" {
                    bindings.append(
                        PathwayCompanyEnvironmentBinding(companyId: companyId, binding: value)
                    )
                }
            case "agentThread":
                let value = try decodePathwayPayload(
                    PathwayAgentThreadPayload.self,
                    from: payload
                )
                threads.append(value.thread(companyId: companyId))
            default:
                return
            }
        } catch {
            return
        }
    }
}

private struct PathwayDecodedDiscovery {
    let change: PathwaySyncChange
    let snapshot: PathwayDiscoverySnapshot
}
