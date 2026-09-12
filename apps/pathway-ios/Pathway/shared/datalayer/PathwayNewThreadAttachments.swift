import Foundation
import Observation
import UniformTypeIdentifiers

/// The first message uses the same upload metadata contract as an ongoing conversation.
@MainActor
@Observable
final class PathwayNewThreadAttachments {
    typealias Request = @MainActor (String, JSONValue) async throws -> JSONValue
    typealias UploadRequest = @MainActor (String) async throws -> URLRequest
    typealias Upload = @MainActor (URLRequest, Data) async throws -> Void

    private(set) var drafts: [PathwayThreadAttachmentDraft] = []
    private(set) var errorMessage: String?
    var supportsUploads = false
    var maximumFileBytes: Int?
    var isConnected = false
    var usesCloudQueue = false
    @ObservationIgnored var request: Request?
    @ObservationIgnored var uploadRequest: UploadRequest?
    @ObservationIgnored var upload: Upload = { request, data in
        let (_, response) = try await URLSession.shared.upload(for: request, from: data)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw PathwayThreadConversationError.message("The attachment could not be uploaded. Try again.")
        }
    }
    @ObservationIgnored private(set) var bytes: [String: Data] = [:]
    @ObservationIgnored private let store: PathwayConversationDraftStore?
    @ObservationIgnored private var restored = false
    @ObservationIgnored private var discarded = false
    @ObservationIgnored private var transferredIDs: Set<String> = []

    init(directory: URL?, key: String) {
        store = directory.map { PathwayConversationDraftStore(directory: $0.appending(path: "InitialAttachments"), key: key) }
    }

    var uploads: [JSONValue] { drafts.compactMap { $0.state == .ready ? $0.attachment?.json : nil } }
    var isReady: Bool { drafts.allSatisfy { $0.state == .ready } }

    func restore(preservingPreparedUploadIDs: Set<String> = []) async {
        guard !discarded, !restored, let store else { return }
        restored = true
        guard let saved = await store.load(expirePendingUploads: true,
            preservingPreparedUploadIDs: preservingPreparedUploadIDs), !discarded, drafts.isEmpty else { return }
        drafts = saved.attachments; bytes = saved.data
    }

    func revalidatePendingUploads(preservingPreparedUploadIDs: Set<String> = []) async throws {
        guard let store else { return }
        try await persistChecked()
        guard let saved = await store.load(expirePendingUploads: true,
            preservingPreparedUploadIDs: preservingPreparedUploadIDs) else { return }
        for savedDraft in saved.attachments {
            guard let index = drafts.firstIndex(where: { $0.id == savedDraft.id && $0.attachment?.id == savedDraft.attachment?.id }),
                  drafts[index].state == .ready else { continue }
            drafts[index].state = savedDraft.state
        }
    }

    func stageTransfer(drafts incoming: [PathwayThreadAttachmentDraft], bytes data: [String: Data]) async throws {
        guard drafts.isEmpty else { throw PathwayThreadConversationError.message("This project already has an attachment draft.") }
        guard incoming.allSatisfy({ data[$0.id] != nil }) else {
            throw PathwayThreadConversationError.message("An attachment's local bytes are unavailable. Keep this draft in its current project.")
        }
        restored = true
        drafts = incoming.map { draft in
            var copy = draft
            copy.attachment = nil
            copy.state = .failed("This attachment needs a new upload in the selected environment. Tap retry.")
            return copy
        }
        bytes = data
        transferredIDs = Set(incoming.map(\.id))
        try await persistChecked()
    }

    func prepareTransferredAttachments() async {
        guard isConnected else { return }
        let ids = transferredIDs
        transferredIDs = []
        for id in ids { await retry(id: id) }
    }

    func persist() async {
        do { try await persistChecked() }
        catch { errorMessage = "The attachment draft could not be saved. " + error.localizedDescription }
    }

    func persistChecked() async throws {
        guard !discarded, let store, restored || !drafts.isEmpty else { return }
        try await store.save(PathwayConversationDraftSnapshot(text: "", attachments: drafts, data: bytes,
            preparedSend: nil, preparedNewSend: nil, revision: DispatchTime.now().uptimeNanoseconds))
    }

    func add(fileURL: URL) async {
        let reader = Task.detached(priority: .userInitiated) {
            let granted = fileURL.startAccessingSecurityScopedResource()
            defer { if granted { fileURL.stopAccessingSecurityScopedResource() } }
            try Task.checkCancellation()
            let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard (1...50 * 1024 * 1024).contains(size) else {
                throw PathwayThreadConversationError.message("Choose a file under 50 MB.")
            }
            return try Data(contentsOf: fileURL)
        }
        do {
            let data = try await withTaskCancellationHandler { try await reader.value } onCancel: { reader.cancel() }
            try Task.checkCancellation()
            await add(data: data, name: fileURL.lastPathComponent,
                mimeType: UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription }
    }

    func add(data: Data, name: String, mimeType: String) async {
        guard !discarded else { return }
        let type = mimeType.hasPrefix("image/") ? "image" : "file"
        guard drafts.count < 8 else { errorMessage = "You can attach up to 8 files."; return }
        guard usesCloudQueue || (supportsUploads && (type == "image" || maximumFileBytes != nil)) else {
            errorMessage = "This environment does not support uploading this file type."; return
        }
        let limit = type == "image" ? 10 * 1024 * 1024 : min(50 * 1024 * 1024, usesCloudQueue ? 50 * 1024 * 1024 : maximumFileBytes ?? 0)
        guard !data.isEmpty, data.count <= limit else { errorMessage = "This attachment exceeds the environment's upload limit."; return }
        restored = true
        let id = UUID().uuidString
        drafts.append(PathwayThreadAttachmentDraft(id: id, name: String(name.prefix(255)), mimeType: mimeType,
            type: type, sizeBytes: data.count, state: usesCloudQueue ? .ready : .uploading, previewData: type == "image" ? data : nil))
        bytes[id] = data
        await persist()
        if !usesCloudQueue { await retry(id: id) }
    }

    func retry(id: String) async {
        guard !discarded, let index = drafts.firstIndex(where: { $0.id == id }), let data = bytes[id] else { return }
        if usesCloudQueue { drafts[index].state = .ready; errorMessage = nil; await persist(); return }
        let draft = drafts[index]
        drafts[index].state = .uploading
        var uploadedID: String?
        do {
            guard isConnected, let request, let makeUploadRequest = uploadRequest else { throw PathwayRPCError.disconnected }
            let value = try await request("attachments.createUploadUrl", .object([
                "name": .string(draft.name), "type": .string(draft.type), "mimeType": .string(draft.mimeType), "sizeBytes": .number(Double(data.count))]))
            guard let fields = value.objectValue, let attachmentID = fields["attachmentId"]?.stringValue,
                  let relative = fields["relativeUrl"]?.stringValue else { throw PathwayThreadConversationError.message("The upload URL was unavailable.") }
            uploadedID = attachmentID
            var uploadRequest = try await makeUploadRequest(relative)
            uploadRequest.setValue(draft.mimeType, forHTTPHeaderField: "Content-Type")
            try await upload(uploadRequest, data)
            guard let index = drafts.firstIndex(where: { $0.id == id }) else {
                _ = try? await request("attachments.delete", .object(["attachmentId": .string(attachmentID)])); return
            }
            drafts[index].attachment = PathwayMessageAttachment(id: attachmentID, type: draft.type, name: draft.name, mimeType: draft.mimeType, sizeBytes: data.count)
            drafts[index].state = .ready
            errorMessage = nil
        } catch {
            if let uploadedID, let request { _ = try? await request("attachments.delete", .object(["attachmentId": .string(uploadedID)])) }
            if let index = drafts.firstIndex(where: { $0.id == id }) { drafts[index].state = .failed(error.localizedDescription) }
        }
        await persist()
    }

    func remove(id: String) async {
        let attachmentID = drafts.first(where: { $0.id == id })?.attachment?.id
        drafts.removeAll { $0.id == id }; bytes.removeValue(forKey: id)
        await persist()
        if let attachmentID, let request { _ = try? await request("attachments.delete", .object(["attachmentId": .string(attachmentID)])) }
    }

    /// Accepted sends own the uploaded files. Clearing the local draft must not delete them remotely.
    func didSend(ids: Set<String>) async {
        drafts.removeAll { ids.contains($0.id) }
        for id in ids { bytes.removeValue(forKey: id) }
        await persist()
    }

    /// Resolved questions cannot retain bytes or accept late imports and uploads.
    func discard() async throws {
        discarded = true
        let activeIDs = drafts.compactMap { $0.attachment?.id }
        drafts = []; bytes = [:]
        let savedIDs = try await store?.discard() ?? []
        for id in Set(activeIDs + savedIDs) {
            if let request { _ = try? await request("attachments.delete", .object(["attachmentId": .string(id)])) }
        }
    }

    func clearError() { errorMessage = nil }
}
