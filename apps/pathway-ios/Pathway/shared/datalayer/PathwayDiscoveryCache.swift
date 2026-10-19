import Foundation

actor PathwayDiscoveryCache {
    struct Snapshot: Codable, Sendable {
        let companies: [PathwayCompany]
        let entities: [String: [PathwaySyncChange]]
        let versions: [String: Int]
        let savedAt: Date
    }

    private let file: URL
    private var latestRevision: UInt64 = 0

    init(directory: URL) {
        file = directory.appending(path: "Discovery.json")
    }

    func load() -> Snapshot? {
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 32 * 1024 * 1024,
              let data = try? Data(contentsOf: file), data.count <= 32 * 1024 * 1024,
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.savedAt.timeIntervalSinceNow > -30 * 24 * 60 * 60 else { return nil }
        return snapshot
    }

    func save(_ snapshot: Snapshot, revision: UInt64) {
        guard revision >= latestRevision else { return }
        latestRevision = revision
        do {
            let data = try JSONEncoder().encode(snapshot)
            guard data.count <= 32 * 1024 * 1024 else { return }
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var directory = file.deletingLastPathComponent()
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
        } catch {
            // Discovery remains usable online if a full disk prevents refreshing its offline copy.
        }
    }
}
