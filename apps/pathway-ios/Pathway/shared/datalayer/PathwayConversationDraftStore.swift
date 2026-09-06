import CryptoKit
import Foundation

struct PathwayConversationDraftSnapshot: Sendable {
    let text: String
    let attachments: [PathwayThreadAttachmentDraft]
    let data: [String: Data]
    let preparedSend: PathwayThreadPreparedSend?
    let preparedNewSend: PathwayThreadPreparedNewSend?
    let revision: UInt64
}

/// Keeps attachment bytes out of text-edit writes and scopes every file to one account and thread.
actor PathwayConversationDraftStore {
    private struct Manifest: Codable {
        let text: String
        let attachments: [PathwayThreadAttachmentDraft]
        let preparedSend: PathwayThreadPreparedSend?
        let preparedNewSend: PathwayThreadPreparedNewSend?
    }

    private let directory: URL
    private var lastRevision: UInt64 = 0

    init(directory: URL, key: String) {
        self.directory = directory.appending(path: Self.fileName(key), directoryHint: .isDirectory)
    }

    func load() -> PathwayConversationDraftSnapshot? {
        guard let encoded = try? Data(contentsOf: directory.appending(path: "draft.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: encoded) else { return nil }
        var data: [String: Data] = [:]
        let attachments = manifest.attachments.map { attachment in
            var draft = attachment
            if let bytes = try? Data(contentsOf: attachmentURL(draft.id)) {
                data[draft.id] = bytes
                draft.previewData = draft.type == "image" ? bytes : nil
            }
            if draft.state == .uploading {
                draft.state = .failed("Upload interrupted. Tap retry to finish preparing this attachment.")
            }
            return draft
        }
        return PathwayConversationDraftSnapshot(text: manifest.text, attachments: attachments, data: data,
            preparedSend: manifest.preparedSend, preparedNewSend: manifest.preparedNewSend, revision: 0)
    }

    func save(_ snapshot: PathwayConversationDraftSnapshot) throws {
        guard snapshot.revision >= lastRevision else { return }
        lastRevision = snapshot.revision
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var retained = Set(["draft.json"])
        for draft in snapshot.attachments {
            let url = attachmentURL(draft.id)
            retained.insert(url.lastPathComponent)
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
            preparedSend: snapshot.preparedSend, preparedNewSend: snapshot.preparedNewSend)
        try JSONEncoder().encode(manifest).write(to: directory.appending(path: "draft.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where !retained.contains(url.lastPathComponent) {
            try FileManager.default.removeItem(at: url)
        }
    }

    private func attachmentURL(_ id: String) -> URL { directory.appending(path: Self.fileName(id) + ".data") }
    private static func fileName(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
