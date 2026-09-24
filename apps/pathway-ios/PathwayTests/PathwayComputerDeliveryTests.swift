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

    @Test func implicitIntentWaitsForKnownAccess() async throws {
        let model = makeModel { _, _ in .object(["controlGeneration": .number(2)]) }
        model.computerAccessPolicy = "scoped"
        #expect(try await model.computerFields(for: "Explain this function", setting: true).isEmpty)
        #expect(try await model.computerFields(for: "/computer-use open Notes", setting: true) == ["computerControlGeneration": .number(2)])
        model.computerSessionScopes = ["orchestration:operate", "computer:operate"]
        #expect(try await model.computerFields(for: "Explain this function", setting: true)
            == ["computerControlGeneration": .number(2), "enableComputerControl": .bool(true)])
        model.computerAccessPolicy = nil
        #expect(try await model.computerFields(for: "Explain this function", setting: true).isEmpty)
    }

    @Test func aNewChatAsksForComputerOnlyWithKnownAccess() {
        let model = PathwayAgentThreadCreationModel(environment: computerTestEnvironment(), request: { _, _ in .object([:]) })
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

    @Test func aReconnectForgetsTheConfirmedGeneration() async throws {
        var reads = 0
        let model = makeModel { method, _ in
            if method == "computer.getThreadState" { reads += 1; return .object(["controlGeneration": .number(6)]) }
            return .object([:])
        }
        model.computerControlGeneration = 5
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("connecting")]))
        model.applySubscriptionValue(.object(["kind": .string("synchronized")]))
        #expect(try await model.computerFields(for: "/computer-use open Notes", setting: false) == ["computerControlGeneration": .number(6)])
        #expect(reads == 1)
        model.computerControlGeneration = 6
        await model.stop()
        #expect(model.computerControlGeneration == nil)
    }

    @Test func aSupersededGenerationReadAbortsTheSend() async throws {
        let gate = ComputerReadGate()
        var dispatches = 0
        let model = makeModel { method, _ in
            if method == "computer.getThreadState" { return await gate.read() }
            dispatches += 1; return .object([:])
        }
        model.draft = "/computer-use open Notes"
        let send = Task { await model.send() }
        await gate.started(1)
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        gate.finish(.object(["controlGeneration": .number(7)]))
        await send.value
        #expect(dispatches == 0)
        #expect(model.draft == "/computer-use open Notes")
        #expect(model.actionError == PathwayComputerInvocation.supersededReadMessage)
        #expect(!model.isSending)
    }

    @Test func anExistingChatNeverFallsBackToGenerationZero() async throws {
        let model = makeModel { _, _ in throw URLError(.networkConnectionLost) }
        model.computerAccessPolicy = "any-operator"
        model.computerSessionScopes = ["orchestration:operate"]
        await #expect(throws: PathwayThreadConversationError.self) {
            try await model.computerFields(for: "/computer-use open Notes", setting: false)
        }
        #expect(try await model.computerFields(for: "Explain this function", setting: true).isEmpty)
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        await #expect(throws: PathwayThreadConversationError.self) {
            try await model.computerFields(for: "/computer-use open Notes", queued: true, setting: false)
        }
        #expect(try await model.computerFields(for: "Explain this function", queued: true, setting: true).isEmpty)
    }

    @Test func aLateConfigReadNeverLandsAfterStop() async throws {
        let gate = ComputerReadGate()
        let model = makeModel { _, _ in await gate.read() }
        var withPolicy = config
        withPolicy["settings"] = .object(["computer": .object(["accessPolicy": .string("any-operator")])])
        let load = Task { await model.refreshServerConfig() }
        await gate.started(1)
        await model.stop()
        load.cancel()
        gate.finish(.object(withPolicy))
        await load.value
        #expect(model.computerAccessPolicy == nil)
        model.installServerConfig(.object(withPolicy))
        #expect(model.computerAccessPolicy == "any-operator")
    }

    @Test func aRestartIsReservedUntilItIsSent() async throws {
        let gate = ComputerReadGate()
        var dispatches = 0
        let model = makeModel { method, _ in
            if method == "computer.getThreadState" { return await gate.read() }
            dispatches += 1; return .object([:])
        }
        installEditable(in: model)
        let item = try #require(model.items.first)
        let first = Task { try await model.editLatestUserMessage(item, text: "/computer-use open Notes") }
        await gate.started(1)
        #expect(model.isRestartingMessage)
        let second = Task { try await model.editLatestUserMessage(item, text: "/computer-use open Notes") }
        gate.settle(.object(["controlGeneration": .number(4)]))
        try await first.value
        await #expect(throws: PathwayThreadConversationError.self) { try await second.value }
        #expect(dispatches == 1)
        #expect(!model.isRestartingMessage)
    }

    @Test func aRestartThatStoppedBeingEditableWhileWaitingIsNotSent() async throws {
        let gate = ComputerReadGate()
        var dispatches = 0
        let model = makeModel { method, _ in
            if method == "computer.getThreadState" { return await gate.read() }
            dispatches += 1; return .object([:])
        }
        installEditable(in: model)
        let item = try #require(model.items.first)
        let restart = Task { try await model.editLatestUserMessage(item, text: "/computer-use open Notes") }
        await gate.started(1)
        installEditable(in: model, laterMessage: true)
        gate.finish(.object(["controlGeneration": .number(4)]))
        await #expect(throws: PathwayThreadConversationError.self) { try await restart.value }
        #expect(dispatches == 0)
        #expect(!model.isRestartingMessage)
    }

    @Test func onlyTheCurrentConnectionConfirmsAGeneration() throws {
        var session = PathwayThreadComputerSession(threadID: "thread")
        func state(version: Int, generation: Int) throws -> PathwayThreadComputerState {
            try #require(PathwayThreadComputerState(.object([
                "threadId": .string("thread"), "computerId": .string("mac"), "version": .number(Double(version)),
                "availability": .object(["kind": .string("available")]), "controlGeneration": .number(Double(generation))])))
        }
        session.upsert(try state(version: 9, generation: 5))
        #expect(session.confirmedControlGeneration == 5)
        session.rebase()
        #expect(session.confirmedControlGeneration == nil)
        session.upsert(try state(version: 0, generation: 6))
        #expect(session.confirmedControlGeneration == 6)
    }

    private func makeModel(request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let model = PathwayAgentThreadModel(thread: makeAgentThread(), environment: computerTestEnvironment(), request: request)
        model.serverConfig = config
        return model
    }

    /// A failed run whose user message can be edited and restarted; a later message makes it stale.
    private func installEditable(in model: PathwayAgentThreadModel, laterMessage: Bool = false) {
        func message(_ id: String) -> JSONValue {
            .object(["item": .object(["id": .string(id), "type": .string("user_message"), "createdBy": .string("user"),
                                      "messageId": .string(id), "runId": .string("run"), "text": .string("Original")])])
        }
        let selection = try! PathwayAgentThreadModel.json(model.currentModelSelection)
        model.installSnapshot(.object(["thread": .object(["id": .string(model.threadID)]),
            "runs": .array([.object(["id": .string("run"), "ordinal": .number(1), "status": .string("failed"),
                                    "providerThreadId": .string("provider-thread"), "userMessageId": .string("message"), "modelSelection": selection])]),
            "providerThreads": .array([.object(["id": .string("provider-thread"), "providerSessionId": .string("session")])]),
            "providerSessions": .array([.object(["id": .string("session"), "capabilities": .object(["checkpointing": .object(["providerCanRollbackConversation": .bool(true)])])])]),
            "checkpointScopes": .array([.object(["id": .string("scope"), "runId": .string("run"), "kind": .string("root_run")])]),
            "checkpoints": .array([.object(["id": .string("checkpoint"), "scopeId": .string("scope"), "status": .string("ready"), "ordinalWithinScope": .number(0)])]),
            "visibleTurnItems": .array([message("message")] + (laterMessage ? [message("message-2")] : []))]))
    }

    /// Turns the device-wide Computer control setting on, returning its restore.
    private func enableComputerSetting() -> () -> Void {
        let key = PathwayAgentThreadModel.computerControlDefaultsKey
        let previous = UserDefaults.standard.object(forKey: key)
        UserDefaults.standard.set(true, forKey: key)
        return { if let previous { UserDefaults.standard.set(previous, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
    }
}

func computerTestEnvironment() -> PathwayCompanyEnvironment {
    let thread = makeAgentThread()
    return PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
        descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
        relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
}

/// Holds `request` calls until the test releases them, and lets the test wait for them to start.
@MainActor
final class ComputerReadGate {
    private var count = 0
    private var settled: JSONValue?
    private var reads: [CheckedContinuation<JSONValue, Never>] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func read() async -> JSONValue {
        count += 1
        if let settled { return settled }
        return await withCheckedContinuation { continuation in
            reads.append(continuation)
            let ready = waiters.filter { $0.0 <= count }
            waiters.removeAll { $0.0 <= count }
            ready.forEach { $0.1.resume() }
        }
    }

    func started(_ target: Int) async {
        if count >= target { return }
        await withCheckedContinuation { waiters.append((target, $0)) }
    }

    func finish(_ value: JSONValue) {
        let pending = reads
        reads.removeAll()
        pending.forEach { $0.resume(returning: value) }
    }

    /// Finishes the waiting reads and answers every later one at once.
    func settle(_ value: JSONValue) {
        settled = value
        finish(value)
    }
}
