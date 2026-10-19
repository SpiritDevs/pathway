import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayQuestionAttachmentTests {
    @Test func photosSuppressOnlyImplicitSelections() {
        var draft = PathwayQuestionDraft(selected: ["q": ["First"]], implicitSelections: ["q"])
        #expect(draft.selectedOptions(for: "q", hasAttachments: false) == ["First"])
        #expect(draft.selectedOptions(for: "q", hasAttachments: true).isEmpty)
        draft.implicitSelections.remove("q")
        #expect(draft.selectedOptions(for: "q", hasAttachments: true) == ["First"])
    }

    @Test func discardingAStoredDraftRemovesBytesAndRejectsLateSaves() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayConversationDraftStore(directory: directory, key: "question")
        let draft = PathwayThreadAttachmentDraft(id: "draft", name: "answer.txt", mimeType: "text/plain", type: "file", sizeBytes: 3, state: .ready,
            attachment: PathwayMessageAttachment(id: "pending-upload", type: "file", name: "answer.txt", mimeType: "text/plain", sizeBytes: 3))
        let snapshot = PathwayConversationDraftSnapshot(text: "", attachments: [draft], data: ["draft": Data("yes".utf8)], preparedSend: nil, preparedNewSend: nil, revision: 1)
        try await store.save(snapshot)
        #expect(try await store.discard() == ["pending-upload"])
        try await store.save(snapshot)
        #expect(await store.load() == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test func aLateUploadCannotRecreateADiscardedQuestionDraft() async throws {
        let attachments = PathwayNewThreadAttachments(directory: nil, key: "question")
        attachments.supportsUploads = true; attachments.maximumFileBytes = 50; attachments.isConnected = true
        let started = AsyncStream<Void>.makeStream()
        var finishUpload: CheckedContinuation<Void, Never>?
        var deleted: [String] = []
        attachments.request = { method, payload in
            if method == "attachments.delete" { deleted.append(payload.objectValue?["attachmentId"]?.stringValue ?? ""); return .object([:]) }
            return .object(["attachmentId": .string("pending-upload"), "relativeUrl": .string("/upload")])
        }
        attachments.uploadRequest = { _ in URLRequest(url: URL(string: "https://example.invalid/upload")!) }
        attachments.upload = { _, _ in
            await withCheckedContinuation { continuation in finishUpload = continuation; started.continuation.yield(()) }
        }
        let adding = Task { await attachments.add(data: Data("yes".utf8), name: "answer.txt", mimeType: "text/plain") }
        var events = started.stream.makeAsyncIterator()
        await events.next()
        try await attachments.discard()
        finishUpload?.resume()
        await adding.value
        await attachments.add(data: Data("late".utf8), name: "late.txt", mimeType: "text/plain")
        #expect(attachments.drafts.isEmpty)
        #expect(attachments.bytes.isEmpty)
        #expect(deleted == ["pending-upload"])
    }

    @Test(arguments: ["resolved", "cancelled", "snapshot"])
    func remoteResolutionRemovesQuestionStores(status: String) async throws {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let model = PathwayAgentThreadModel(thread: thread, environment: environment, request: { _, _ in .object([:]) })
        model.serverConfig = ["environment": .object(["capabilities": .object(["questionAttachments": .bool(true)])])]
        let question: JSONValue = .object(["id": .string("question-item"), "type": .string("user_input_request"), "status": .string("waiting"), "requestId": .string("request"),
            "questions": .array([.object(["id": .string("q"), "header": .string("Layout"), "question": .string("Which layout?"), "options": .array([])])])])
        model.installSnapshot(.object(["visibleTurnItems": .array([.object(["item": question])]), "runtimeRequests": .array([.object(["id": .string("request"), "status": .string("pending")])])]))
        let item = try #require(model.items.first)
        let attachments = model.questionAttachments(item: item, questionID: "q")
        await attachments.add(data: Data("png".utf8), name: "answer.png", mimeType: "image/png")
        #expect(!attachments.bytes.isEmpty)
        if status == "snapshot" {
            model.installSnapshot(.object(["visibleTurnItems": .array([]), "runtimeRequests": .array([])]))
        } else {
            model.applySubscriptionValue(.object(["kind": .string("event"), "sequence": .number(1), "event": .object(["type": .string("runtime-request.updated"), "payload": .object(["id": .string("request"), "status": .string(status)])])]))
        }
        await model.questionAttachmentCleanupTask?.value
        #expect(model.questionAttachmentStores.isEmpty)
        #expect(attachments.bytes.isEmpty)
        #expect(attachments.drafts.isEmpty)
    }
}
