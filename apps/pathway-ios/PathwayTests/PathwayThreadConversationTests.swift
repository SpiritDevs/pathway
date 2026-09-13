import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadConversationTests {
    @Test func queuedMessagesStayOutOfTranscriptUntilStarted() {
        let model = makeModel { _, _ in .object([:]) }
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        #expect(model.items.count == 1)
        #expect(model.transcriptItems.isEmpty)
        model.applySubscriptionValue(event(sequence: 2, type: "run.updated", payload: run(status: "running")))
        #expect(model.transcriptItems.count == 1)
        model.applySubscriptionValue(event(sequence: 3, type: "run.updated", payload: run(status: "cancelled")))
        #expect(model.transcriptItems.isEmpty)
    }

    @Test func editingQueuedMessageCancelsThenRestoresTheComposer() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var commands: [[String: JSONValue]] = []
        let model = makeModel(storageDirectory: directory) { method, payload in
            #expect(method == "orchestration.dispatchCommand")
            commands.append(try #require(payload.objectValue))
            return .object([:])
        }
        await model.restoreDraft()
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        try await model.restoreQueuedMessage("run-1")
        #expect(commands.count == 1)
        #expect(commands[0]["type"]?.stringValue == "queued-run.cancel")
        #expect(commands[0]["runId"]?.stringValue == "run-1")
        #expect(model.draft == "Original\n<issue_context>Keep this</issue_context>")
        model.applySubscriptionValue(event(sequence: 2, type: "run.updated", payload: run(status: "cancelled")))
        model.draft = "Edited\n<issue_context>Keep this</issue_context>"
        await model.send()
        #expect(commands.last?["type"]?.stringValue == "message.dispatch")
        #expect(commands.last?["text"]?.stringValue == "Edited\n<issue_context>Keep this</issue_context>")
        #expect(model.draft.isEmpty)
    }

    @Test func rejectedQueueCancellationPreservesTheSavedEditAndBlocksSending() async {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = makeModel(storageDirectory: directory) { _, _ in throw PathwayRPCError.remote("The run has already started.") }
        await model.restoreDraft()
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        do {
            try await model.restoreQueuedMessage("run-1")
            Issue.record("A rejected cancellation must not restore a second copy to send.")
        } catch {}
        #expect(model.draft == "Original\n<issue_context>Keep this</issue_context>")
        #expect(model.pendingQueuedEditRunID == "run-1")
        #expect(!model.canSend)
        #expect(model.queuedRuns.count == 1)
    }

    @Test func queueEditingDoesNotReplaceAnExistingDraft() async {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var calls = 0
        let model = makeModel(storageDirectory: directory) { _, _ in calls += 1; return .object([:]) }
        await model.restoreDraft()
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        model.draft = "Keep my unsent draft"
        do {
            try await model.restoreQueuedMessage("run-1")
            Issue.record("Editing must preserve an existing draft.")
        } catch {}
        #expect(calls == 0)
        #expect(model.draft == "Keep my unsent draft")
    }

    @Test func queueEditingPreservesDraftChangesDuringCancellation() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var updateDraft: (() -> Void)?
        let model = makeModel(storageDirectory: directory) { _, _ in updateDraft?(); return .object([:]) }
        await model.restoreDraft()
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        updateDraft = { model.draft = "New text" }
        try await model.restoreQueuedMessage("run-1")
        #expect(model.draft == "New text")
    }

    @Test func reorderUsesTheMovedRunAndItsNewSuccessor() async throws {
        var command: [String: JSONValue] = [:]
        let model = makeModel { _, payload in command = payload.objectValue ?? [:]; return .object([:]) }
        model.installSnapshot(snapshot(status: "queued"), sequence: 1)
        try await model.reorderQueuedRun("run-1", beforeRunID: "run-2")
        #expect(command["type"]?.stringValue == "queued-run.reorder")
        #expect(command["runId"]?.stringValue == "run-1")
        #expect(command["beforeRunId"]?.stringValue == "run-2")
        try await model.reorderQueuedRun("run-1", beforeRunID: nil)
        #expect(command["beforeRunId"] == .null)
    }

    @Test(arguments: ["preparing", "starting", "running", "waiting", "queued", "completed", "failed", "interrupted", "cancelled"])
    func interruptionMatchesActiveRunStatus(status: String) async throws {
        var commands: [[String: JSONValue]] = []
        let model = makeModel { _, payload in
            commands.append(try #require(payload.objectValue))
            return .object([:])
        }
        model.installSnapshot(snapshot(status: status), sequence: 1)
        let expected = ["preparing", "starting", "running"].contains(status)
        #expect(model.canInterrupt == expected)
        try await model.interrupt()
        #expect(commands.count == (expected ? 1 : 0))
        if expected {
            #expect(commands.first?["type"]?.stringValue == "run.interrupt")
            #expect(commands.first?["runId"]?.stringValue == "run-1")
        }
    }

    @Test func interruptionWaitsForResynchronization() async throws {
        var calls = 0
        let model = makeModel { _, _ in calls += 1; return .object([:]) }
        model.installSnapshot(snapshot(status: "running"), sequence: 1)
        #expect(model.canInterrupt)
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        #expect(!model.canInterrupt)
        try await model.interrupt()
        #expect(calls == 0)
        model.installSnapshot(snapshot(status: "waiting"), sequence: 2)
        model.applySubscriptionValue(.object(["kind": .string("synchronized")]))
        #expect(!model.canInterrupt)
    }

    @Test func activityFollowsLiveRunEventsAndReconnects() {
        let model = makeModel { _, _ in .object([:]) }
        model.installSnapshot(snapshot(status: "starting"), sequence: 1)
        #expect(model.activity == .starting)
        model.applySubscriptionValue(event(sequence: 2, type: "run.updated", payload: run(status: "running")))
        #expect(model.activity == .working)
        model.applySubscriptionValue(.object(["_pathwayTransport": .string("disconnected")]))
        #expect(model.activity == nil)
        model.installSnapshot(snapshot(status: "completed"), sequence: 3)
        model.applySubscriptionValue(.object(["kind": .string("synchronized")]))
        #expect(model.activity == nil)
        model.applySubscriptionValue(event(sequence: 4, type: "run.updated", payload: run(status: "running")))
        #expect(model.activity == .working)
        model.applySubscriptionValue(event(sequence: 5, type: "run.updated", payload: run(status: "interrupted")))
        #expect(model.activity == nil)
    }

    @Test func activeWorkTakesPrecedenceOverQueuedFollowups() {
        let model = makeModel { _, _ in .object([:]) }
        model.installSnapshot(snapshot(status: "running"), sequence: 1)
        model.applySubscriptionValue(event(sequence: 2, type: "run.created", payload: .object([
            "id": .string("run-2"), "ordinal": .number(2), "status": .string("queued")
        ])))
        #expect(model.activity == .working)
        model.applySubscriptionValue(event(sequence: 3, type: "run.updated", payload: run(status: "completed")))
        #expect(model.activity == .queued)
        model.applySubscriptionValue(event(sequence: 4, type: "run.updated", payload: .object([
            "id": .string("run-2"), "ordinal": .number(2), "status": .string("cancelled")
        ])))
        #expect(model.activity == nil)
    }

    @Test func captureMetadataSurvivesNativeDecodeCacheAndResend() throws {
        let source: JSONValue = .object([
            "kind": .string("snap-shot"), "appName": .string("Editor"),
            "windowTitle": .string("main.swift"), "capturedAt": .string("2026-09-09T03:00:00.000Z"),
            "accessibility": .object(["format": .string("flat-text"), "text": .string("let answer = 42"), "truncated": .bool(false)])
        ])
        let raw: JSONValue = .object([
            "id": .string("capture-1"), "type": .string("image"), "name": .string("editor.png"),
            "mimeType": .string("image/png"), "sizeBytes": .number(4), "source": source
        ])
        let attachment = try #require(PathwayTimelineItem.attachment(raw))
        #expect(attachment.snapShotSource?["appName"]?.stringValue == "Editor")
        let restored = try JSONDecoder().decode(PathwayMessageAttachment.self, from: JSONEncoder().encode(attachment))
        #expect(restored.json == raw)
        let older = PathwayMessageAttachment(id: "old", type: "image", name: "old.png", mimeType: "image/png", sizeBytes: 1)
        #expect(older.snapShotSource == nil)
        #expect(older.json.objectValue?["source"] == nil)
    }

    @Test(arguments: ["preparing", "starting", "running", "waiting", "completed", "failed"])
    func browserTakeoverMatchesTheServerRunEligibility(status: String) {
        let thread = makeModel { _, _ in .object([:]) }
        thread.installSnapshot(snapshot(status: status), sequence: 1)
        let browser = PathwayRemoteBrowserModel(thread: thread)
        #expect(browser.canTakeControl == ["preparing", "starting", "running"].contains(status))
        if status == "waiting" { #expect(thread.activeRunID != nil) }
    }

    @Test func failedBrowserTabLoadOffersReconnectAndRetryCanRecover() async {
        let thread = makeModel { _, _ in .object([:]) }
        @MainActor final class BrowserResponseState { var failList = true }
        let responseState = BrowserResponseState()
        let browser = PathwayRemoteBrowserModel(thread: thread, request: { _, payload in
            if payload.objectValue?["action"]?.stringValue == "list", responseState.failList {
                throw PathwayRPCError.remote("Browser is unavailable")
            }
            return .object(["tabs": .array([]), "selectedTabId": .null])
        })
        await browser.start()
        #expect(!browser.isHostReady)
        #expect(browser.error == "Browser is unavailable")
        #expect(!(await browser.command("open")))
        responseState.failList = false
        await browser.start()
        #expect(browser.isHostReady)
        #expect(browser.error == nil)
        await browser.stop()
    }

    @Test func environmentBrowserWaitsForHostSelectionBeforeLoadingTabs() async throws {
        let thread = makeModel { _, _ in .object([:]) }
        let started = AsyncStream<Void>.makeStream()
        var release: CheckedContinuation<JSONValue, Error>?
        var actions: [String] = []
        let response: JSONValue = .object(["tabs": .array([]), "selectedTabId": .null])
        let browser = PathwayRemoteBrowserModel(thread: thread, request: { method, payload in
            #expect(method == "preview.remote.command")
            let fields = try #require(payload.objectValue)
            let action = try #require(fields["action"]?.stringValue)
            actions.append(action)
            if action == "selectHost" {
                #expect(fields["host"]?.stringValue == "environment")
                #expect(fields["tabId"] == nil)
                started.continuation.yield()
                return try await withCheckedThrowingContinuation { release = $0 }
            }
            return response
        })
        let start = Task { await browser.start() }
        var iterator = started.stream.makeAsyncIterator()
        await iterator.next()
        #expect(!browser.isHostReady)
        #expect(!(await browser.command("open")))
        release?.resume(returning: response)
        await start.value
        #expect(browser.isHostReady)
        #expect(actions == ["selectHost", "list"])
        started.continuation.finish()
        await browser.stop()
    }

    @Test func refusedEnvironmentBrowserHostRemainsUnavailableWithoutAutomaticRetry() async {
        let thread = makeModel { _, _ in .object([:]) }
        var calls = 0
        let browser = PathwayRemoteBrowserModel(thread: thread, request: { _, _ in
            calls += 1
            throw PathwayRPCError.remote("Release browser takeover before switching browsers.")
        })
        await browser.start()
        #expect(!browser.isHostReady)
        #expect(browser.error == "Release browser takeover before switching browsers.")
        #expect(!(await browser.command("open")))
        #expect(calls == 1)
        await browser.stop()
    }

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

    @Test func questionDismissalRequiresCapabilityAndCancelsStaleRequest() async throws {
        var calls: [JSONValue] = []
        let model = makeModel { _, value in calls.append(value); return .object([:]) }
        let question: JSONValue = .object([
            "id": .string("question-item"), "type": .string("user_input_request"),
            "status": .string("completed"), "requestId": .string("request-1")
        ])
        let runtime: JSONValue = .object([
            "id": .string("request-1"), "status": .string("pending"), "isBlocking": .bool(false),
            "responseCapability": .object(["type": .string("not_resumable"), "reason": .string("Previous session")])
        ])
        model.installSnapshot(.object(["visibleTurnItems": .array([.object(["item": question])]), "runtimeRequests": .array([runtime])]))
        let item = try #require(model.items.first)
        #expect(model.pendingAsyncQuestions == [item])
        #expect(!model.supportsUserInputDismissal)
        #expect(!model.canDismissQuestion(item))
        #expect(!model.canRespond(to: item))

        model.serverConfig = ["environment": .object(["capabilities": .object(["userInputDismissal": .bool(false)])])]
        #expect(!model.supportsUserInputDismissal)
        #expect(!model.canDismissQuestion(item))

        model.serverConfig = ["environment": .object(["capabilities": .object(["userInputDismissal": .bool(true)])])]
        #expect(model.supportsUserInputDismissal)
        #expect(model.canDismissQuestion(item))
        try await model.dismissQuestion(requestID: "request-1")
        #expect(calls.last?.objectValue?["decision"] == .string("cancel"))
        #expect(calls.last?.objectValue?["answers"] == nil)
    }

    @Test func asyncQuestionsRemainActionableAfterCompletionAndKeepDraftOnReconnect() async throws {
        var calls: [JSONValue] = []
        let model = makeModel { _, value in calls.append(value); return .object([:]) }
        let question: JSONValue = .object([
            "id": .string("async-item"), "type": .string("user_input_request"),
            "status": .string("waiting"), "requestId": .string("async-request"),
            "questions": .array([.object([
                "id": .string("q1"), "header": .string("Approach"), "question": .string("Which approach?"),
                "options": .array([.object(["label": .string("First"), "description": .string("")])])])])
        ])
        let runtime: JSONValue = .object([
            "id": .string("async-request"), "status": .string("pending"), "isBlocking": .bool(false),
            "responseCapability": .object(["type": .string("message"), "providerThreadId": .string("provider-thread")])
        ])
        let projection: JSONValue = .object([
            "runs": .array([run(status: "completed")]),
            "visibleTurnItems": .array([.object(["item": question])]), "runtimeRequests": .array([runtime])
        ])
        model.installSnapshot(projection)
        let item = try #require(model.pendingAsyncQuestions.first)
        #expect(model.activeRunID == nil)
        #expect(model.canRespond(to: item))
        model.prepareQuestionDraft(for: item)
        #expect(model.questionDrafts[item.id]?.selected["q1"] == ["First"])
        #expect(calls.isEmpty)
        model.questionDrafts[item.id]?.custom["q1"] = "My answer"
        model.installSnapshot(projection)
        model.prepareQuestionDraft(for: item)
        #expect(model.questionDrafts[item.id]?.custom["q1"] == "My answer")
        try await model.respondToQuestions(requestID: "async-request", answers: ["q1": .string("My answer")])
        #expect(calls.last?.objectValue?["answers"] == .object(["q1": .string("My answer")]))
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

    @Test(arguments: ["retry", "work_locally"])
    func failedWorkspaceRecoveryTargetsTheFailedRun(action: String) async throws {
        var sent: [String: JSONValue]?
        let model = makeModel { method, payload in
            #expect(method == "orchestration.controlWorkspacePreparation")
            sent = payload.objectValue
            return .object([:])
        }
        model.installSnapshot(snapshot(status: "failed"), sequence: 1)
        let item = try #require(PathwayTimelineItem(json: .object([
            "id": .string("workspace"), "type": .string("command_execution"),
            "threadId": .string(model.threadID), "runId": .string("run-1"), "status": .string("failed"),
            "workspacePreparation": .object(["workspaceKind": .string("worktree"), "phase": .string("worktree")])
        ])))
        #expect(model.activeRunID == nil)
        #expect(model.canRecoverWorkspacePreparation(item))
        try await model.controlWorkspacePreparation(action: action, runID: item.runID)
        #expect(sent?["runId"]?.stringValue == "run-1")
        #expect(sent?["action"]?.stringValue == action)
        model.installSnapshot(snapshot(status: "starting"), sequence: 2)
        #expect(!model.canRecoverWorkspacePreparation(item))
    }

    private func makeModel(storageDirectory: URL? = nil, request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: thread, environment: environment, request: request, storageDirectory: storageDirectory)
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
