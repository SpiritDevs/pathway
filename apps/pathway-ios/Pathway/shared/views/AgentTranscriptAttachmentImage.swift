import ImageIO
import SwiftUI
import UIKit

/// The transcript uses the same image presentation for saved files and remote attachments.
struct AgentTranscriptAttachmentImage<Content: View>: View {
    let url: URL
    let maximumPixelSize: Int
    @ViewBuilder let content: (AsyncImagePhase) -> Content
    @State private var savedImage: Image?
    @State private var readFailed = false

    var body: some View {
        Group {
            if url.isFileURL {
                if let savedImage {
                    content(.success(savedImage))
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
            guard url.isFileURL else { return }
            let sourceURL = url
            let pixelSize = maximumPixelSize
            let data = await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                          kCGImageSourceCreateThumbnailFromImageAlways: true,
                          kCGImageSourceCreateThumbnailWithTransform: true,
                          kCGImageSourceThumbnailMaxPixelSize: pixelSize
                      ] as CFDictionary) else { return Data?.none }
                return UIImage(cgImage: image).pngData()
            }.value
            guard !Task.isCancelled else { return }
            if let data, let image = UIImage(data: data) {
                savedImage = Image(uiImage: image)
                readFailed = false
            } else {
                readFailed = true
            }
        }
    }
}
