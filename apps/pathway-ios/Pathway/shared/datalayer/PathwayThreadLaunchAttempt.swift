import CryptoKit
import Foundation

/// A launch is identified before its first attachment write and keeps that identity after
/// a lost response. Changing the draft starts a different operation.
struct PathwayThreadLaunchAttempt: Codable, Equatable, Sendable {
    let fingerprint: JSONValue
    let identifier: String
    let threadID: String
    var attachments: [JSONValue]?

    init(fingerprint: JSONValue) {
        self.fingerprint = fingerprint
        identifier = UUID().uuidString.lowercased()
        threadID = UUID().uuidString.lowercased()
    }

    func launchPayload() -> JSONValue {
        var payload = fingerprint.objectValue ?? [:]
        payload.removeValue(forKey: "uploadsFingerprint")
        payload["commandId"] = .string(identifier)
        payload["threadId"] = .string(threadID)
        var message = payload["initialMessage"]?.objectValue ?? [:]
        message["messageId"] = .string(identifier)
        message["attachments"] = .array(attachments ?? [])
        payload["initialMessage"] = .object(message)
        return .object(payload)
    }
}

struct PathwayThreadCreationDraft: Codable, Sendable {
    var prompt: String
    var initialImageUploads: [JSONValue]
    var selectedProviderID: String
    var selectedModelID: String
    var optionValues: [String: JSONValue]
    var runtimeMode: String
    var interactionMode: String
    var workspaceMode: String
    var baseReference: String
    var branch: String
    var startFromOrigin: Bool
    var attempt: PathwayThreadLaunchAttempt?
    var sentAttachmentIDs: [String]? = nil
    var importedCaptureIDs: [UUID]? = nil
}

actor PathwayThreadCreationDraftStore {
    private struct Manifest: Codable {
        let draft: PathwayThreadCreationDraft
        let uploadsFile: String
    }
    private let directory: URL
    private var lastRevision: UInt64 = 0
    private var lastUploads: [JSONValue]?
    private var lastUploadsFile: String?

    init(directory: URL, key: String) {
        let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        self.directory = directory.appending(path: "ThreadCreationDrafts").appending(path: name)
    }

    func load() -> PathwayThreadCreationDraft? {
        guard let data = try? Data(contentsOf: directory.appending(path: "draft.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              let bytes = try? Data(contentsOf: directory.appending(path: manifest.uploadsFile)),
              let uploads = try? JSONDecoder().decode([JSONValue].self, from: bytes) else { return nil }
        var draft = manifest.draft
        draft.initialImageUploads = uploads
        lastUploads = uploads
        lastUploadsFile = manifest.uploadsFile
        return draft
    }

    func save(_ draft: PathwayThreadCreationDraft, revision: UInt64) throws {
        guard revision >= lastRevision else { return }
        lastRevision = revision
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if lastUploads != draft.initialImageUploads || lastUploadsFile == nil {
            let bytes = try JSONEncoder().encode(draft.initialImageUploads)
            let name = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() + ".uploads"
            try bytes.write(to: directory.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            lastUploads = draft.initialImageUploads
            lastUploadsFile = name
        }
        guard let uploadsFile = lastUploadsFile else { return }
        // Text edits write only metadata. The manifest points to immutable attachment bytes,
        // so interruption between the two writes cannot mix old and new drafts.
        var metadata = draft
        metadata.initialImageUploads = []
        try JSONEncoder().encode(Manifest(draft: metadata, uploadsFile: uploadsFile)).write(
            to: directory.appending(path: "draft.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.lastPathComponent != "draft.json" && url.lastPathComponent != uploadsFile {
            try FileManager.default.removeItem(at: url)
        }
    }
}
