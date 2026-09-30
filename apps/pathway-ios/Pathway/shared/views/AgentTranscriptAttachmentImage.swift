import ImageIO
import SwiftUI
import UIKit

@MainActor
enum PathwayDecodedImageCache {
    static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()
    static func image(_ key: String) -> UIImage? { images.object(forKey: key as NSString) }
    static func store(_ image: UIImage, key: String) {
        images.setObject(image, forKey: key as NSString, cost: (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0))
    }
}

/// The transcript uses the same image presentation for saved files and remote attachments.
struct AgentTranscriptAttachmentImage<Content: View>: View {
    let url: URL
    let maximumPixelSize: Int
    @ViewBuilder let content: (AsyncImagePhase) -> Content
    @State private var savedImage: Image?
    @State private var readFailed = false

    private var cacheKey: String { "\(url.absoluteString):\(maximumPixelSize)" }
    private var availableImage: Image? { savedImage ?? PathwayDecodedImageCache.image(cacheKey).map { Image(uiImage: $0) } }

    var body: some View {
        Group {
            if url.isFileURL {
                if let availableImage {
                    content(.success(availableImage))
                } else if readFailed {
                    content(.failure(CocoaError(.fileReadUnknown)))
                } else {
                    content(.empty)
                }
            } else {
                AsyncImage(url: url) { phase in
                    if case .empty = phase, let savedImage {
                        content(.success(savedImage))
                    } else {
                        content(phase)
                    }
                }
            }
        }
        .task(id: url) {
            guard url.isFileURL, PathwayDecodedImageCache.image(cacheKey) == nil else { return }
            let sourceURL = url
            let pixelSize = maximumPixelSize
            // Decode here so the first draw does not decode on the main thread.
            let decoded = await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                          kCGImageSourceCreateThumbnailFromImageAlways: true,
                          kCGImageSourceCreateThumbnailWithTransform: true,
                          kCGImageSourceShouldCacheImmediately: true,
                          kCGImageSourceThumbnailMaxPixelSize: pixelSize
                      ] as CFDictionary) else { return UIImage?.none }
                return UIImage(cgImage: image)
            }.value
            guard !Task.isCancelled else { return }
            if let image = decoded {
                PathwayDecodedImageCache.store(image, key: cacheKey)
                savedImage = Image(uiImage: image)
                readFailed = false
            } else {
                readFailed = true
            }
        }
    }
}
