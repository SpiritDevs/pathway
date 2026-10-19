import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayConversationDraftRecoveryTests {
    @Test func concurrentMigrationCannotReplaceTheFirstPublishedDraft() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = conversationStore(directory)
        let second = conversationStore(directory)
        async let firstWon = first.migrateLegacyText("First")
        async let secondWon = second.migrateLegacyText("Second")
        let winners = try await (firstWon, secondWon)
        #expect(winners.0 != winners.1)
        let saved = try #require(await first.load())
        #expect(saved.text == (winners.0 ? "First" : "Second"))
    }

    @Test func legacyTextMovesIntoAccountStoreOnlyAfterSuccessfulPublication() async throws {
        let directory = temporaryDirectory()
        let suite = UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let thread = makeAgentThread()
        let key = "pathway.agent-thread.draft.\(thread.id)"
        defaults.set("Unsent legacy text", forKey: key)
        let first = model(directory: directory)
        await first.restoreDraft(legacyDefaults: defaults)
        #expect(first.draft == "Unsent legacy text")
        #expect(defaults.string(forKey: key) == nil)
        let restored = model(directory: directory)
        await restored.restoreDraft(legacyDefaults: defaults)
        #expect(restored.draft == "Unsent legacy text")
        await first.stop(); await restored.stop()
    }

    @Test func existingAccountDraftIncludingEmptyDraftWinsAndKeepsLegacyCopy() async throws {
        for newerText in ["Newer account draft", ""] {
            let directory = temporaryDirectory()
            let suite = UUID().uuidString
            let defaults = try #require(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
            let key = "pathway.agent-thread.draft.\(makeAgentThread().id)"
            defaults.set("Older legacy text", forKey: key)
            let store = conversationStore(directory)
            try await store.save(snapshot(text: newerText))
            let restored = model(directory: directory)
            await restored.restoreDraft(legacyDefaults: defaults)
            #expect(restored.draft == newerText)
            #expect(defaults.string(forKey: key) == "Older legacy text")
            await restored.stop()
        }
    }

    @Test func failedMigrationPreservesUserDefaultsAndCanRecoverOnNextOpen() async throws {
        let directory = temporaryDirectory()
        let suite = UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let key = "pathway.agent-thread.draft.\(makeAgentThread().id)"
        defaults.set("Recover after disk failure", forKey: key)
        // A regular file blocks creating the account directory, without permissions assumptions.
        try Data("blocked".utf8).write(to: directory)
        let blocked = model(directory: directory)
        await blocked.restoreDraft(legacyDefaults: defaults)
        #expect(defaults.string(forKey: key) == "Recover after disk failure")
        #expect(blocked.actionError != nil)
        await blocked.stop()
        try FileManager.default.removeItem(at: directory)
        let recovered = model(directory: directory)
        await recovered.restoreDraft(legacyDefaults: defaults)
        #expect(recovered.draft == "Recover after disk failure")
        #expect(defaults.string(forKey: key) == nil)
        await recovered.stop()
    }

    @Test func inMemoryEditsAndUnscopedModelsDoNotConsumeLegacyDraft() async throws {
        let directory = temporaryDirectory()
        let suite = UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let key = "pathway.agent-thread.draft.\(makeAgentThread().id)"
        defaults.set("Legacy text", forKey: key)
        let edited = model(directory: directory)
        edited.draft = "Already typing"
        await edited.restoreDraft(legacyDefaults: defaults)
        #expect(edited.draft == "Already typing")
        #expect(defaults.string(forKey: key) == "Legacy text")
        let unscoped = model(directory: nil)
        await unscoped.restoreDraft(legacyDefaults: defaults)
        #expect(unscoped.draft.isEmpty)
        #expect(defaults.string(forKey: key) == "Legacy text")
        await edited.stop(); await unscoped.stop()
    }

    @Test func readyUploadExpiresAfter24HoursWithoutLosingBytesAndTextEditsDoNotRenewIt() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        let uploaded = Date(timeIntervalSince1970: 1_000_000)
        try await store.save(snapshot(attachments: [attachment]), now: uploaded)
        try await store.save(snapshot(text: "Edited later", attachments: [attachment], revision: 2),
                             now: uploaded.addingTimeInterval(23 * 60 * 60))
        let fresh = try #require(await store.load(now: uploaded.addingTimeInterval(24 * 60 * 60 - 1), expirePendingUploads: true))
        #expect(fresh.attachments.first?.state == .ready)
        let expired = try #require(await store.load(now: uploaded.addingTimeInterval(24 * 60 * 60), expirePendingUploads: true))
        if case .failed = expired.attachments.first?.state {} else { Issue.record("Expired upload must require retry") }
        #expect(expired.text == "Edited later")
        #expect(expired.data["draft"] == Data("context".utf8))
        #expect(expired.attachments.first?.attachment?.id == "pending-upload")
        // A successful explicit re-upload issues a new remote ID and renews only that upload.
        var retried = attachment
        retried.attachment = remoteAttachment("pending-reuploaded")
        try await store.save(snapshot(attachments: [retried], revision: 3), now: uploaded.addingTimeInterval(25 * 60 * 60))
        let renewed = try #require(await store.load(now: uploaded.addingTimeInterval(26 * 60 * 60), expirePendingUploads: true))
        #expect(renewed.attachments.first?.state == .ready)
    }

    @Test func legacyManifestWithoutUploadDatesRequiresRetryAndRetainsImageBytes() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        var image = attachment
        image = PathwayThreadAttachmentDraft(id: image.id, name: "image.png", mimeType: "image/png", type: "image", sizeBytes: 7,
            state: .ready, attachment: image.attachment)
        try await store.save(snapshot(attachments: [image]))
        let enumerator = try #require(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        let manifest = try #require((enumerator.allObjects as? [URL])?.first { $0.lastPathComponent == "draft.json" })
        var object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
        object.removeValue(forKey: "uploadedAt")
        try JSONSerialization.data(withJSONObject: object).write(to: manifest, options: .atomic)
        let restored = try #require(await store.load(expirePendingUploads: true))
        if case .failed = restored.attachments.first?.state {} else { Issue.record("Unknown upload age must require retry") }
        #expect(restored.attachments.first?.previewData == Data("context".utf8))
        #expect(restored.data["draft"] == Data("context".utf8))
    }

    @Test func restoredExpiredUnpreparedAttachmentCannotDispatch() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        try await store.save(snapshot(attachments: [attachment]), now: Date().addingTimeInterval(-25 * 60 * 60))
        var requests = 0
        let restored = model(directory: directory) { _, _ in requests += 1; return .object([:]) }
        await restored.restoreDraft()
        #expect(!restored.canSend)
        #expect(restored.attachmentData["draft"] == Data("context".utf8))
        await restored.send()
        #expect(requests == 0)
        await restored.stop()
    }

    @Test func agedPreparedAttachmentRetriesExactDispatchWithoutReuploadOrNewIdentity() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let finalAttachment = remoteAttachment("thread-claimed-upload").json
        var prepared = PathwayThreadPreparedSend(ids: ["draft"], messageID: "stable-command", text: "Draft", requestedMode: "queue",
            attachments: [finalAttachment], dispatchMode: .object(["type": .string("start_immediately")]))
        prepared.attachmentsPrepared = true
        let store = conversationStore(directory)
        try await store.save(snapshot(attachments: [attachment], prepared: prepared), now: Date().addingTimeInterval(-48 * 60 * 60))
        var dispatched: [JSONValue] = []
        let restored = model(directory: directory) { method, payload in
            #expect(method == "orchestration.dispatchCommand", "A claimed file must not be uploaded or prepared again")
            dispatched.append(payload)
            throw PathwayRPCError.disconnected
        }
        await restored.restoreDraft()
        #expect(restored.canSend)
        await restored.send()
        await restored.send()
        #expect(dispatched.count == 2)
        #expect(dispatched.first == dispatched.last)
        #expect(dispatched.first?.objectValue?["commandId"] == .string("stable-command"))
        #expect(dispatched.first?.objectValue?["attachments"] == .array([finalAttachment]))
        await restored.stop()
    }

    @Test func lostCancellationResponsePreservesDraftBeforeRPCAndBlocksDuplicateSend() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        let editing = model(directory: directory) { method, _ in
            #expect(method == "orchestration.dispatchCommand")
            let saved = try #require(await store.load())
            #expect(saved.text == "Original queued prompt")
            #expect(saved.pendingQueuedEditRunID == "run-1")
            throw PathwayRPCError.timedOut
        }
        await editing.restoreDraft()
        editing.installSnapshot(.object([
            "runs": .array([.object(["id": .string("run-1"), "ordinal": .number(1), "status": .string("queued"), "userMessageId": .string("message-1")])]),
            "visibleTurnItems": .array([.object(["item": .object([
                "id": .string("item-1"), "type": .string("user_message"), "createdBy": .string("user"),
                "messageId": .string("message-1"), "runId": .string("run-1"), "text": .string("Original queued prompt")
            ])])])
        ]))
        do { try await editing.restoreQueuedMessage("run-1"); Issue.record("Expected lost cancellation response") }
        catch {}
        #expect(editing.draft == "Original queued prompt")
        #expect(editing.pendingQueuedEditRunID == "run-1")
        #expect(!editing.canSend)
        let reopened = model(directory: directory)
        await reopened.restoreDraft()
        #expect(reopened.draft == "Original queued prompt")
        #expect(reopened.pendingQueuedEditRunID == "run-1")
        #expect(!reopened.canSend)
        await editing.stop(); await reopened.stop()
    }

    @Test func queuedEditKeepsFilesOnDiskAndCancellationFenceAcrossRelaunch() async throws {
        let directory = temporaryDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = directory.appending(path: "download")
        try Data("context".utf8).write(to: original)
        var file = attachment
        file.localFileURL = original
        file.state = .uploading
        let store = conversationStore(directory)
        let saved = try await store.saveQueuedEdit(PathwayConversationDraftSnapshot(text: "Recover me", attachments: [file],
            data: [:], preparedSend: nil, preparedNewSend: nil, revision: 1, pendingQueuedEditRunID: "run-1"))
        try FileManager.default.removeItem(at: original)
        #expect(saved.data.isEmpty)
        #expect(saved.attachments.first?.previewData == nil)
        let retained = try #require(saved.attachments.first?.localFileURL)
        #expect(try Data(contentsOf: retained) == Data("context".utf8))
        let reopened = model(directory: directory)
        await reopened.restoreDraft()
        #expect(reopened.draft == "Recover me")
        #expect(reopened.pendingQueuedEditRunID == "run-1")
        #expect(!reopened.canSend)
        #expect(reopened.attachmentData.isEmpty)
        await reopened.stop()
    }

    @Test func explicitRecoveryKeepsContentAndClearsTheCancellationFence() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        _ = try await store.saveQueuedEdit(PathwayConversationDraftSnapshot(text: "Keep my edits", attachments: [],
            data: [:], preparedSend: nil, preparedNewSend: nil, revision: 1, pendingQueuedEditRunID: "run-1"))
        let reopened = model(directory: directory)
        await reopened.restoreDraft()
        try await reopened.keepQueuedEditAsNewDraft()
        #expect(reopened.draft == "Keep my edits")
        #expect(reopened.pendingQueuedEditRunID == nil)
        #expect(await store.load()?.pendingQueuedEditRunID == nil)
        await reopened.stop()
    }

    @Test func acknowledgedCancellationUnlocksSavedTextAfterRelaunch() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = conversationStore(directory)
        _ = try await store.saveQueuedEdit(PathwayConversationDraftSnapshot(text: "Recover me", attachments: [],
            data: [:], preparedSend: nil, preparedNewSend: nil, revision: 1, pendingQueuedEditRunID: "run-1"))
        let reopened = model(directory: directory)
        await reopened.restoreDraft()
        reopened.installSnapshot(.object(["runs": .array([.object([
            "id": .string("run-1"), "status": .string("cancelled"), "ordinal": .number(1)
        ])])]))
        await reopened.reconcileQueuedEdit()
        #expect(reopened.pendingQueuedEditRunID == nil)
        #expect(reopened.draft == "Recover me")
        #expect(await store.load()?.pendingQueuedEditRunID == nil)
        await reopened.stop()
    }

    private func snapshot(text: String = "Draft", attachments: [PathwayThreadAttachmentDraft] = [],
                          prepared: PathwayThreadPreparedSend? = nil, revision: UInt64 = 1) -> PathwayConversationDraftSnapshot {
        PathwayConversationDraftSnapshot(text: text, attachments: attachments,
            data: Dictionary(uniqueKeysWithValues: attachments.map { ($0.id, Data("context".utf8)) }),
            preparedSend: prepared, preparedNewSend: nil, revision: revision)
    }
    private var attachment: PathwayThreadAttachmentDraft {
        PathwayThreadAttachmentDraft(id: "draft", name: "context.txt", mimeType: "text/plain", type: "file", sizeBytes: 7,
            state: .ready, attachment: remoteAttachment("pending-upload"))
    }
    private func remoteAttachment(_ id: String) -> PathwayMessageAttachment {
        PathwayMessageAttachment(id: id, type: "file", name: "context.txt", mimeType: "text/plain", sizeBytes: 7)
    }
    private func conversationStore(_ directory: URL) -> PathwayConversationDraftStore {
        PathwayConversationDraftStore(directory: directory.appending(path: "ConversationDrafts"), key: makeAgentThread().id)
    }
    private func model(directory: URL?, request: @escaping PathwayAgentThreadModel.Request = { _, _ in .object([:]) }) -> PathwayAgentThreadModel {
        let environment = PathwayCompanyEnvironment(companyId: "company", environment: PathwayEnvironment(id: "environment", environmentId: "environment",
            descriptor: PathwayEnvironmentDescriptor(environmentId: "environment", label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: makeAgentThread(), environment: environment, request: request, storageDirectory: directory)
    }
    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
}
