import Foundation
import UIKit
@testable import Pathway
import Testing

struct PathwayAttachmentImageCacheTests {
    @Test @MainActor func imageSurvivesReopeningWithoutNetworkAndIsAccountScoped() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let data = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
        }.pngData()!
        let first = PathwayAttachmentImageCache()
        let stored = try await first.store(data, directory: directory, key: "company:environment:thread:image")
        let reopened = PathwayAttachmentImageCache()
        #expect(await reopened.cachedURL(directory: directory, key: "company:environment:thread:image") == stored)
        #expect(try Data(contentsOf: stored) == data)
        #expect(await reopened.cachedURL(directory: directory, key: "other:environment:thread:image") == nil)
        #expect(await reopened.cachedURL(directory: directory.appending(path: "another-account"), key: "company:environment:thread:image") == nil)
    }

    @Test func invalidImageDoesNotPoisonCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = PathwayAttachmentImageCache()
        await #expect(throws: (any Error).self) { try await cache.store(Data("expired access".utf8), directory: directory, key: "image") }
        #expect(await cache.cachedURL(directory: directory, key: "image") == nil)
    }
}
