import Foundation
import Testing
@testable import Pathway

@MainActor
struct PathwayEnvironmentPlacementTests {
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

    @Test func placementProbeClosesItsSubscriptionAfterBothReads() async throws {
        let rpc = PlacementProbeRPC()
        let probe = PathwayIssueEnvironmentClient { _, _ in rpc }
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: option("origin").environment,
            connect: connect, makeProbe: { probe })
        #expect(await rpc.methods == ["server.getConfig", "server.getHostResources"])
        #expect(await rpc.timeouts == [.seconds(5), .seconds(5)])
        #expect(await rpc.didStop)
    }

    @Test(arguments: ["server.getConfig", "server.getHostResources"])
    func placementProbeClosesItsSubscriptionWhenAReadFails(method: String) async throws {
        let rpc = PlacementProbeRPC(failingMethod: method)
        let probe = PathwayIssueEnvironmentClient { _, _ in rpc }
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        do {
            _ = try await PathwayIssueEnvironmentClient.placementSnapshot(environment: option("origin").environment,
                connect: connect, makeProbe: { probe })
            Issue.record("Expected a failed probe")
        } catch { #expect(error is PathwayRPCError) }
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

    private func option(_ id: String, project: String = "project", status: String = "active") -> PathwayNewThreadBindingOption {
        .init(binding: .init(companyId: "company", binding: .init(id: id, cloudProjectId: project,
            environmentId: id, localProjectId: "local-\(id)", localWorkspaceRoot: "/\(id)", status: status, lastSeenAt: nil)),
            environment: .init(companyId: "company", environment: .init(id: id, environmentId: id,
                descriptor: .init(environmentId: id, label: id, serverVersion: "test"), relayLinkState: "linked",
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
    private let stream: AsyncThrowingStream<JSONValue, Error>
    private let continuation: AsyncThrowingStream<JSONValue, Error>.Continuation
    private(set) var methods: [String] = []
    private(set) var timeouts: [Duration] = []
    private(set) var didStop = false

    init(failingMethod: String? = nil) {
        self.failingMethod = failingMethod
        (stream, continuation) = AsyncThrowingStream.makeStream()
    }
    func subscribe(_ tag: String, payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error> { stream }
    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool, waitForSubscription: Bool, timeout: Duration) async throws -> JSONValue {
        methods.append(tag)
        timeouts.append(timeout)
        if tag == failingMethod { throw PathwayRPCError.disconnected }
        return .object([:])
    }
    func stop() async { didStop = true; continuation.finish() }
}
