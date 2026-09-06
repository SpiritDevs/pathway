import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadConversationTests {
    @Test func streamingUpdatesPreserveOrderingAndReorderedItemsMove() throws {
        let model = makeModel { _, _ in .object([:]) }
        func item(_ id: String, _ ordinal: Int, _ text: String) -> JSONValue {
            .object(["id": .string(id), "ordinal": .number(Double(ordinal)), "type": .string("assistant_message"), "text": .string(text)])
        }
        for (index, value) in [item("b", 2, "second"), item("a", 1, "first"), item("c", 2, "third"), item("b", 2, "streamed")].enumerated() {
            model.applySubscriptionValue(event(sequence: index + 1, type: "turn-item.updated", payload: value))
        }
        #expect(model.items.map(\.id) == ["a", "b", "c"])
        #expect(model.items[1].text == "streamed")
        model.applySubscriptionValue(event(sequence: 5, type: "turn-item.updated", payload: item("a", 3, "moved")))
        #expect(model.items.map(\.id) == ["b", "c", "a"])
    }

    @Test func conversationCacheRejectsOversizedSnapshotsAndBoundsTotalBytes() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = PathwayThreadCache(directory: directory, maximumFileBytes: 2_048, maximumTotalBytes: 1_800)
        let item = try #require(PathwayTimelineItem(json: .object(["id": .string("item"), "ordinal": .number(1), "type": .string("assistant_message"), "text": .string(String(repeating: "a", count: 400))])))
        await cache.save(items: [item], threadID: "first", revision: 1)
        #expect(await cache.load(threadID: "first") != nil)
        await cache.save(items: [item], threadID: "second", revision: 2)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
        let bytes = try files.reduce(0) { try $0 + ($1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
        #expect(bytes <= 1_800)
        let oversized = try #require(PathwayTimelineItem(json: .object(["id": .string("item"), "ordinal": .number(1), "type": .string("assistant_message"), "text": .string(String(repeating: "b", count: 2_000))])))
        await cache.save(items: [oversized], threadID: "second", revision: 3)
        #expect(await cache.load(threadID: "second") == nil)
    }

    @Test func modelCatalogKeepsUnconfiguredProvidersWithoutMakingThemSelectable() {
        let model = makeModel { _, _ in .object([:]) }
        func provider(_ id: String, installed: Bool, auth: String = "authenticated") -> JSONValue {
            .object(["instanceId": .string(id), "driver": .string("codex"), "enabled": .bool(true),
                     "installed": .bool(installed), "auth": .object(["status": .string(auth)]),
                     "models": .array([.object(["slug": .string("model"), "name": .string("Model")])])])
        }
        model.installServerConfig(.object(["providers": .array([
            provider("ready", installed: true), provider("missing", installed: false),
            provider("signed-out", installed: true, auth: "unauthenticated")
        ])]))
        #expect(model.modelCatalog.map(\.id) == ["ready", "missing", "signed-out"])
        #expect(model.providers.map(\.id) == ["ready"])
        #expect(model.modelCatalog[1].unavailableReason == "Not installed")
        #expect(model.modelCatalog[2].unavailableReason == "Sign in required")
    }

    @Test func liveRunOverridesStaleShellAndSteeringTargetsIt() async throws {
        var calls: [(String, JSONValue)] = []
        let model = makeModel { calls.append(($0, $1)); return .object(["sequence": .number(1)]) }
        model.installSnapshot(snapshot(status: "running"), sequence: 2)
        #expect(model.activeRunID == "run-1")
        model.draft = "Steer this"
        await model.send(mode: "steer")
        let payload = try #require(calls.last?.1.objectValue)
        #expect(payload["dispatchMode"] == .object(["type": .string("steer_active"), "targetRunId": .string("run-1")]))
        model.applySubscriptionValue(event(sequence: 3, type: "run.updated", payload: run(status: "completed")))
        #expect(model.activeRunID == nil)
        model.applySubscriptionValue(event(sequence: 2, type: "run.updated", payload: run(status: "running")))
        #expect(model.activeRunID == nil)
    }

    @Test func editEligibilityAndHiddenContextArePreserved() async throws {
        var calls: [JSONValue] = []
        let model = makeModel { _, value in calls.append(value); return .object([:]) }
        model.installSnapshot(snapshot(status: "interrupted"))
        let item = try #require(model.items.first)
        #expect(model.canEdit(item))
        try await model.editLatestUserMessage(item, text: "Updated")
        #expect(calls.last?.objectValue?["text"]?.stringValue == "Updated\n<issue_context>Keep this</issue_context>")
        #expect(calls.last?.objectValue?["messageId"]?.stringValue == "message-1")
        #expect(calls.last?.objectValue?["replacementMessageId"]?.stringValue != "message-1")
        var changed = snapshot(status: "interrupted").objectValue!
        changed["checkpoints"] = .array([.object(["id": .string("changed"), "status": .string("ready"), "appRunOrdinal": .number(1), "files": .array([.object(["path": .string("app.swift")])])])])
        model.installSnapshot(.object(changed))
        #expect(!model.canEdit(item))
    }

    @Test func questionsUseLiveCapabilityAndSendAllAnswersTogether() async throws {
        var calls: [JSONValue] = []
        let model = makeModel { _, value in calls.append(value); return .object([:]) }
        let question: JSONValue = .object(["id": .string("question-item"), "type": .string("user_input_request"), "status": .string("waiting"), "requestId": .string("request-1")])
        let runtime: JSONValue = .object(["id": .string("request-1"), "status": .string("pending"), "responseCapability": .object(["type": .string("live"), "providerSessionId": .string("session-1")])])
        model.installSnapshot(.object(["visibleTurnItems": .array([.object(["item": question])]), "runtimeRequests": .array([runtime])]))
        let item = try #require(model.items.first)
        #expect(model.canRespond(to: item))
        let answers: [String: JSONValue] = ["q1": .string("custom"), "q2": .array([.string("A"), .string("B")])]
        try await model.respondToQuestions(requestID: "request-1", answers: answers)
        #expect(calls.last?.objectValue?["answers"] == .object(answers))
        model.applySubscriptionValue(event(sequence: 1, type: "runtime-request.updated", payload: .object(["id": .string("request-1"), "status": .string("resolved"), "responseCapability": .object(["type": .string("live")])])))
        #expect(!model.canRespond(to: item))
    }

    @Test func failedSendRetainsDraftAndPreparedAttachmentsForRetry() async throws {
        var persistenceCalls = 0
        var dispatchCalls = 0
        var messageIDs: [JSONValue] = []
        let model = makeModel { method, value in
            if method == "assets.persistChatAttachments" {
                persistenceCalls += 1
                return .object(["attachments": .array([self.attachment(id: "persisted")])])
            }
            dispatchCalls += 1
            messageIDs.append(value.objectValue?["messageId"] ?? .null)
            if dispatchCalls == 1 { throw PathwayThreadConversationError.message("Offline") }
            return .object([:])
        }
        model.draft = "Keep my draft"
        model.draftAttachments = [PathwayThreadAttachmentDraft(id: "draft-1", name: "a.txt", mimeType: "text/plain", type: "file", sizeBytes: 1, state: .ready,
            attachment: PathwayMessageAttachment(id: "pending-1", type: "file", name: "a.txt", mimeType: "text/plain", sizeBytes: 1))]
        await model.send()
        #expect(model.draft == "Keep my draft")
        #expect(model.draftAttachments.count == 1)
        await model.send()
        #expect(model.draft.isEmpty)
        #expect(model.draftAttachments.isEmpty)
        #expect(persistenceCalls == 1)
        #expect(messageIDs.count == 2 && messageIDs[0] == messageIDs[1])
    }

    @Test func newThreadUsesAttachmentMetadataAndRetriesSameTarget() async throws {
        var persistenceCalls = 0
        var launchCalls: [JSONValue] = []
        let model = makeModel { method, value in
            if method == "assets.persistChatAttachments" {
                persistenceCalls += 1
                let attachment = try #require(value.objectValue?["attachments"]?.arrayValue?.first?.objectValue)
                #expect(attachment["dataUrl"] == nil)
                #expect(attachment["id"]?.stringValue == "pending-1")
                return .object(["attachments": .array([self.attachment(id: "persisted")])])
            }
            launchCalls.append(value)
            if launchCalls.count == 1 { throw PathwayThreadConversationError.message("Offline") }
            return .object([:])
        }
        model.draft = "New task"
        model.draftAttachments = [PathwayThreadAttachmentDraft(id: "draft-1", name: "a.txt", mimeType: "text/plain", type: "file", sizeBytes: 1, state: .ready,
            attachment: PathwayMessageAttachment(id: "pending-1", type: "file", name: "a.txt", mimeType: "text/plain", sizeBytes: 1))]
        do { _ = try await model.startDraftInNewThread(sideChat: false); Issue.record("Expected failure") } catch {}
        #expect(model.draft == "New task")
        _ = try await model.startDraftInNewThread(sideChat: false)
        #expect(persistenceCalls == 1)
        #expect(launchCalls[0].objectValue?["threadId"] == launchCalls[1].objectValue?["threadId"])
        #expect(launchCalls[0].objectValue?["commandId"] == launchCalls[1].objectValue?["commandId"])
        #expect(model.draft.isEmpty)
    }

    @Test func plainTextRetryReusesCommandAndMessageUntilDraftChanges() async throws {
        var calls: [JSONValue] = []
        let model = makeModel { _, payload in calls.append(payload); throw PathwayThreadConversationError.message("Disconnected") }
        model.draft = "First"
        await model.send()
        await model.send()
        #expect(calls.count == 2)
        #expect(calls[0] == calls[1])
        model.draft = "Changed"
        await model.send()
        #expect(calls[2].objectValue?["commandId"] != calls[1].objectValue?["commandId"])
        #expect(calls[2].objectValue?["messageId"] != calls[1].objectValue?["messageId"])
        #expect(calls[2].objectValue?["text"]?.stringValue == "Changed")
    }

    @Test func cacheRejectsLateWritesAndStopFlushesLatestSnapshot() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = PathwayThreadCache(directory: directory)
        let thread = makeAgentThread()
        let base = makeModel { _, _ in .object([:]) }
        let model = PathwayAgentThreadModel(thread: thread, environment: base.environment, request: { _, _ in .object([:]) }, persistsLocalState: true, cache: cache)
        model.installSnapshot(snapshot(status: "completed"))
        var updated = try #require(model.items.first?.fields)
        updated["text"] = .string("Latest streamed text")
        model.applySubscriptionValue(event(sequence: 1, type: "turn-item.updated", payload: .object(updated)))
        await model.stop()
        let saved = await cache.load(threadID: thread.id)
        #expect(saved?.first?.text == "Latest streamed text")
        await cache.save(items: [], threadID: thread.id, revision: 0)
        let afterStaleWrite = await cache.load(threadID: thread.id)
        #expect(afterStaleWrite?.first?.text == "Latest streamed text")
        // A restart can stage a newer snapshot without an old delayed task overwriting it.
        updated["text"] = .string("After restart")
        model.applySubscriptionValue(event(sequence: 2, type: "turn-item.updated", payload: .object(updated)))
        await model.stop()
        let restarted = await cache.load(threadID: thread.id)
        #expect(restarted?.first?.text == "After restart")
    }

    @Test func runningMessageCanPrepareEditButCannotSubmitBeforeStop() throws {
        let model = makeModel { _, _ in .object([:]) }
        var projection = try #require(snapshot(status: "running").objectValue)
        var activeRun = try #require(run(status: "running").objectValue)
        activeRun["providerThreadId"] = .string("provider-thread")
        projection["runs"] = .array([.object(activeRun)])
        projection["providerThreads"] = .array([.object(["id": .string("provider-thread"), "providerSessionId": .string("session")])])
        projection["providerSessions"] = .array([.object(["id": .string("session"), "capabilities": .object(["checkpointing": .object(["providerCanRollbackConversation": .bool(true)])])])])
        projection["checkpointScopes"] = .array([.object(["id": .string("scope"), "runId": .string("run-1"), "kind": .string("root_run")])])
        projection["checkpoints"] = .array([.object(["id": .string("baseline"), "scopeId": .string("scope"), "status": .string("ready"), "ordinalWithinScope": .number(0), "appRunOrdinal": .null, "files": .array([])])])
        model.installSnapshot(.object(projection))
        let item = try #require(model.items.first)
        #expect(model.canPrepareEdit(item))
        #expect(!model.canEdit(item))
        activeRun["status"] = .string("interrupted")
        model.applySubscriptionValue(event(sequence: 1, type: "run.updated", payload: .object(activeRun)))
        #expect(model.canEdit(item))
    }

    @Test func oldCacheDecodesAndRawToolFieldsSurviveNewCache() throws {
        let item = try #require(PathwayTimelineItem(json: .object(["id": .string("tool"), "type": .string("command"), "runId": .string("run-1"), "output": .string("hello"), "input": .string("ls"), "diffStr": .string("diff") ])))
        let data = try JSONEncoder().encode(item)
        let restored = try JSONDecoder().decode(PathwayTimelineItem.self, from: data)
        #expect(restored.fields["diffStr"]?.stringValue == "diff")
        var legacy = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        legacy.removeValue(forKey: "rawFields")
        let old = try JSONDecoder().decode(PathwayTimelineItem.self, from: JSONSerialization.data(withJSONObject: legacy))
        #expect(old.runID == nil)
        #expect(old.id == "tool")
    }

    @Test func threadMetadataDoesNotClearActiveRunAndRollbackRemovesItems() {
        let model = makeModel { _, _ in .object([:]) }
        model.installSnapshot(snapshot(status: "running"))
        model.applySubscriptionValue(event(sequence: 1, type: "thread.metadata-updated", payload: .object(["id": .string("thread-1"), "title": .string("Renamed")])))
        #expect(model.activeRunID == "run-1")
        model.applySubscriptionValue(event(sequence: 2, type: "run.updated", payload: run(status: "rolled_back")))
        #expect(model.items.isEmpty)
        #expect(model.activeRunID == nil)
    }

    @Test func childFactoryDecodesActualAppThreadWithoutShellFields() async throws {
        var raw = try #require(try PathwayAgentThreadModel.json(makeAgentThread().shell).objectValue)
        for key in ["status", "itemCount", "visibleItemCount", "hasActionableProposedPlan"] { raw.removeValue(forKey: key) }
        raw["id"] = .string("child-1")
        let projection: JSONValue = .object(["thread": .object(raw), "runs": .array([]), "visibleTurnItems": .array([])])
        let model = makeModel { method, payload in
            #expect(method == "orchestration.getThreadProjection")
            #expect(payload.objectValue?["threadId"]?.stringValue == "child-1")
            return projection
        }
        let child = try await model.makeChildModel(threadID: "child-1")
        #expect(child.threadID == "child-1")
        #expect(child.threadTitle == "Thread")
    }

    @Test func directChildRosterUsesExactIdentityAndPreservesLaterSelection() throws {
        let model = makeModel { _, _ in .object([:]) }
        let parentSelection = try PathwayAgentThreadModel.json(model.currentModelSelection)
        func parent(childID: String) -> JSONValue {
            .object(["thread": .object(["modelSelection": parentSelection]), "subagents": .array([.object([
                "id": .string("agent"), "childThreadId": .string(childID), "origin": .string("provider_native"), "model": .string("child-model")])])])
        }
        model.installParentProjection(parent(childID: "different-child"))
        #expect(!model.isConfigurationLocked)
        model.installParentProjection(parent(childID: model.threadID))
        #expect(model.isConfigurationLocked)
        #expect(model.currentModelSelection.model == "child-model")
        model.currentModelSelection = PathwayModelSelection(instanceId: "codex-work", model: "later-choice", options: nil)
        model.installParentProjection(parent(childID: model.threadID))
        #expect(model.currentModelSelection.model == "later-choice")
    }

    @Test func failedOrUploadingAttachmentsBlockSending() {
        let model = makeModel { _, _ in .object([:]) }
        model.draft = "Hello"
        model.draftAttachments = [PathwayThreadAttachmentDraft(id: "a", name: "a", mimeType: "text/plain", type: "file", sizeBytes: 1, state: .uploading)]
        #expect(!model.canSend)
        model.draftAttachments[0].state = .failed("Offline")
        #expect(!model.canSend)
    }

    private func makeModel(request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: thread, environment: environment, request: request)
    }
    private func snapshot(status: String) -> JSONValue {
        .object(["thread": .object(["id": .string("thread-1")]), "runs": .array([run(status: status)]), "visibleTurnItems": .array([.object(["item": .object([
            "id": .string("item-1"), "type": .string("user_message"), "createdBy": .string("user"), "messageId": .string("message-1"), "runId": .string("run-1"), "text": .string("Original\n<issue_context>Keep this</issue_context>")])])])])
    }
    private func run(status: String) -> JSONValue {
        .object(["id": .string("run-1"), "ordinal": .number(1), "status": .string(status), "userMessageId": .string("message-1"), "modelSelection": .object(["instanceId": .string("codex-work"), "model": .string("gpt-5.6-sol")])])
    }
    private func event(sequence: Int, type: String, payload: JSONValue) -> JSONValue {
        .object(["kind": .string("event"), "sequence": .number(Double(sequence)), "event": .object(["type": .string(type), "payload": payload])])
    }
    private func attachment(id: String) -> JSONValue { .object(["id": .string(id), "type": .string("file"), "name": .string("a.txt"), "mimeType": .string("text/plain"), "sizeBytes": .number(1)]) }
}
