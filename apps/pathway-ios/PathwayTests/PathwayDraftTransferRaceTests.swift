import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayDraftTransferRaceTests {
    @Test func transferExcludesLaunchImportAndAnotherTransfer() async throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appending(path: "account")
        let gate = DraftTransferSaveGate()
        let requests = DraftTransferRequests()
        let source = creation("a", directory: directory, request: { method, _ in
            requests.methods.append(method)
            return .object([:])
        })
        await source.restoreDraft()
        configure(source)
        source.prompt = "Move these instructions"
        await source.persistDraftNow()
        #expect(source.canLaunch)
        let target = creation("b", directory: directory, saveDraft: { draft, _ in
            if !draft.prompt.isEmpty { await gate.pauseOnce() }
        })
        let transfer = Task { try await source.transferIncomingDraft(to: target) }
        await gate.waitUntilPaused()
        #expect(source.isTransferringDraft)
        #expect(!source.canLaunch)
        #expect(await source.launch() == nil)
        #expect(requests.methods.isEmpty)
        let inbox = PathwayCaptureStore(directory: root.appending(path: "inbox"))
        try await inbox.setActiveAccount("account")
        let capture = try await inbox.save(prompt: "Another capture", files: [], accountKey: "account")
        #expect(!(await source.importCapturedDraft(capture, store: inbox)))
        let other = creation("c", directory: directory)
        do {
            try await source.transferIncomingDraft(to: other)
            Issue.record("A second transfer must be refused while the first owns the draft")
        } catch {}
        #expect(other.prompt.isEmpty)
        gate.release()
        try await transfer.value
        #expect(!source.isTransferringDraft)
        #expect(source.prompt.isEmpty)
        #expect(target.prompt == "Move these instructions")
        await source.stop(); await target.stop(); await other.stop()
    }

    @Test func cleanupPreservesAttachmentArrivingAfterTransferSnapshot() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = DraftTransferSaveGate()
        let source = creation("a", directory: directory, saveDraft: { draft, _ in
            if draft.prompt.isEmpty { await gate.pauseOnce() }
        })
        await source.restoreDraft()
        configure(source)
        source.prompt = "Original instructions"
        await source.attachments.add(data: Data("original".utf8), name: "original.txt", mimeType: "text/plain")
        await source.persistDraftNow()
        let originalID = try #require(source.attachments.drafts.first?.id)
        let target = creation("b", directory: directory)
        let transfer = Task { try await source.transferIncomingDraft(to: target) }
        await gate.waitUntilPaused()
        // A file read already in flight can complete after the composer becomes disabled.
        await source.attachments.add(data: Data("late".utf8), name: "late.txt", mimeType: "text/plain")
        let lateID = try #require(source.attachments.drafts.first { $0.name == "late.txt" }?.id)
        gate.release()
        try await transfer.value
        #expect(source.attachments.drafts.map(\.id) == [lateID])
        #expect(source.attachments.bytes[lateID] == Data("late".utf8))
        #expect(source.attachments.bytes[originalID] == nil)
        #expect(target.attachments.drafts.map(\.id) == [originalID])
        #expect(target.attachments.bytes[originalID] == Data("original".utf8))
        #expect(target.attachments.bytes[lateID] == nil)
        #expect(!source.isTransferringDraft)
        await source.stop(); await target.stop()
    }

    @Test func cancelledTransferRestoresExclusivityAndKeepsSource() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = DraftTransferSaveGate()
        let source = creation("a", directory: directory)
        await source.restoreDraft()
        configure(source)
        source.prompt = "Keep this draft"
        await source.persistDraftNow()
        let target = creation("b", directory: directory, saveDraft: { draft, _ in
            if !draft.prompt.isEmpty { await gate.pauseOnce() }
        })
        let transfer = Task { try await source.transferIncomingDraft(to: target) }
        await gate.waitUntilPaused()
        transfer.cancel()
        gate.release()
        do {
            try await transfer.value
            Issue.record("Cancellation before the transfer commit must retain the source")
        } catch is CancellationError {} catch { Issue.record("Unexpected error: \(error)") }
        #expect(!source.isTransferringDraft)
        #expect(source.prompt == "Keep this draft")
        #expect(source.canLaunch)
        await source.stop(); await target.stop()
    }

    private func creation(_ id: String, directory: URL,
                          request: PathwayAgentThreadCreationModel.Request? = nil,
                          saveDraft: PathwayAgentThreadCreationModel.DraftSave? = nil) -> PathwayAgentThreadCreationModel {
        let binding = PathwayCompanyEnvironmentBinding(companyId: "company", binding: .init(
            id: id, cloudProjectId: id, environmentId: "environment", localProjectId: id,
            localWorkspaceRoot: "/\(id)", status: "active", lastSeenAt: nil))
        let environment = PathwayCompanyEnvironment(companyId: "company", environment: .init(
            id: "environment", environmentId: "environment",
            descriptor: .init(environmentId: "environment", label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadCreationModel(binding: binding, environment: environment,
            storageDirectory: directory, request: request ?? { _, _ in .object([:]) }, saveDraft: saveDraft)
    }

    private func configure(_ model: PathwayAgentThreadCreationModel) {
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object([
            "settings": .object(["defaultThreadEnvMode": .string("local"), "newWorktreesStartFromOrigin": .bool(false)]),
            "providers": .array([.object(["instanceId": .string("codex"), "driver": .string("codex"),
                "enabled": .bool(true), "installed": .bool(true), "models": .array([.object([
                    "slug": .string("model"), "name": .string("Model"), "isDefault": .bool(true)
                ])])])])
        ])]))
        model.attachments.supportsUploads = true
        model.attachments.maximumFileBytes = 1024
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    }
}

@MainActor
private final class DraftTransferRequests {
    var methods: [String] = []
}

@MainActor
private final class DraftTransferSaveGate {
    private var entered = false
    private var observer: CheckedContinuation<Void, Never>?
    private var blockedSave: CheckedContinuation<Void, Never>?

    func pauseOnce() async {
        guard !entered else { return }
        entered = true
        await withCheckedContinuation { continuation in
            blockedSave = continuation
            observer?.resume()
            observer = nil
        }
    }

    func waitUntilPaused() async {
        guard !entered else { return }
        await withCheckedContinuation { observer = $0 }
    }

    func release() {
        blockedSave?.resume()
        blockedSave = nil
    }
}
