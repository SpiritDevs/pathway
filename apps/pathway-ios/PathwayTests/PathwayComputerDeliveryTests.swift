import Foundation
@testable import Pathway
import Testing

/// Computer intent on the paths that actually deliver a send: which access judges it, which
/// control generation it is pinned to, and which entry points keep a bare `/computer-use`.
@Suite(.serialized)
@MainActor
struct PathwayComputerDeliveryTests {
    private let config: [String: JSONValue] = [
        "environment": .object(["platform": .object(["os": .string("darwin")]),
                                "capabilities": .object(["computerPolicy": .bool(true), "computerOperateScope": .bool(true)])])
    ]

    @Test func implicitIntentWaitsForKnownAccess() async {
        let model = makeModel { _, _ in .object(["controlGeneration": .number(2)]) }
        model.computerAccessPolicy = "scoped"
        #expect(await model.computerFields(for: "Explain this function", setting: true).isEmpty)
        #expect(await model.computerFields(for: "/computer-use open Notes", setting: true) == ["computerControlGeneration": .number(2)])
        model.computerSessionScopes = ["orchestration:operate", "computer:operate"]
        #expect(await model.computerFields(for: "Explain this function", setting: true)
            == ["computerControlGeneration": .number(2), "enableComputerControl": .bool(true)])
        model.computerAccessPolicy = nil
        #expect(await model.computerFields(for: "Explain this function", setting: true).isEmpty)
    }

    @Test func aNewChatAsksForComputerOnlyWithKnownAccess() {
        let model = PathwayAgentThreadCreationModel(environment: environment(), request: { _, _ in .object([:]) })
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object(config)]))
        #expect(model.computerLaunchFields(for: "Explain this function", setting: true).isEmpty)
        #expect(model.computerLaunchFields(for: "/computer-use open Notes", setting: false) == ["computerControlGeneration": .number(0)])
        var withPolicy = config
        withPolicy["settings"] = .object(["computer": .object(["accessPolicy": .string("scoped")])])
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object(withPolicy)]))
        #expect(model.computerLaunchFields(for: "Explain this function", setting: true).isEmpty)
        model.computerSessionScopes = ["orchestration:operate", "computer:operate"]
        #expect(model.computerLaunchFields(for: "Explain this function", setting: true)
            == ["computerControlGeneration": .number(0), "enableComputerControl": .bool(true)])
        // The cloud queue delivers with orchestration:operate alone, which a scoped policy refuses.
        #expect(model.computerLaunchFields(for: "Explain this function", queued: true, setting: true).isEmpty)
        model.applySubscriptionValue(.object(["type": .string("settingsUpdated"), "payload": .object([
            "settings": .object(["computer": .object(["accessPolicy": .string("any-operator")])])])]))
        #expect(model.computerLaunchFields(for: "Explain this function", queued: true, setting: true)
            == ["computerControlGeneration": .number(0), "enableComputerControl": .bool(true)])
    }

    @Test func theCloudQueueIsJudgedByTheScopeItDeliversWith() async throws {
        let restore = enableComputerSetting(); defer { restore() }
        let directory = FileManager.default.temporaryDirectory.appending(path: "computer-delivery-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = PathwayThreadQueueModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                            subscribe: { _, _ in AsyncThrowingStream { _ in } })
        await queue.configure(directory: directory)
        queue.observe(companies: ["company-1"])
        defer { queue.stop(clear: true) }
        let model = makeModel { _, _ in .object(["controlGeneration": .number(3)]) }
        model.threadQueue = queue
        model.computerAccessPolicy = "scoped"
        model.computerSessionScopes = ["orchestration:operate", "computer:operate"]
        #expect(model.computerNewChatFields(for: "Explain this function", launches: false, setting: true)["enableComputerControl"] == .bool(true))
        #expect(model.computerNewChatFields(for: "Explain this function", launches: false, queued: true, setting: true).isEmpty)

        model.draft = "Explain this function"
        await model.send()
        model.computerAccessPolicy = "any-operator"
        model.draft = "Explain this other function"
        await model.send()
        let inputs = try await PathwayThreadQueueStore(directory: directory).load()
            .compactMap { $0.submission.objectValue?["input"]?.objectValue }
        #expect(inputs.count == 2)
        let scoped = try #require(inputs.first { $0["text"] == .string("Explain this function") })
        #expect(scoped["enableComputerControl"] == nil)
        #expect(scoped["computerControlGeneration"] == nil)
        let anyOperator = try #require(inputs.first { $0["text"] == .string("Explain this other function") })
        #expect(anyOperator["enableComputerControl"] == .bool(true))
        #expect(anyOperator["computerControlGeneration"] == .number(3))
    }

    private func environment() -> PathwayCompanyEnvironment {
        let thread = makeAgentThread()
        return PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
    }

    private func makeModel(request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let model = PathwayAgentThreadModel(thread: makeAgentThread(), environment: environment(), request: request)
        model.serverConfig = config
        return model
    }

    /// Turns the device-wide Computer control setting on, returning its restore.
    private func enableComputerSetting() -> () -> Void {
        let key = PathwayAgentThreadModel.computerControlDefaultsKey
        let previous = UserDefaults.standard.object(forKey: key)
        UserDefaults.standard.set(true, forKey: key)
        return { if let previous { UserDefaults.standard.set(previous, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
    }
}
