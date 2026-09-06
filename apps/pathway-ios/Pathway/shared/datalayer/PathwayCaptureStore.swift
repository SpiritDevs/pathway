import Foundation

struct PathwayCapturedDraft: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let accountKey: String
    let prompt: String
    let createdAt: Date
    let attachments: [Attachment]

    struct Attachment: Codable, Identifiable, Equatable, Sendable {
        let id: UUID
        let name: String
        let mimeType: String
        let sizeBytes: Int
    }
}

struct PathwayCaptureFile: Sendable {
    let url: URL
    let name: String
    let mimeType: String
}

enum PathwayCaptureError: LocalizedError {
    case signIn, accountChanged, invalidInput, unavailable, missingFile
    var errorDescription: String? {
        switch self {
        case .signIn: "Open Pathway and sign in before saving a shared draft."
        case .accountChanged: "The Pathway account changed. Open the share sheet again to save to the current account."
        case .invalidInput: "Share up to 8 files, 50 MB per file (10 MB per image), 100 MB total, and 120,000 characters."
        case .unavailable: "Shared drafts are unavailable in this build."
        case .missingFile: "A shared attachment is missing. Share the file again."
        }
    }
}

/// Shared with the extension. Only an opaque account namespace is published; credentials never enter the group.
actor PathwayCaptureStore {
    static let groupID = "group.com.spiritdevs.pathway.shared"
    static func shared() -> PathwayCaptureStore? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID).map { PathwayCaptureStore(directory: $0.appending(path: "CaptureInbox")) }
    }
    let directory: URL
    init(directory: URL) { self.directory = directory }

    func setActiveAccount(_ key: String?) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let descriptor = directory.appending(path: "account.json")
        guard let key else {
            if FileManager.default.fileExists(atPath: descriptor.path) { try FileManager.default.removeItem(at: descriptor) }
            return
        }
        guard Self.validAccountKey(key) else { throw PathwayCaptureError.invalidInput }
        try JSONEncoder().encode(key).write(to: descriptor, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func activeAccount() throws -> String {
        guard let data = try? Data(contentsOf: directory.appending(path: "account.json")),
              let key = try? JSONDecoder().decode(String.self, from: data), Self.validAccountKey(key) else { throw PathwayCaptureError.signIn }
        return key
    }

    func save(prompt: String, files: [PathwayCaptureFile], accountKey: String) throws -> PathwayCapturedDraft {
        guard try activeAccount() == accountKey else { throw PathwayCaptureError.accountChanged }
        guard prompt.count <= 120_000, files.count <= 8, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty else { throw PathwayCaptureError.invalidInput }
        let id = UUID()
        let account = try accountDirectory(accountKey)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let draftDirectory = account.appending(path: id.uuidString)
        try FileManager.default.createDirectory(at: draftDirectory, withIntermediateDirectories: true)
        do {
            var total = 0
            let attachments = try files.map { file -> PathwayCapturedDraft.Attachment in
                let values = try file.url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                let size = values.fileSize ?? 0
                let limit = file.mimeType.hasPrefix("image/") ? 10 * 1024 * 1024 : 50 * 1024 * 1024
                total += size
                guard values.isRegularFile == true, size > 0, size <= limit, total <= 100 * 1024 * 1024 else { throw PathwayCaptureError.invalidInput }
                let attachment = PathwayCapturedDraft.Attachment(id: UUID(), name: String(file.name.prefix(255)), mimeType: file.mimeType, sizeBytes: size)
                let target = draftDirectory.appending(path: attachment.id.uuidString)
                try FileManager.default.copyItem(at: file.url, to: target)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
                return attachment
            }
            guard try activeAccount() == accountKey else { throw PathwayCaptureError.accountChanged }
            let draft = PathwayCapturedDraft(id: id, accountKey: accountKey, prompt: prompt, createdAt: Date(), attachments: attachments)
            try JSONEncoder().encode(draft).write(to: draftDirectory.appending(path: "draft.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return draft
        } catch {
            try? FileManager.default.removeItem(at: draftDirectory)
            throw error
        }
    }

    func drafts(accountKey: String) throws -> [PathwayCapturedDraft] {
        guard try activeAccount() == accountKey else { throw PathwayCaptureError.accountChanged }
        let account = try accountDirectory(accountKey)
        guard FileManager.default.fileExists(atPath: account.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: account, includingPropertiesForKeys: nil).compactMap { directory in
            guard UUID(uuidString: directory.lastPathComponent) != nil,
                  let data = try? Data(contentsOf: directory.appending(path: "draft.json")),
                  let draft = try? JSONDecoder().decode(PathwayCapturedDraft.self, from: data),
                  draft.accountKey == accountKey, draft.id.uuidString == directory.lastPathComponent else { return nil }
            return draft
        }.sorted { $0.createdAt < $1.createdAt }
    }

    func data(for attachment: PathwayCapturedDraft.Attachment, in draft: PathwayCapturedDraft) throws -> Data {
        guard try activeAccount() == draft.accountKey else { throw PathwayCaptureError.accountChanged }
        let url = try accountDirectory(draft.accountKey).appending(path: draft.id.uuidString).appending(path: attachment.id.uuidString)
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size == attachment.sizeBytes, size <= 50 * 1024 * 1024 else { throw PathwayCaptureError.missingFile }
        return try Data(contentsOf: url)
    }

    func remove(_ draft: PathwayCapturedDraft) throws {
        guard try activeAccount() == draft.accountKey else { throw PathwayCaptureError.accountChanged }
        let url = try accountDirectory(draft.accountKey).appending(path: draft.id.uuidString)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    private func accountDirectory(_ key: String) throws -> URL {
        guard Self.validAccountKey(key) else { throw PathwayCaptureError.invalidInput }
        return directory.appending(path: "Accounts").appending(path: key)
    }
    private static func validAccountKey(_ key: String) -> Bool {
        !key.isEmpty && key.count <= 128 && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}
