import Foundation
import Testing
@testable import Pathway

@MainActor
struct PathwayEnvironmentPlacementTests {
    @Test func criticalStorageAvoidanceDefaultsOffAndPersistsWhenEnabled() throws {
        let suite = "storage-placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        #expect(!preferences.avoidCriticalStorage)
        preferences.avoidCriticalStorage = true
        #expect(PathwayEnvironmentPlacementPreferences(defaults: defaults).avoidCriticalStorage)
    }

    @Test func staleOrMissingStorageDoesNotExcludeAnEnvironment() throws {
        var resources = PathwayHostResources(sampledAt: 200_000, cpuUtilization: 0.1, cpuCount: 8,
                                             availableMemoryBytes: 8_000_000_000, totalMemoryBytes: 16_000_000_000)
        #expect(!resources.hasFreshCriticalStorage)
        resources.storagePressure = "critical"
        resources.storageSampledAt = 139_000
        #expect(resources.hasFreshCriticalStorage)
        resources.storageSampledAt = 80_000
        #expect(resources.hasFreshCriticalStorage)
        resources.storageSampledAt = 79_999
        #expect(!resources.hasFreshCriticalStorage)
        resources.storageSampledAt = 10_000
        #expect(!resources.hasFreshCriticalStorage)
        resources.storageSampledAt = 300_000
        #expect(!resources.hasFreshCriticalStorage)
    }

