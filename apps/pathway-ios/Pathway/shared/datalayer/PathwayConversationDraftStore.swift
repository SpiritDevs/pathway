import CryptoKit
import Foundation

struct PathwayConversationDraftSnapshot: Sendable {
    let text: String
    let attachments: [PathwayThreadAttachmentDraft]
    let data: [String: Data]
    let preparedSend: PathwayThreadPreparedSend?
    let preparedNewSend: PathwayThreadPreparedNewSend?
    let revision: UInt64
    var pendingQueuedEditRunID: String? = nil
}

/// Keeps attachment bytes out of text-edit writes and scopes every file to one account and thread.
actor PathwayConversationDraftStore {
    private struct Manifest: Codable {
        let text: String
        let attachments: [PathwayThreadAttachmentDraft]
        let preparedSend: PathwayThreadPreparedSend?
        let preparedNewSend: PathwayThreadPreparedNewSend?
        var pendingQueuedEditRunID: String? = nil
        /// First observed successful upload, keyed by the remote upload ID, not draft edits.
        var uploadedAt: [String: Date]? = nil
    }

    private let directory: URL
    private var lastRevision: UInt64 = 0

    init(directory: URL, key: String) {
        self.directory = directory.appending(path: Self.fileName(key), directoryHint: .isDirectory)
    }

    func load(now: Date = Date(), expirePendingUploads: Bool = false,
              preservingPreparedUploadIDs: Set<String> = []) -> PathwayConversationDraftSnapshot? {
        guard let encoded = try? Data(contentsOf: directory.appending(path: "draft.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: encoded) else { return nil }
        var data: [String: Data] = [:]
        let preparedIDs: Set<String>
        if let send = manifest.preparedSend, send.attachmentsPrepared,
           send.ids == manifest.attachments.map(\.id),
           send.text == manifest.text.trimmingCharacters(in: .whitespacesAndNewlines) {
            preparedIDs = Set(send.ids)
        } else if let send = manifest.preparedNewSend, send.attachmentsPrepared,
                  send.ids == manifest.attachments.map(\.id),
                  send.text == manifest.text.trimmingCharacters(in: .whitespacesAndNewlines) {
            preparedIDs = Set(send.ids)
        } else { preparedIDs = [] }
        let attachments = manifest.attachments.map { attachment in
            var draft = attachment
            if draft.localFileURL != nil, FileManager.default.fileExists(atPath: attachmentURL(draft.id).path) {
                draft.localFileURL = attachmentURL(draft.id)
            } else if let bytes = try? Data(contentsOf: attachmentURL(draft.id)) {
                data[draft.id] = bytes
                draft.previewData = draft.type == "image" ? bytes : nil
            }
            if draft.state == .uploading {
                draft.state = .failed("Upload interrupted. Tap retry to finish preparing this attachment.")
            } else if expirePendingUploads, draft.state == .ready, !preparedIDs.contains(draft.id),
                      !preservingPreparedUploadIDs.contains(draft.attachment?.id ?? "") {
                let uploadedAt = draft.attachment.flatMap { manifest.uploadedAt?[$0.id] }
                // Older manifests have no upload date, so their pending uploads cannot be trusted.
                if uploadedAt.map({ now.timeIntervalSince($0) >= 24 * 60 * 60 }) ?? true {
                    draft.state = .failed("This upload has expired. Tap retry to upload the saved attachment again.")
                }
            }
            return draft
        }
        return PathwayConversationDraftSnapshot(text: manifest.text, attachments: attachments, data: data,
            preparedSend: manifest.preparedSend, preparedNewSend: manifest.preparedNewSend, revision: 0, pendingQueuedEditRunID: manifest.pendingQueuedEditRunID)
    }

    /// Publishes a complete legacy text draft without replacing an existing account draft.
    /// The caller removes UserDefaults only after this returns true.
    func migrateLegacyText(_ text: String) throws -> Bool {
        let manifestURL = directory.appending(path: "draft.json")
        guard !FileManager.default.fileExists(atPath: manifestURL.path) else { return false }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appending(path: UUID().uuidString + ".migration")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let manifest = Manifest(text: text, attachments: [], preparedSend: nil, preparedNewSend: nil)
        try JSONEncoder().encode(manifest).write(to: temporary,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        do {
            // Linking the completed file is atomic and fails if another writer published first.
            try FileManager.default.linkItem(at: temporary, to: manifestURL)
            return true
        } catch {
            if FileManager.default.fileExists(atPath: manifestURL.path) { return false }
            throw error
        }
    }

    func save(_ snapshot: PathwayConversationDraftSnapshot, now: Date = Date()) throws {
        guard snapshot.revision >= lastRevision else { return }
        let previous = (try? Data(contentsOf: directory.appending(path: "draft.json")))
            .flatMap { try? JSONDecoder().decode(Manifest.self, from: $0) }
        var uploadDates: [String: Date] = [:]
        for draft in snapshot.attachments where draft.state == .ready {
            guard let uploadID = draft.attachment?.id else { continue }
            // A new upload ID resets its lifetime; typing or relaunching does not.
            if let date = previous?.uploadedAt?[uploadID] { uploadDates[uploadID] = date }
            else if previous?.attachments.contains(where: { $0.attachment?.id == uploadID && $0.state == .ready }) != true {
                uploadDates[uploadID] = now
            }
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var retained = Set(["draft.json"])
        for draft in snapshot.attachments {
            let url = attachmentURL(draft.id)
            retained.insert(url.lastPathComponent)
            if let source = draft.localFileURL, !FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.copyItem(at: source, to: url)
            }
            if let data = snapshot.data[draft.id], !FileManager.default.fileExists(atPath: url.path) {
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        let metadata = snapshot.attachments.map { draft in
            var result = draft
            result.previewData = nil
            return result
        }
        let manifest = Manifest(text: snapshot.text, attachments: metadata,
            preparedSend: snapshot.preparedSend, preparedNewSend: snapshot.preparedNewSend, pendingQueuedEditRunID: snapshot.pendingQueuedEditRunID, uploadedAt: uploadDates)
        try JSONEncoder().encode(manifest).write(to: directory.appending(path: "draft.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        lastRevision = snapshot.revision
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where !retained.contains(url.lastPathComponent) {
            try FileManager.default.removeItem(at: url)
        }
    }

    func saveQueuedEdit(_ snapshot: PathwayConversationDraftSnapshot) throws -> PathwayConversationDraftSnapshot {
        try save(snapshot)
        guard let restored = load() else { throw CocoaError(.fileReadCorruptFile) }
        return restored
    }

    /// Retire the draft without loading its attachment bytes into memory.
    func discard() throws -> [String] {
        let manifest = (try? Data(contentsOf: directory.appending(path: "draft.json")))
            .flatMap { try? JSONDecoder().decode(Manifest.self, from: $0) }
        lastRevision = .max
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        return manifest?.attachments.compactMap { $0.attachment?.id } ?? []
    }

    private func attachmentURL(_ id: String) -> URL { directory.appending(path: Self.fileName(id) + ".data") }
    private static func fileName(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
