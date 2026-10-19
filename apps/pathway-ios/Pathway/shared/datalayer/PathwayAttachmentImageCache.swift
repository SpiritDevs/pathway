import CryptoKit
import Foundation
import ImageIO

/// Account-local image files survive transcript row recycling and connection changes.
actor PathwayAttachmentImageCache {
    static let shared = PathwayAttachmentImageCache()
    private let maximumBytes = 64 * 1024 * 1024

    func cachedURL(directory: URL, key: String) -> URL? {
        let file = location(directory: directory, key: key)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return file
    }

    func store(_ data: Data, directory: URL, key: String) throws -> URL {
        guard data.count <= 10 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else { throw CocoaError(.fileReadCorruptFile) }
        let file = location(directory: directory, key: key)
        let folder = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
            .map { ($0, try $0.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])) }
            .sorted { ($0.1.contentModificationDate ?? .distantPast) < ($1.1.contentModificationDate ?? .distantPast) }
        var total = files.reduce(0) { $0 + ($1.1.fileSize ?? 0) }
        for (url, values) in files where total > maximumBytes && url != file {
            try? FileManager.default.removeItem(at: url)
            total -= values.fileSize ?? 0
        }
        return file
    }

    private func location(directory: URL, key: String) -> URL {
        let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: "AttachmentImages").appending(path: name)
    }
}

@MainActor
enum PathwayAttachmentImageLocations {
    private static let urls = NSCache<NSString, NSURL>()
    static func key(directory: URL, image: String) -> NSString { "\(directory.path):\(image)" as NSString }
    static func cached(directory: URL, image: String) -> URL? {
        let key = key(directory: directory, image: image)
        guard let url = urls.object(forKey: key) as URL?, FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
    static func store(_ url: URL, directory: URL, image: String) {
        urls.countLimit = 256
        urls.setObject(url as NSURL, forKey: key(directory: directory, image: image))
    }
}
