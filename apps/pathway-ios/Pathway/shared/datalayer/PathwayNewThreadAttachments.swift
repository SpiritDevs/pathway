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

    init(directory: URL?, key: String) {
        store = directory.map { PathwayConversationDraftStore(directory: $0.appending(path: "InitialAttachments"), key: key) }
    }

    var uploads: [JSONValue] { drafts.compactMap { $0.state == .ready ? $0.attachment?.json : nil } }
    var isReady: Bool { drafts.allSatisfy { $0.state == .ready } }

    func restore() async {
        guard !restored, let store else { return }
        restored = true
        guard let saved = await store.load(), drafts.isEmpty else { return }
        drafts = saved.attachments; bytes = saved.data
    }

    func persist() async {
        do { try await persistChecked() }
        catch { errorMessage = "The attachment draft could not be saved. " + error.localizedDescription }
    }

    func persistChecked() async throws {
        guard let store, restored || !drafts.isEmpty else { return }
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
        let type = mimeType.hasPrefix("image/") ? "image" : "file"
        guard drafts.count < 8 else { errorMessage = "You can attach up to 8 files."; return }
        guard supportsUploads, type == "image" || maximumFileBytes != nil else {
            errorMessage = "This environment does not support uploading this file type."; return
        }
        let limit = type == "image" ? 10 * 1024 * 1024 : min(50 * 1024 * 1024, maximumFileBytes ?? 0)
        guard !data.isEmpty, data.count <= limit else { errorMessage = "This attachment exceeds the environment's upload limit."; return }
        restored = true
        let id = UUID().uuidString
        drafts.append(PathwayThreadAttachmentDraft(id: id, name: String(name.prefix(255)), mimeType: mimeType,
            type: type, sizeBytes: data.count, state: .uploading, previewData: type == "image" ? data : nil))
        bytes[id] = data
        await persist()
        await retry(id: id)
    }

    func retry(id: String) async {
        guard let index = drafts.firstIndex(where: { $0.id == id }), let data = bytes[id] else { return }
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
            errorMessage = error.localizedDescription
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

    func clearError() { errorMessage = nil }
}
