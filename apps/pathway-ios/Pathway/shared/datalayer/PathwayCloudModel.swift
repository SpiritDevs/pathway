#if !os(visionOS)
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

        @ObservationIgnored private let client: PathwayConvexClient?
        @ObservationIgnored private var companiesSubscription: AnyCancellable?
        @ObservationIgnored private var headSubscriptions: [String: AnyCancellable] = [:]
        @ObservationIgnored private var bootstrapTasks: [String: Task<Void, Never>] = [:]
        @ObservationIgnored private var drainTasks: [String: Task<Void, Never>] = [:]
        @ObservationIgnored private var entitiesByCompany: [String: [PathwaySyncEntityKey: PathwaySyncChange]] = [:]
        @ObservationIgnored private var cursorByCompany: [String: Int] = [:]
        @ObservationIgnored private var latestVersionByCompany: [String: Int] = [:]
        @ObservationIgnored private var changeRequestStates: [String: PathwayChangeRequestState] = [:]
        @ObservationIgnored private var isRefreshingLifecycleMetadata = false
        @ObservationIgnored private var isProvisioning = false

        init(client: PathwayConvexClient? = nil) {
            self.client = client
        }

        var isConnected: Bool {
            connectionState == .connected
        }

        var errorMessage: String? {
            guard case let .failed(message) = connectionState else { return nil }
            return message
        }

        func start() async {
            guard let client else { return }
            guard connectionState != .connecting, connectionState != .syncing else { return }

            cancelWork()
            connectionState = .connecting
            do {
                try await client.authenticate()
                connectionState = .syncing
                subscribeToCompanies(using: client)
            } catch {
                fail(error)
            }
        }

        func retry() async {
            await stop(clearContent: false)
            await start()
        }

        func stop(clearContent: Bool = true) async {
            cancelWork()
            if let client {
                await client.disconnect()
            }
            connectionState = .disconnected
            if clearContent {
                companies = []
                environments = []
                projects = []
                environmentBindings = []
                threads = []
                activeThreads = []
                snoozedThreads = []
                settledThreads = []
                entitiesByCompany = [:]
                cursorByCompany = [:]
                latestVersionByCompany = [:]
                changeRequestStates = [:]
            }
        }

        func companyName(for companyId: String) -> String? {
            companies.first { $0.id == companyId }?.name
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
            defer { isRefreshingLifecycleMetadata = false }

            let resolutions = await PathwayThreadChangeRequestResolver.resolve(
                threads: activeThreads,
                environments: environments,
                bindings: environmentBindings,
                connect: connect
            )
            guard !Task.isCancelled else { return }
            for resolution in resolutions {
                changeRequestStates[resolution.threadID] = resolution.state
            }
            let currentThreadIDs = Set(threads.map(\.id))
            changeRequestStates = changeRequestStates.filter { currentThreadIDs.contains($0.key) }
            rebuildThreadPartition()
        }
    }

    private extension PathwayCloudModel {
        private func subscribeToCompanies(using client: PathwayConvexClient) {
            companiesSubscription = client.companiesPublisher()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] completion in
                    guard case let .failure(error) = completion else { return }
                    Task { @MainActor [weak self] in
                        self?.fail(error)
                    }
                } receiveValue: { [weak self] companies in
                    Task { @MainActor [weak self] in
                        await self?.received(companies: companies)
                    }
                }
        }

        private func received(companies newCompanies: [PathwayCompany]) async {
            guard let client else { return }
            companies = newCompanies.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

            if newCompanies.isEmpty {
                guard !isProvisioning else { return }
                isProvisioning = true
                do {
                    let company = try await client.provisionCurrentUser()
                    isProvisioning = false
                    await received(companies: [company])
                } catch {
                    isProvisioning = false
                    fail(error)
                }
                return
            }

            let activeCompanyIds = Set(newCompanies.map(\.id))
            removeCompanies(notIn: activeCompanyIds)
            for company in newCompanies where cursorByCompany[company.id] == nil {
                startBootstrap(companyId: company.id)
            }
            updateConnectionStateIfReady()
        }

        private func startBootstrap(companyId: String) {
            guard bootstrapTasks[companyId] == nil else { return }
            bootstrapTasks[companyId] = Task { @MainActor [weak self] in
                guard let self else { return }
                defer { bootstrapTasks[companyId] = nil }
                do {
                    try await bootstrap(companyId: companyId)
                } catch is CancellationError {
                    return
                } catch {
                    fail(error)
                }
            }
        }

        private func bootstrap(companyId: String) async throws {
            guard let client else { return }
            var bootstrapCursor: String?
            var snapshot: [PathwaySyncEntityKey: PathwaySyncChange] = [:]
            var snapshotVersion = 0

            repeat {
                try Task.checkCancellation()
                let page = try await client.bootstrapCompany(
                    companyId: companyId,
                    cursor: bootstrapCursor
                )
                snapshotVersion = page.version
                apply(page.entities, to: &snapshot)
                bootstrapCursor = page.cursor
                if page.isDone {
                    break
                }
            } while bootstrapCursor != nil

            entitiesByCompany[companyId] = snapshot
            cursorByCompany[companyId] = snapshotVersion
            rebuildDiscoveryModels()
            subscribeToHead(companyId: companyId)
            updateConnectionStateIfReady()
        }

        private func subscribeToHead(companyId: String) {
            guard let client, headSubscriptions[companyId] == nil else { return }
            headSubscriptions[companyId] = client.syncHeadPublisher(companyId: companyId)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] completion in
                    guard case let .failure(error) = completion else { return }
                    Task { @MainActor [weak self] in
                        self?.fail(error)
                    }
                } receiveValue: { [weak self] head in
                    Task { @MainActor [weak self] in
                        self?.received(head: head, companyId: companyId)
                    }
                }
        }

        private func received(head: PathwaySyncHead, companyId: String) {
            latestVersionByCompany[companyId] = head.version
            guard (cursorByCompany[companyId] ?? 0) < head.version else { return }
            guard drainTasks[companyId] == nil else { return }

            drainTasks[companyId] = Task { @MainActor [weak self] in
                guard let self else { return }
                defer { drainTasks[companyId] = nil }
                do {
                    try await drainChanges(companyId: companyId)
                } catch is CancellationError {
                    return
                } catch {
                    fail(error)
                }
            }
        }

        private func drainChanges(companyId: String) async throws {
            guard let client else { return }
            while let cursor = cursorByCompany[companyId], cursor < (latestVersionByCompany[companyId] ?? cursor) {
                try Task.checkCancellation()
                let page = try await client.listChanges(companyId: companyId, cursor: cursor)
                if page.tag == "CursorExpired" {
                    try await bootstrap(companyId: companyId)
                    return
                }

                guard let nextCursor = page.cursor else { return }
                var entities = entitiesByCompany[companyId] ?? [:]
                apply(page.changes ?? [], to: &entities)
                entitiesByCompany[companyId] = entities
                cursorByCompany[companyId] = nextCursor
                latestVersionByCompany[companyId] = max(
                    latestVersionByCompany[companyId] ?? 0,
                    page.latestVersion
                )
                rebuildDiscoveryModels()

                if page.hasMore != true, nextCursor >= page.latestVersion {
                    break
                }
            }
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

        private func rebuildDiscoveryModels() {
            var snapshot = PathwayDiscoverySnapshot()
            for (companyId, entities) in entitiesByCompany {
                for change in entities.values {
                    snapshot.apply(change, companyId: companyId)
                }
            }

            environments = snapshot.environments.sorted {
                $0.environment.label.localizedStandardCompare($1.environment.label) == .orderedAscending
            }
            projects = snapshot.projects.sorted {
                $0.project.name.localizedStandardCompare($1.project.name) == .orderedAscending
            }
            environmentBindings = snapshot.bindings
            threads = snapshot.threads
            rebuildThreadPartition()
        }

        private func rebuildThreadPartition() {
            let partition = PathwayThreadLifecyclePartition(
                threads: threads,
                now: Date(),
                changeRequestStates: changeRequestStates
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
            let removedIds = Set(entitiesByCompany.keys).subtracting(activeCompanyIds)
            for companyId in removedIds {
                entitiesByCompany.removeValue(forKey: companyId)
                cursorByCompany.removeValue(forKey: companyId)
                latestVersionByCompany.removeValue(forKey: companyId)
                headSubscriptions.removeValue(forKey: companyId)?.cancel()
                bootstrapTasks.removeValue(forKey: companyId)?.cancel()
                drainTasks.removeValue(forKey: companyId)?.cancel()
            }
            if !removedIds.isEmpty {
                rebuildDiscoveryModels()
            }
        }

        private func fail(_ error: any Error) {
            pathwayCloudLogger.error("Convex sync failed: \(error.localizedDescription, privacy: .public)")
            connectionState = .failed(
                "Pathway couldn’t sync Agent Threads. Check your connection and try again."
            )
        }

        private func cancelWork() {
            companiesSubscription?.cancel()
            companiesSubscription = nil
            headSubscriptions.values.forEach { $0.cancel() }
            headSubscriptions = [:]
            bootstrapTasks.values.forEach { $0.cancel() }
            bootstrapTasks = [:]
            drainTasks.values.forEach { $0.cancel() }
            drainTasks = [:]
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

#endif
