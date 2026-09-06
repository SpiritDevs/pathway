import ImageIO
import SwiftUI
import UIKit

struct AgentThreadComposerAttachments: View {
    @Bindable var model: PathwayAgentThreadModel

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(model.draftAttachments) { attachment in
                    AgentThreadComposerAttachmentChip(attachment: attachment,
                        remove: { Task { await model.removeAttachment(id: attachment.id) } },
                        retry: { Task { await model.retryAttachment(id: attachment.id) } })
                }
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("agent-thread-draft-attachments")
    }
}

private struct AgentThreadComposerAttachmentChip: View {
    let attachment: PathwayThreadAttachmentDraft
    let remove: () -> Void
    let retry: () -> Void
    @State private var thumbnail: UIImage?

    var body: some View {
        HStack(spacing: 7) {
            Group {
                if let thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Image(systemName: attachment.type == "image" ? "photo" : "doc.text")
                        .font(.title3).foregroundStyle(.secondary)
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(.rect(cornerRadius: 6))
            .accessibilityHidden(true)
            Text(attachment.name).font(.subheadline).lineLimit(1).frame(maxWidth: 160)
            switch attachment.state {
            case .uploading:
                ProgressView().controlSize(.small).accessibilityLabel("Uploading")
            case .failed(let message):
                Button(action: retry) { Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.orange) }
                    .accessibilityLabel("Retry \(attachment.name)")
                    .accessibilityHint(message)
            case .ready: EmptyView()
            }
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    .frame(width: 28, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .buttonStyle(.plain)
        .padding(.leading, 7)
        .padding(.trailing, 3)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())
        .accessibilityIdentifier("agent-thread-draft-attachment-\(attachment.id)")
        .task(id: attachment.id) {
            guard let data = attachment.previewData else { return }
            let thumbnailData = await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 96
                      ] as CFDictionary) else { return Data?.none }
                return UIImage(cgImage: image).jpegData(compressionQuality: 0.8)
            }.value
            guard !Task.isCancelled, let thumbnailData else { return }
            thumbnail = UIImage(data: thumbnailData)
        }
    }
}
