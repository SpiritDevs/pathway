import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayNativeReliabilityTests {
    @Test func disconnectDisablesApprovalUntilFreshSubscriptionCompletes() async throws {
        var calls = 0
        let model = conversation { _, _ in calls += 1; return .object([:]) }
        let item: JSONValue = .object(["id": .string("approval"), "type": .string("approval_request"),
            "status": .string("waiting"), "requestId": .string("request")])
        let runtime: JSONValue = .object(["id": .string("request"), "status": .string("pending"),
            "responseCapability": .object(["type": .string("live")])])
        let projection: JSONValue = .object(["visibleTurnItems": .array([.object(["item": item])]),
            "runtimeRequests": .array([runtime])])
        model.installSnapshot(projection)
        let approval = try #require(model.items.first)
        #expect(model.canRespond(to: approval))
        model.draft = "Keep this"
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        #expect(model.connectionState == .cached)
        #expect(!model.canSend)
        #expect(!model.canRespond(to: approval))
        await model.respondToApproval(requestID: "request", decision: "approve")
        #expect(calls == 0)
        model.applySubscriptionValue(.object(["kind": .string("snapshot"), "projection": projection]))
        #expect(!model.canRespond(to: approval))
        model.applySubscriptionValue(.object(["kind": .string("synchronized")]))
        #expect(model.canRespond(to: approval))
        await model.respondToApproval(requestID: "request", decision: "approve")
        #expect(calls == 1)
    }

    @Test func lostLaunchResponseRetainsOperationAndPreparedAttachments() async throws {
        var launches: [JSONValue] = []
        var preparations: [JSONValue] = []
        let model = creation { method, payload in
            if method == "assets.persistChatAttachments" {
                preparations.append(payload)
                return .object(["attachments": .array([self.attachment])])
            }
            launches.append(payload)
            if launches.count == 1 { throw PathwayRPCError.disconnected }
            return .object(["threadId": payload.objectValue?["threadId"] ?? .null])
        }
        model.prompt = "Create this"
        model.initialImageUploads = [attachment]
        #expect(await model.launch() == nil)
        let threadID = await model.launch()
        #expect(threadID != nil)
        #expect(preparations.count == 1)
        #expect(launches.count == 2)
        #expect(launches[0] == launches[1])
        #expect(preparations[0].objectValue?["threadId"] == launches[0].objectValue?["threadId"])
        #expect(preparations[0].objectValue?["messageId"] == launches[0].objectValue?["commandId"])
    }

    @Test func lostPreparationResponseReusesLaunchNamespaceAndEditedDraftGetsNewIdentity() async {
        var preparations: [JSONValue] = []
        let model = creation { _, payload in preparations.append(payload); throw PathwayRPCError.disconnected }
        model.prompt = "First"
        model.initialImageUploads = [attachment]
        _ = await model.launch()
        _ = await model.launch()
        #expect(preparations.count == 2)
        #expect(preparations[0] == preparations[1])
        model.prompt = "Changed"
        _ = await model.launch()
        #expect(preparations[2].objectValue?["threadId"] != preparations[1].objectValue?["threadId"])
        #expect(preparations[2].objectValue?["messageId"] != preparations[1].objectValue?["messageId"])
    }

    @Test func launchRetrySurvivesModelRecreationAndKeepsWorkspaceChoice() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var payloads: [JSONValue] = []
        let request: PathwayAgentThreadCreationModel.Request = { _, payload in
            payloads.append(payload); throw PathwayRPCError.disconnected
        }
        let first = creation(directory: directory, request: request)
        first.prompt = "Durable launch"
        first.workspaceMode = "worktree"
        first.branch = "feature"
        _ = await first.launch()
        await first.stop()
        let restored = creation(directory: directory, request: request)
        await restored.restoreDraft()
        restored.applySubscriptionValue(config)
        #expect(restored.prompt == "Durable launch")
        #expect(restored.workspaceMode == "worktree")
        _ = await restored.launch()
        #expect(payloads.count == 2)
        #expect(payloads[0] == payloads[1])
        await restored.stop()
    }

    @Test func ordinaryAttachmentDraftAndSendIdentitySurviveRelaunchWithinOneAccount() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var payloads: [JSONValue] = []
        let request: PathwayAgentThreadModel.Request = { method, payload in
            if method == "assets.persistChatAttachments" { return .object(["attachments": .array([self.attachment])]) }
            payloads.append(payload); throw PathwayRPCError.disconnected
        }
        let first = conversation(directory: directory.appending(path: "account-a"), request: request)
        first.draft = "With context"
        first.draftAttachments = [draftAttachment]
        first.attachmentData = ["draft": Data("context".utf8)]
        await first.send()
        await first.persistDraftNow()
        let restored = conversation(directory: directory.appending(path: "account-a"), request: request)
        await restored.restoreDraft()
        #expect(restored.draft == first.draft)
        #expect(restored.attachmentData["draft"] == Data("context".utf8))
        #expect(restored.draftAttachments.first?.attachment?.id == "pending")
        await restored.send()
        #expect(payloads.count == 2)
        #expect(payloads[0] == payloads[1])
        let otherAccount = conversation(directory: directory.appending(path: "account-b"), request: request)
        await otherAccount.restoreDraft()
        #expect(otherAccount.draft.isEmpty)
        #expect(otherAccount.draftAttachments.isEmpty)
        await first.stop(); await restored.stop(); await otherAccount.stop()
    }

    @Test func restoredInterruptedUploadRequiresExplicitRetryAndLateDiskWriteCannotRestoreRemovedFile() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayConversationDraftStore(directory: directory, key: "thread")
        var draft = draftAttachment
        draft.state = .uploading
        let old = PathwayConversationDraftSnapshot(text: "Draft", attachments: [draft],
            data: [draft.id: Data("context".utf8)], preparedSend: nil, preparedNewSend: nil, revision: 1)
        try await store.save(old)
        let interrupted = try #require(await store.load())
        if case .failed = interrupted.attachments.first?.state {} else { Issue.record("Interrupted upload must require retry") }
        try await store.save(PathwayConversationDraftSnapshot(text: "New", attachments: [], data: [:],
            preparedSend: nil, preparedNewSend: nil, revision: 3))
        try await store.save(old)
        let latest = try #require(await store.load())
        #expect(latest.text == "New")
        #expect(latest.attachments.isEmpty)
        #expect(latest.data.isEmpty)
    }

    @Test func firstMessageUploadsBytesOverHTTPAndLaunchesWithMetadataOnly() async throws {
        var uploads: [Data] = []
        var launches: [JSONValue] = []
        var preparations: [JSONValue] = []
        let model = creation { method, payload in
            if method == "attachments.createUploadUrl" {
                return .object(["attachmentId": .string("uploaded"), "relativeUrl": .string("/api/attachments/uploaded")])
            }
            if method == "assets.persistChatAttachments" {
                preparations.append(payload)
                return .object(["attachments": payload.objectValue?["attachments"] ?? .array([])])
            }
            launches.append(payload)
            return .object(["threadId": payload.objectValue?["threadId"] ?? .null])
        }
        model.attachments.supportsUploads = true
        model.attachments.maximumFileBytes = 1024
        model.attachments.uploadRequest = { path in
            #expect(path == "/api/attachments/uploaded")
            var request = URLRequest(url: URL(string: "https://example.invalid/upload")!)
            request.httpMethod = "PUT"
            return request
        }
        model.attachments.upload = { request, data in
            #expect(request.httpMethod == "PUT")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "text/plain")
            uploads.append(data)
        }
        await model.attachments.add(data: Data("context".utf8), name: "context.txt", mimeType: "text/plain")
        #expect(model.canLaunch)
        #expect(await model.launch() != nil)
        #expect(uploads == [Data("context".utf8)])
        let metadata = try #require(preparations.first?.objectValue?["attachments"]?.arrayValue?.first?.objectValue)
        #expect(metadata["id"] == .string("uploaded"))
        #expect(metadata["dataUrl"] == nil)
        #expect(launches.first?.objectValue?["initialMessage"]?.objectValue?["text"] == .string(""))
        #expect(model.attachments.drafts.isEmpty)
    }

    @Test func firstMessageAttachmentRecoveryPreservesBytesWithoutResubmittingUploads() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var requests = 0
        let first = PathwayNewThreadAttachments(directory: directory, key: "binding")
        first.supportsUploads = true; first.maximumFileBytes = 1024; first.isConnected = true
        first.request = { _, _ in requests += 1; throw PathwayRPCError.disconnected }
        first.uploadRequest = { _ in URLRequest(url: URL(string: "https://example.invalid/upload")!) }
        await first.add(data: Data("context".utf8), name: "context.txt", mimeType: "text/plain")
        #expect(!first.isReady)
        let restored = PathwayNewThreadAttachments(directory: directory, key: "binding")
        restored.request = { _, _ in requests += 1; throw PathwayRPCError.disconnected }
        await restored.restore()
        #expect(requests == 1)
        let draft = try #require(restored.drafts.first)
        #expect(restored.bytes[draft.id] == Data("context".utf8))
        #expect(!restored.isReady)
        await restored.remove(id: draft.id)
        let empty = PathwayNewThreadAttachments(directory: directory, key: "binding")
        await empty.restore()
        #expect(empty.drafts.isEmpty)
    }

    @Test func initialAttachmentCapabilitiesAndSizeLimitsPreventUnsupportedRequests() async {
        let attachments = PathwayNewThreadAttachments(directory: nil, key: "binding")
        var requests = 0
        attachments.request = { _, _ in requests += 1; return .object([:]) }
        await attachments.add(data: Data("context".utf8), name: "context.txt", mimeType: "text/plain")
        #expect(attachments.drafts.isEmpty)
        attachments.supportsUploads = true
        attachments.maximumFileBytes = 3
        await attachments.add(data: Data("context".utf8), name: "context.txt", mimeType: "text/plain")
        #expect(attachments.drafts.isEmpty)
        #expect(requests == 0)
    }

    @Test func capturedPromptIsReviewedAndImportReceiptSurvivesRelaunch() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory.appending(path: "inbox"))
        try await store.setActiveAccount("account-a")
        let capture = try await store.save(prompt: "Shared prompt", files: [], accountKey: "account-a")
        var requests = 0
        let request: PathwayAgentThreadCreationModel.Request = { _, _ in requests += 1; throw PathwayRPCError.disconnected }
        let first = creation(directory: directory.appending(path: "account-a"), request: request)
        first.prompt = "Existing draft"
        #expect(await first.importCapturedDraft(capture, store: store))
        #expect(first.prompt == "Existing draft\n\nShared prompt")
        #expect(requests == 0)
        await first.stop()
        let restored = creation(directory: directory.appending(path: "account-a"), request: request)
        #expect(await restored.importCapturedDraft(capture, store: store))
        #expect(restored.prompt == "Existing draft\n\nShared prompt")
        #expect(requests == 0)
        #expect(try await store.drafts(accountKey: "account-a").count == 1)
        await restored.stop()
    }

    @Test func failedCaptureImportRetainsSourceAndRetryKeepsOneLocalAttachment() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory.appending(path: "inbox"))
        try await store.setActiveAccount("account-a")
        let file = directory.appending(path: "context.txt")
        try Data("context".utf8).write(to: file)
        let capture = try await store.save(prompt: "Review", files: [.init(url: file, name: "context.txt", mimeType: "text/plain")], accountKey: "account-a")
        let model = creation(directory: directory.appending(path: "account-a")) { _, _ in throw PathwayRPCError.disconnected }
        #expect(await !model.importCapturedDraft(capture, store: store))
        #expect(model.prompt.isEmpty)
        #expect(try await store.drafts(accountKey: "account-a").count == 1)
        model.attachments.supportsUploads = true; model.attachments.maximumFileBytes = 1024
        #expect(await model.importCapturedDraft(capture, store: store))
        #expect(model.attachments.drafts.count == 1)
        #expect(!model.canLaunch)
        #expect(await model.importCapturedDraft(capture, store: store))
        #expect(model.attachments.drafts.count == 1)
        #expect(model.prompt == "Review")
        await model.stop()
    }

    @Test func captureCannotBeImportedIntoAnotherAccount() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory.appending(path: "inbox"))
        try await store.setActiveAccount("account-a")
        let capture = try await store.save(prompt: "Private", files: [], accountKey: "account-a")
        let model = creation(directory: directory.appending(path: "account-b")) { _, _ in throw PathwayRPCError.disconnected }
        #expect(await !model.importCapturedDraft(capture, store: store))
        #expect(model.prompt.isEmpty)
        await model.stop()
    }

    private var attachment: JSONValue { .object(["id": .string("pending"), "type": .string("file"),
        "name": .string("context.txt"), "mimeType": .string("text/plain"), "sizeBytes": .number(7)]) }
    private var draftAttachment: PathwayThreadAttachmentDraft {
        PathwayThreadAttachmentDraft(id: "draft", name: "context.txt", mimeType: "text/plain", type: "file", sizeBytes: 7,
            state: .ready, attachment: PathwayMessageAttachment(id: "pending", type: "file", name: "context.txt", mimeType: "text/plain", sizeBytes: 7))
    }
    private var config: JSONValue {
        let model: JSONValue = .object(["slug": .string("model"), "name": .string("Model"), "isDefault": .bool(true)])
        let provider: JSONValue = .object(["instanceId": .string("codex"), "driver": .string("codex"),
            "enabled": .bool(true), "installed": .bool(true), "models": .array([model])])
        return .object(["type": .string("snapshot"), "config": .object([
            "settings": .object(["defaultThreadEnvMode": .string("local"), "newWorktreesStartFromOrigin": .bool(false)]),
            "providers": .array([provider])])])
    }
    private var environment: PathwayCompanyEnvironment {
        PathwayCompanyEnvironment(companyId: "company", environment: PathwayEnvironment(id: "environment", environmentId: "environment",
            descriptor: PathwayEnvironmentDescriptor(environmentId: "environment", label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
    }
    private func creation(directory: URL? = nil, request: @escaping PathwayAgentThreadCreationModel.Request) -> PathwayAgentThreadCreationModel {
        let binding = PathwayCompanyEnvironmentBinding(companyId: "company", binding: PathwayEnvironmentBinding(id: "binding",
            cloudProjectId: "project", environmentId: "environment", localProjectId: "project", localWorkspaceRoot: "/project", status: "active", lastSeenAt: nil))
        let model = PathwayAgentThreadCreationModel(binding: binding, environment: environment, storageDirectory: directory, request: request)
        model.applySubscriptionValue(config)
        return model
    }
    private func conversation(directory: URL? = nil, request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        PathwayAgentThreadModel(thread: makeAgentThread(), environment: environment, request: request, storageDirectory: directory)
    }
    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
}

struct PathwayRPCDeadlineTests {
    @Test func unavailableEndpointCannotKeepARequestPendingPastItsDeadline() async {
        let rpc = PathwayRPCClient { throw PathwayRPCError.disconnected }
        do {
            _ = try await rpc.request("server.getConfig", payload: .object([:]), timeout: .zero)
            Issue.record("Expected a bounded request failure")
        } catch PathwayRPCError.timedOut {} catch { Issue.record("Unexpected error: \(error)") }
        await rpc.stop()
    }

    @Test func staleMutationIsRejectedBeforeConnecting() async {
        let rpc = PathwayRPCClient {
            Issue.record("A stale mutation must not start a connection")
            throw PathwayRPCError.disconnected
        }
        do {
            _ = try await rpc.request("orchestration.dispatchCommand", payload: .object([:]),
                requiresSubscription: true, waitForSubscription: false)
            Issue.record("Expected a disconnected failure")
        } catch PathwayRPCError.disconnected {} catch { Issue.record("Unexpected error: \(error)") }
        await rpc.stop()
    }

    @Test func cancellingAnUnsentRequestFinishesItWithoutWaitingForReconnect() async {
        let rpc = PathwayRPCClient { throw PathwayRPCError.disconnected }
        let request = Task { try await rpc.request("server.getConfig", payload: .object([:])) }
        request.cancel()
        do { _ = try await request.value; Issue.record("Expected cancellation") }
        catch is CancellationError {} catch { Issue.record("Unexpected error: \(error)") }
        await rpc.stop()
    }
}
