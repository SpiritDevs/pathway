import CryptoKit
import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayNewThreadDraftRecoveryTests {
    @Test func criticalStorageBlocksModelLaunchWithoutMountedBannerUntilExplicitOverride() async throws {
        var methods: [String] = []
        let model = creation("a", directory: nil) { method, _ in
            methods.append(method)
            if method == "storage.snapshot" {
                let now = Date().ISO8601Format()
                return .object(["sampledAt": .string(now), "volumes": .array([.object(["pressure": .string("critical"), "sampledAt": .string(now)])])])
            }
            return .object(["threadId": .string("created")])
        }
        configure(model, storageManagement: true)
        model.prompt = "Work on this issue"
        #expect(model.canLaunch)
        #expect(await model.launch() == nil)
        #expect(methods == ["storage.snapshot"])
        #expect(model.prompt == "Work on this issue")
        #expect(model.errorMessage?.contains("Continue anyway") == true)

        // A healthy/stale view callback is not explicit approval to launch on a critical host.
        model.storageAllowsLaunch = true
        #expect(await model.launch() == nil)
        #expect(!methods.contains("orchestration.launchThread"))
        model.continueDespiteCriticalStorage()
        #expect(await model.launch() == "created")
        #expect(methods.filter { $0 == "orchestration.launchThread" }.count == 1)
    }

    @Test func unavailableAndStaleStorageRemainAdvisory() async throws {
        for unavailable in [true, false] {
            var launches = 0
            let model = creation("a", directory: nil) { method, _ in
                if method == "storage.snapshot" {
                    if unavailable { throw PathwayRPCError.disconnected }
                    let stale = Date().addingTimeInterval(-300).ISO8601Format()
                    return .object(["sampledAt": .string(stale), "volumes": .array([
                        .object(["pressure": .string("critical"), "sampledAt": .string(stale)])])])
                }
                if method == "orchestration.launchThread" { launches += 1 }
                return .object(["threadId": .string("created")])
            }
            configure(model, storageManagement: true)
            model.prompt = "Work on this issue"
            #expect(await model.launch() == "created")
            #expect(launches == 1)
        }
    }

    @Test func expiredInitialUploadRequiresRetryAndRetainsLocalBytes() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await seedAttachment(directory: directory, binding: "a", uploaded: Date().addingTimeInterval(-25 * 60 * 60))
        let restored = creation("a", directory: directory)
        await restored.restoreDraft()
        configure(restored)
        #expect(!restored.canLaunch)
        if case .failed = restored.attachments.drafts.first?.state {} else { Issue.record("Expired initial upload must expose retry") }
        #expect(restored.attachments.bytes["draft"] == Data("context".utf8))
        var uploadPaths: [String] = []
        restored.attachments.uploadRequest = { path in
            uploadPaths.append(path)
            return URLRequest(url: URL(string: "https://example.invalid/upload")!)
        }
        restored.attachments.upload = { _, bytes in #expect(bytes == Data("context".utf8)) }
        await restored.attachments.retry(id: "draft")
        #expect(restored.attachments.isReady)
        #expect(uploadPaths == ["/api/attachments/new-upload"])
        #expect(restored.attachments.uploads.first?.objectValue?["id"] == .string("new-upload"))
        await restored.stop()
    }

    @Test func claimedLaunchSurvivesUploadExpiryWithIdenticalRetryPayload() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await seedAttachment(directory: directory, binding: "a")
        var preparations = 0
        var launches: [JSONValue] = []
        let request: PathwayAgentThreadCreationModel.Request = { method, payload in
            if method == "assets.persistChatAttachments" {
                preparations += 1
                return .object(["attachments": .array([self.remote("claimed-upload")])])
            }
            launches.append(payload)
            throw PathwayRPCError.disconnected
        }
        let first = creation("a", directory: directory, request: request)
        await first.restoreDraft(); configure(first)
        first.prompt = "Original launch"
        #expect(await first.launch() == nil)
        await first.stop()
        try ageAttachmentManifest(directory: directory)
        let restored = creation("a", directory: directory, request: request)
        await restored.restoreDraft(); configure(restored)
        #expect(restored.canLaunch)
        #expect(await restored.launch() == nil)
        #expect(preparations == 1)
        #expect(launches.count == 2)
        #expect(launches.first == launches.last)
        // Editing starts a new intention, which cannot borrow the old claim to bypass expiry.
        restored.prompt = "Changed launch"
        #expect(await restored.launch() == nil)
        #expect(!restored.canLaunch)
        #expect(preparations == 1)
        #expect(launches.count == 2)
        await restored.stop()
    }

    @Test func incomingEditsAndBytesMoveButRemoteUploadIDsDoNot() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await seedAttachment(directory: directory, binding: "a")
        let source = creation("a", directory: directory)
        await source.restoreDraft(); configure(source)
        source.prompt = "Shortcut text with my later edits"
        let target = creation("b", directory: directory)
        try await source.transferIncomingDraft(to: target)
        #expect(target.prompt == "Shortcut text with my later edits")
        #expect(target.attachments.bytes["draft"] == Data("context".utf8))
        #expect(target.attachments.drafts.first?.attachment == nil)
        #expect(!target.attachments.isReady)
        #expect(source.prompt.isEmpty)
        #expect(source.attachments.drafts.isEmpty)
        let reopened = creation("b", directory: directory)
        await reopened.restoreDraft()
        #expect(reopened.prompt == target.prompt)
        #expect(reopened.attachments.bytes["draft"] == Data("context".utf8))
        var uploads = 0
        configure(target)
        target.attachments.uploadRequest = { _ in URLRequest(url: URL(string: "https://example.invalid/upload")!) }
        target.attachments.upload = { _, bytes in uploads += 1; #expect(bytes == Data("context".utf8)) }
        await target.attachments.prepareTransferredAttachments()
        await target.attachments.prepareTransferredAttachments()
        #expect(uploads == 1)
        #expect(target.attachments.uploads.first?.objectValue?["id"] == .string("new-upload"))
        await source.stop(); await target.stop(); await reopened.stop()
    }

    @Test func occupiedDestinationRefusesTransferAndPreservesBothDrafts() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = creation("a", directory: directory)
        source.prompt = "Edited incoming text"
        let target = creation("b", directory: directory)
        target.prompt = "Existing destination text"
        await target.persistDraftNow()
        do { try await source.transferIncomingDraft(to: target); Issue.record("An occupied destination must refuse transfer") }
        catch {}
        #expect(source.prompt == "Edited incoming text")
        #expect(target.prompt == "Existing destination text")
        await source.stop(); await target.stop()
    }

    @Test func sharedDraftReceiptFollowsEditsWithoutAppendingTheOriginalAgain() async throws {
        let root = temporaryDirectory()
        let directory = root.appending(path: "account")
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = PathwayCaptureStore(directory: root.appending(path: "inbox"))
        try await inbox.setActiveAccount("account")
        let capture = try await inbox.save(prompt: "Shared original", files: [], accountKey: "account")
        let source = creation("a", directory: directory)
        #expect(await source.importCapturedDraft(capture, store: inbox))
        source.prompt = "My edited shared instructions"
        let target = creation("b", directory: directory)
        try await source.transferIncomingDraft(to: target)
        let reopened = creation("b", directory: directory)
        #expect(await reopened.importCapturedDraft(capture, store: inbox))
        #expect(reopened.prompt == "My edited shared instructions")
        #expect(try await inbox.drafts(accountKey: "account").count == 1)
        await source.stop(); await target.stop(); await reopened.stop()
    }

    @Test func failedDestinationWriteLeavesSourceTextAndBytesIntact() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await seedAttachment(directory: directory, binding: "a")
        let source = creation("a", directory: directory)
        await source.restoreDraft()
        source.prompt = "Keep my edits"
        let name = SHA256.hash(data: Data(binding("b").id.utf8)).map { String(format: "%02x", $0) }.joined()
        let blocked = directory.appending(path: "InitialAttachments").appending(path: name)
        try Data("not a directory".utf8).write(to: blocked)
        let target = creation("b", directory: directory)
        do { try await source.transferIncomingDraft(to: target); Issue.record("Expected destination write failure") }
        catch {}
        #expect(source.prompt == "Keep my edits")
        #expect(source.attachments.bytes["draft"] == Data("context".utf8))
        #expect(source.attachments.drafts.first?.attachment?.id == "pending-upload")
        await source.stop()
    }

    @Test func claimedLaunchCannotMoveToAnotherBinding() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = creation("a", directory: directory) { _, _ in throw PathwayRPCError.disconnected }
        configure(source)
        source.prompt = "Possibly accepted launch"
        _ = await source.launch()
        let target = creation("b", directory: directory)
        do { try await source.transferIncomingDraft(to: target); Issue.record("Claimed launch must remain in original binding") }
        catch {}
        #expect(source.prompt == "Possibly accepted launch")
        #expect(target.prompt.isEmpty)
        await source.stop(); await target.stop()
    }

    @Test func nonpersistentIssueInstructionsCannotOverwriteOrdinaryBindingDraft() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let ordinary = creation("a", directory: directory)
        ordinary.prompt = "My unrelated work"
        await ordinary.stop()
        let issue = creation("a", directory: nil)
        issue.prompt = "Generated issue instructions"
        await issue.restoreDraft()
        await issue.stop()
        let restored = creation("a", directory: directory)
        await restored.restoreDraft()
        #expect(restored.prompt == "My unrelated work")
        #expect(restored.attachments.drafts.isEmpty)
        await restored.stop()
    }

    private func seedAttachment(directory: URL, binding id: String, uploaded: Date = Date()) async throws {
        let store = PathwayConversationDraftStore(directory: directory.appending(path: "InitialAttachments"), key: binding(id).id)
        let attachment = PathwayThreadAttachmentDraft(id: "draft", name: "context.txt", mimeType: "text/plain", type: "file", sizeBytes: 7,
            state: .ready, attachment: .init(id: "pending-upload", type: "file", name: "context.txt", mimeType: "text/plain", sizeBytes: 7))
        try await store.save(.init(text: "", attachments: [attachment], data: ["draft": Data("context".utf8)],
            preparedSend: nil, preparedNewSend: nil, revision: 1), now: uploaded)
    }
    private func ageAttachmentManifest(directory: URL) throws {
        let root = directory.appending(path: "InitialAttachments")
        let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL])
        let manifest = try #require(files.first { $0.lastPathComponent == "draft.json" })
        var object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
        object["uploadedAt"] = ["pending-upload": Date().addingTimeInterval(-48 * 60 * 60).timeIntervalSinceReferenceDate]
        try JSONSerialization.data(withJSONObject: object).write(to: manifest, options: .atomic)
    }
    private func creation(_ id: String, directory: URL?, request: PathwayAgentThreadCreationModel.Request? = nil) -> PathwayAgentThreadCreationModel {
        PathwayAgentThreadCreationModel(binding: binding(id), environment: environment, storageDirectory: directory,
            request: request ?? { method, _ in
                if method == "attachments.createUploadUrl" { return .object(["attachmentId": .string("new-upload"), "relativeUrl": .string("/api/attachments/new-upload")]) }
                return .object([:])
            })
    }
    private func configure(_ model: PathwayAgentThreadCreationModel, storageManagement: Bool = false) {
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object([
            "environment": .object(["capabilities": .object(["storageManagement": .bool(storageManagement)])]),
            "settings": .object(["defaultThreadEnvMode": .string("local"), "newWorktreesStartFromOrigin": .bool(false)]),
            "providers": .array([.object(["instanceId": .string("codex"), "driver": .string("codex"), "enabled": .bool(true), "installed": .bool(true),
                "models": .array([.object(["slug": .string("model"), "name": .string("Model"), "isDefault": .bool(true)])])])])
        ])]))
        model.attachments.supportsUploads = true
        model.attachments.maximumFileBytes = 1024
    }
    private func remote(_ id: String) -> JSONValue { .object(["id": .string(id), "type": .string("file"), "name": .string("context.txt"), "mimeType": .string("text/plain"), "sizeBytes": .number(7)]) }
    private func binding(_ id: String) -> PathwayCompanyEnvironmentBinding {
        .init(companyId: "company", binding: .init(id: id, cloudProjectId: id, environmentId: "environment", localProjectId: id,
            localWorkspaceRoot: "/\(id)", status: "active", lastSeenAt: nil))
    }
    private var environment: PathwayCompanyEnvironment {
        .init(companyId: "company", environment: .init(id: "environment", environmentId: "environment",
            descriptor: .init(environmentId: "environment", label: "Mac", serverVersion: "test"), relayLinkState: "connected",
            managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
    }
    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
}