    @Test func conversationPlacementPreservesExplicitEnvironmentWithoutProbingProjectLoadBalancing() async throws {
        let suite = "conversation-placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        preferences.enabled = true
        let conversations = [option("origin"), option("replica")].map {
            PathwayNewThreadBindingOption(binding: nil, environment: $0.environment,
                projectID: nil, projectName: "Conversation", companyName: "Company")
        }
        var requests = 0
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: conversations,
            preferredBindingID: conversations[0].id, choice: nil, preferences: preferences, directory: nil) { _ in
                requests += 1
                return .init(config: self.config, resources: self.resources(cpuCount: 16), receivedAt: ProcessInfo.processInfo.systemUptime)
            }
        #expect(winner == nil)
        #expect(requests == 0)
    }

    @Test func sharedSelectionConformanceFixtures() throws {
        struct Fixture: Decodable {
            struct Candidate: Decodable {
                let environmentId: String
                let resources: PathwayHostResources?
                let receivedAt: Double
                let weight: Int
            }
            let name: String
            let now: Double
            let candidates: [Candidate]
            let expectedEnvironmentId: String?
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appending(path: "packages/client-runtime/src/fixtures/load-balancing.json"))
        for fixture in try JSONDecoder().decode([Fixture].self, from: data) {
            let candidates = fixture.candidates.compactMap { value -> PathwayEnvironmentPlacementCandidate? in
                guard let resources = value.resources else { return nil }
                return .init(bindingID: value.environmentId, environmentID: value.environmentId,
                    resources: resources, receivedAt: value.receivedAt / 1000, weight: value.weight)
            }
            #expect(PathwayEnvironmentPlacement.select(candidates, now: fixture.now / 1000) == fixture.expectedEnvironmentId,
                    "Fixture: \(fixture.name)")
        }
    }

    @Test func placementProbeReadsWithoutSubscriptionsAndClosesConnection() async throws {
        let rpc = PlacementProbeRPC()
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: option("origin").environment,
            connect: connect, makeClient: { _, _ in rpc })
        #expect(await rpc.methods == ["server.getConfig", "server.getHostResources"])
        #expect(await rpc.timeouts == [.seconds(5), .seconds(5)])
        #expect(await rpc.didStop)
        #expect(await rpc.subscriptions.isEmpty)
    }

    @Test(arguments: ["server.getConfig", "server.getHostResources"])
    func placementProbeClosesConnectionWhenAReadFails(method: String) async throws {
        let rpc = PlacementProbeRPC(failingMethod: method)
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        do {
            _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: option("origin").environment,
                connect: connect, makeClient: { _, _ in rpc })
            Issue.record("Expected a failed probe")
        } catch { #expect(error is PathwayRPCError) }
        #expect(await rpc.didStop)
        #expect(await rpc.subscriptions.isEmpty)
    }

    @Test(arguments: [Set<String>(), Set(["orchestration:read", "relay:read"]), Set(["orchestration:read", "relay:write"])])
    func readOnlyConnectionsCannotProvideThreadOperationEndpoints(scopes: Set<String>) {
        let connection = preparedConnection(scopes: scopes)
        do {
            _ = try connection.threadOperationWebSocketURL()
            Issue.record("A connection without orchestration:operate must not be eligible")
        } catch { if case PathwayConnectError.scopeMismatch = error {} else { Issue.record("Unexpected error: \(error)") } }
    }

    @Test func operateConnectionRetainsItsAuthenticatedEndpoint() throws {
        let connection = preparedConnection(scopes: ["orchestration:read", "orchestration:operate"])
        #expect(try connection.threadOperationWebSocketURL() == connection.webSocketURL)
    }

    @Test func readOnlyPlacementProbeClosesBeforeReadingResources() async {
        let rpc = PlacementProbeRPC(operationConnection: preparedConnection(scopes: ["orchestration:read"]))
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        do {
            _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: option("origin").environment,
                connect: connect, makeClient: { _, _ in rpc })
            Issue.record("Read-only connections cannot participate in Auto placement")
        } catch { if case PathwayConnectError.scopeMismatch = error {} else { Issue.record("Unexpected error: \(error)") } }
        #expect(await rpc.methods.isEmpty)
        #expect(await rpc.subscriptions.isEmpty)
        #expect(await rpc.didStop)
    }

    @Test func freshValidationRejectsReadOnlyConnectionBeforePreparingALaunch() async {
        var launches = 0
        let model = creation { _, _ in launches += 1; throw PathwayRPCError.disconnected }
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.prompt = "Do not launch through a downgraded connection"
        model.isAutomaticPlacement = true
        let rpc = PlacementProbeRPC(operationConnection: preparedConnection(scopes: ["orchestration:read"]))
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        model.validatePlacement = {
            _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: self.option("origin").environment,
                connect: connect, makeClient: { _, _ in rpc })
        }
        #expect(await model.launch() == nil)
        #expect(launches == 0)
        #expect(!model.hasPendingLaunch)
        #expect(await rpc.didStop)
    }

    @Test func preferencesDefaultOffAndPersistOnlyValidWeights() throws {
        let suite = "placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        #expect(!preferences.enabled)
        #expect(preferences.weight(for: "server") == 50)
        preferences.enabled = true
        preferences.setWeight(0, for: "server")
        preferences.setWeight(99, for: "invalid")
        let restored = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        #expect(restored.enabled)
        #expect(restored.weight(for: "server") == 0)
        #expect(restored.weight(for: "invalid") == 50)
    }

    @Test func resolvesLocalInstanceAndRejectsAmbiguousAccountsOrUnsupportedOptions() {
        let choice = PathwayPlacementModelChoice(driver: "codex", model: "model",
            options: ["effort": .string("high")], interactionMode: "default")
        let provider = PathwayAgentThreadModel.provider(providerConfig("remote-account"))!
        #expect(choice.provider(in: [provider])?.id == "remote-account")
        #expect(choice.provider(in: [provider, provider]) == nil)
        let unsupported = PathwayPlacementModelChoice(driver: "codex", model: "model",
            options: ["effort": .string("unsupported")], interactionMode: "default")
        #expect(unsupported.provider(in: [provider]) == nil)
    }

    @Test func automaticPlacementRequiresConfirmedAuthentication() {
        var unknown = providerConfig("unknown").objectValue!
        unknown["auth"] = .object(["status": .string("unknown")])
        var failed = providerConfig("failed").objectValue!
        failed["status"] = .string("error")
        let available = PathwayEnvironmentPlacement.availableProviders(.object([
            "providers": .array([.object(unknown), .object(failed), providerConfig("ready")])]))
        #expect(available.map(\.id) == ["ready"])
    }

    @Test func resolverOnlyProbesActiveCopiesOfSelectedProjectAndIgnoresManualOnlyHosts() async throws {
        let suite = "placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        preferences.enabled = true
        preferences.setWeight(0, for: "manual")
        var requests: [String] = []
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: [
            option("origin"), option("replica"), option("other", project: "unrelated"),
            option("inactive", status: "removed"), option("manual")
        ], preferredBindingID: option("origin").id, choice: nil, preferences: preferences, directory: nil) { environment in
            requests.append(environment.environment.environmentId)
            return .init(config: self.config,
                resources: self.resources(cpuCount: environment.environment.environmentId == "replica" ? 16 : 4),
                receivedAt: ProcessInfo.processInfo.systemUptime)
        }
        #expect(winner == option("replica").id)
        #expect(Set(requests) == Set(["origin", "replica"]))
    }

    @Test func resolverPreservesPreferredCheckoutAndRejectsAmbiguousRemoteCheckouts() async throws {
        let suite = "placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        preferences.enabled = true
        let origin = option("origin", environmentID: "current-host")
        var requested: [String] = []
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: [
            option("alternate-checkout", environmentID: "current-host"), origin,
            option("remote-a", environmentID: "ambiguous-host"), option("remote-b", environmentID: "ambiguous-host"),
            option("replica")
        ], preferredBindingID: origin.id, choice: nil, preferences: preferences, directory: nil) { environment in
            requested.append(environment.environment.environmentId)
            return .init(config: self.config, resources: self.resources(cpuCount: environment.environment.environmentId == "current-host" ? 16 : 4),
                receivedAt: ProcessInfo.processInfo.systemUptime)
        }
        #expect(winner == origin.id)
        #expect(Set(requested) == Set(["current-host", "replica"]))
        #expect(requested.count == 2)
    }

    @Test func resolverCollapsesDuplicateRegistrationsOfOneRemoteCheckout() async throws {
        let suite = "placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        preferences.enabled = true
        var requested: [String] = []
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: [option("origin"),
            option("replica-a", environmentID: "replica", localProjectID: "same", workspaceRoot: "/same"),
            option("replica-b", environmentID: "replica", localProjectID: "same", workspaceRoot: "/same")
        ], preferredBindingID: option("origin").id, choice: nil, preferences: preferences, directory: nil) { environment in
            requested.append(environment.environment.environmentId)
            return .init(config: self.config, resources: self.resources(cpuCount: environment.environment.environmentId == "replica" ? 16 : 4),
                receivedAt: ProcessInfo.processInfo.systemUptime)
        }
        #expect(winner == "company:replica-a")
        #expect(requested.count == 2)
    }

    @Test func explicitAutoClearsAndPersistsAHistoricalPinWhenDraftIsEmpty() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = creation(directory: directory)
        await model.restoreDraft()
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.pinPlacement()
        model.workspaceMode = "worktree"
        model.workspaceMode = "local"
        model.runtimeMode = "approval-required"
        await model.persistDraftNow()
        #expect(await PathwayEnvironmentPlacement.hasSavedDraft(bindingID: model.bindingID, directory: directory))
        #expect(model.canAutomaticallyPlace)
        #expect(await model.prepareAutomaticPlacement())
        #expect(!model.placementPinned)
        #expect(!(await PathwayEnvironmentPlacement.hasSavedDraft(bindingID: model.bindingID, directory: directory)))
        let destination = creation()
        destination.isAutomaticPlacement = true
        destination.automaticModelChoice = model.placementModelChoice
        destination.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        #expect(destination.runtimeMode == "approval-required")
        await model.stop()
    }

    @Test func explicitAutoCannotReleaseDraftContentWorkspaceOrPendingLaunch() async {
        let model = creation { _, _ in throw PathwayRPCError.disconnected }
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.pinPlacement()
        model.prompt = "Keep this draft"
        #expect(!(await model.prepareAutomaticPlacement()))
        model.prompt = ""
        model.initialImageUploads = [.object(["id": .string("bound-upload")])]
        #expect(!(await model.prepareAutomaticPlacement()))
        model.initialImageUploads = []
        model.workspaceMode = "worktree"
        #expect(!(await model.prepareAutomaticPlacement()))
        model.workspaceMode = "local"
        model.branch = "existing-branch"
        #expect(!(await model.prepareAutomaticPlacement()))
        model.branch = ""
        model.prompt = "Launch then lose the response"
        #expect(await model.launch() == nil)
        model.prompt = ""
        #expect(model.hasPendingLaunch)
        #expect(!(await model.prepareAutomaticPlacement()))
        #expect(model.placementPinned)
    }

    @Test func savedDraftPinsEnvironmentBeforeAnyProbe() async throws {
        let suite = "placement-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let preferences = PathwayEnvironmentPlacementPreferences(defaults: defaults)
        preferences.enabled = true
        let model = creation(directory: directory)
        await model.restoreDraft()
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.prompt = "Keep my draft here"
        await model.persistDraftNow()
        let winner = await PathwayEnvironmentPlacement.resolve(bindings: [option("origin"), option("replica")],
            preferredBindingID: option("origin").id, choice: nil, preferences: preferences, directory: directory) { _ in
                Issue.record("A saved draft must pin before querying another environment")
                throw PathwayRPCError.disconnected
            }
        #expect(winner == nil)
        await model.stop()
    }

    @Test func autoOnCurrentEnvironmentRemapsUnknownAccountToAuthenticatedLocalInstance() {
        let model = creation()
        var unknown = providerConfig("unknown").objectValue!
        unknown["auth"] = .object(["status": .string("unknown")])
        let serverConfig = JSONValue.object(["providers": .array([.object(unknown), providerConfig("ready")])])
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": serverConfig]))
        #expect(model.selectedProviderID == "unknown")
        model.activateAutomaticPlacement(choice: model.placementModelChoice)
        #expect(model.selectedProviderID == "ready")
        #expect(model.automaticModelChoice == nil)
    }

    @Test func automaticModelResolutionDoesNotFallBackWhenRequestedModelDisappears() {
        let model = creation()
        model.isAutomaticPlacement = true
        model.automaticModelChoice = .init(driver: "codex", model: "missing", options: [:], interactionMode: "default")
        model.prompt = "Use my model"
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        #expect(!model.canLaunch)
        model.automaticModelChoice = .init(driver: "codex", model: "model", options: [:], interactionMode: "default")
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        #expect(model.selectedProviderID == "account")
        #expect(model.canLaunch)
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object(["providers": .array([])])]))
        #expect(!model.canLaunch)
        #expect(model.selectedProviderID == "account")
    }

    @Test func uncertainLaunchRetriesIdenticalCommandWithoutRevalidatingOrMoving() async throws {
        var payloads: [JSONValue] = []
        var validations = 0
        let model = creation { method, payload in
            #expect(method == "orchestration.launchThread")
            payloads.append(payload)
            throw PathwayRPCError.disconnected
        }
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.prompt = "Run here"
        model.isAutomaticPlacement = true
        model.validatePlacement = { validations += 1 }
        #expect(await model.launch() == nil)
        #expect(model.hasPendingLaunch)
        #expect(!model.canAutomaticallyPlace)
        #expect(await model.launch() == nil)
        #expect(validations == 1)
        #expect(payloads.count == 2)
        #expect(payloads.first == payloads.last)
        #expect(model.bindingID == option("origin").id)
    }

    @Test func failedPlacementValidationDoesNotPrepareLaunchAndManualOverrideCanProceed() async {
        var requests = 0
        let model = creation { _, _ in requests += 1; throw PathwayRPCError.disconnected }
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": config]))
        model.prompt = "Run here"
        model.isAutomaticPlacement = true
        model.validatePlacement = { throw PathwayRPCError.disconnected }
        #expect(await model.launch() == nil)
        #expect(requests == 0)
        #expect(!model.hasPendingLaunch)
        model.pinPlacement()
        #expect(!model.usesAutomaticPlacement)
        #expect(await model.launch() == nil)
        #expect(requests == 1)
    }

    private func preparedConnection(scopes: Set<String>) -> PathwayPreparedEnvironmentConnection {
        .init(environmentID: "origin", label: "Origin", httpBaseURL: URL(string: "https://environment.test")!,
            webSocketURL: URL(string: "wss://environment.test/ws?wsTicket=test")!, accessToken: "test",
            proofKeyThumbprint: "test", scopes: scopes)
    }

    private func option(_ id: String, project: String = "project", status: String = "active",
                        environmentID: String? = nil, localProjectID: String? = nil, workspaceRoot: String? = nil) -> PathwayNewThreadBindingOption {
        let environmentID = environmentID ?? id
        return .init(binding: .init(companyId: "company", binding: .init(id: id, cloudProjectId: project,
            environmentId: environmentID, localProjectId: localProjectID ?? "local-\(id)",
            localWorkspaceRoot: workspaceRoot ?? "/\(id)", status: status, lastSeenAt: nil)),
            environment: .init(companyId: "company", environment: .init(id: environmentID, environmentId: environmentID,
                descriptor: .init(environmentId: environmentID, label: environmentID, serverVersion: "test"), relayLinkState: "linked",
                managedEndpointAvailable: true, lastSeenAt: nil, state: "active")),
            projectID: project, projectName: project, companyName: "Company")
    }
    private func creation(directory: URL? = nil, request: @escaping PathwayAgentThreadCreationModel.Request = { _, _ in .null }) -> PathwayAgentThreadCreationModel {
        let origin = option("origin")
        return PathwayAgentThreadCreationModel(binding: origin.binding, environment: origin.environment,
            storageDirectory: directory, request: request)
    }
    private var config: JSONValue {
        .object(["settings": .object(["defaultThreadEnvMode": .string("local")]),
                 "providers": .array([providerConfig("account")])])
    }
    private func providerConfig(_ id: String) -> JSONValue {
        let option = JSONValue.object([
            "id": .string("effort"), "label": .string("Effort"), "type": .string("select"),
            "options": .array([.object(["id": .string("high"), "label": .string("High"), "isDefault": .bool(true)])])])
        let model = JSONValue.object([
            "slug": .string("model"), "name": .string("Model"), "isDefault": .bool(true),
            "capabilities": .object(["optionDescriptors": .array([option])])])
        return .object(["instanceId": .string(id), "driver": .string("codex"), "enabled": .bool(true),
            "installed": .bool(true), "auth": .object(["status": .string("authenticated")]), "models": .array([model])])
    }
    private func resources(cpuCount: Int) -> JSONValue {
        .object(["sampledAt": .number(0), "cpuUtilization": .number(0.2), "cpuCount": .number(Double(cpuCount)),
                 "availableMemoryBytes": .number(500), "totalMemoryBytes": .number(1000)])
    }
}

private actor PlacementProbeRPC: PathwayIssueRPCClient {
    private let failingMethod: String?
    private let operationConnection: PathwayPreparedEnvironmentConnection?
    private let stream: AsyncThrowingStream<JSONValue, Error>
    private let continuation: AsyncThrowingStream<JSONValue, Error>.Continuation
    private(set) var methods: [String] = []
    private(set) var subscriptions: [String] = []
    private(set) var timeouts: [Duration] = []
    private(set) var didStop = false

    init(failingMethod: String? = nil, operationConnection: PathwayPreparedEnvironmentConnection? = nil) {
        self.failingMethod = failingMethod
        self.operationConnection = operationConnection
        (stream, continuation) = AsyncThrowingStream.makeStream()
    }
    func subscribe(_ tag: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error> { subscriptions.append(tag); return stream }
    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool, waitForSubscription: Bool, timeout: Duration) async throws -> JSONValue {
        #expect(!requiresSubscription && !waitForSubscription)
        if let operationConnection { _ = try operationConnection.threadOperationWebSocketURL() }
        methods.append(tag)
        timeouts.append(timeout)
        if tag == failingMethod { throw PathwayRPCError.disconnected }
        return .object([:])
    }
    func stop() async { didStop = true; continuation.finish() }
}
