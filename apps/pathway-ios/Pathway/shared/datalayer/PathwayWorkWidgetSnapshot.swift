import Foundation

struct PathwayWorkWidgetSnapshot: Codable, Equatable, Sendable {
    let accountKey: String
    let runningCount: Int
    let attentionCount: Int
    let updatedAt: Date

    var isValid: Bool {
        !accountKey.isEmpty && accountKey.count <= 256 && runningCount >= 0 && attentionCount >= 0
            && updatedAt.timeIntervalSince1970.isFinite
    }
}

enum PathwayWorkWidgetDestination: String, Sendable {
    case running, attention, draft
    var url: URL { URL(string: "pathway://work/\(rawValue)")! }
}

/// Only the app writes. A session lease prevents an older account's asynchronous result from
/// republishing after sign-out. The extension reads one atomic, active-account envelope.
@MainActor
final class PathwayWorkWidgetStore {
    nonisolated static let kind = "PathwayWorkSummary"
    nonisolated static let groupID = "group.com.spiritdevs.pathway.shared"
    nonisolated static var sharedDirectory: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID)?
            .appending(path: "WorkWidget", directoryHint: .isDirectory)
    }
    static func shared() -> PathwayWorkWidgetStore? {
        sharedDirectory.map { PathwayWorkWidgetStore(directory: $0) }
    }

    let directory: URL
    private var accountKey: String?
    private var session: UUID?
    private var lastUpdatedAt: Date?

    init(directory: URL) { self.directory = directory }

    @discardableResult
    func configure(accountKey: String?) throws -> UUID? {
        // Invalidate in-memory writers even if clearing the on-disk snapshot fails.
        session = nil
        self.accountKey = nil
        lastUpdatedAt = nil
        let file = directory.appending(path: "snapshot.json")
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        guard let accountKey else { return nil }
        guard !accountKey.isEmpty, accountKey.count <= 256 else { throw CocoaError(.fileWriteInvalidFileName) }
        let newSession = UUID()
        self.accountKey = accountKey
        session = newSession
        return newSession
    }

    @discardableResult
    func publish(runningCount: Int, attentionCount: Int, updatedAt: Date, session: UUID) throws -> Bool {
        guard self.session == session, let accountKey else { return false }
        guard lastUpdatedAt.map({ updatedAt >= $0 }) ?? true else { return false }
        let snapshot = PathwayWorkWidgetSnapshot(accountKey: accountKey, runningCount: runningCount,
                                                attentionCount: attentionCount, updatedAt: updatedAt)
        guard snapshot.isValid, updatedAt <= Date().addingTimeInterval(300) else { throw CocoaError(.coderInvalidValue) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(snapshot).write(to: directory.appending(path: "snapshot.json"),
                                                 options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        lastUpdatedAt = updatedAt
        return true
    }

    nonisolated static func read(directory: URL?) -> PathwayWorkWidgetSnapshot? {
        guard let directory else { return nil }
        let file = directory.appending(path: "snapshot.json")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 16_384,
              let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(PathwayWorkWidgetSnapshot.self, from: data),
              snapshot.isValid, snapshot.updatedAt <= Date().addingTimeInterval(300) else { return nil }
        return snapshot
    }
}
