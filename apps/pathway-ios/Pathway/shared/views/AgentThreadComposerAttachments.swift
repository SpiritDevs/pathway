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

struct AgentThreadComposerAttachmentChip: View {
    let attachment: PathwayThreadAttachmentDraft
    let remove: () -> Void
    let retry: () -> Void
    @State private var thumbnail: UIImage?

    @State private var showsFailure = false

    var body: some View {
        Group {
            if attachment.type == "image" {
                preview
                    .frame(width: 76, height: 76)
                    .background(.quaternary)
                    .clipShape(.rect(cornerRadius: 14))
                    .overlay(alignment: .topTrailing) { attachmentAction }
                    .overlay(alignment: .bottomLeading) {
                        if attachment.state == .uploading {
                            ProgressView().controlSize(.small)
                                .padding(6).background(.regularMaterial, in: Circle()).padding(5)
                                .accessibilityLabel("Uploading \(attachment.name)")
                        }
                    }
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                    Text(attachment.name).font(.subheadline).lineLimit(1).frame(maxWidth: 160)
                    if attachment.state == .uploading { ProgressView().controlSize(.small) }
                    attachmentAction
                }
                .padding(.leading, 12)
                .background(.quaternary, in: Capsule())
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("agent-thread-draft-attachment-\(attachment.id)")
        .alert("Upload failed", isPresented: $showsFailure) {
            Button("Retry", action: retry)
            Button("Cancel", role: .cancel, action: remove)
        } message: {
            Text(failureReason)
        }
        .task(id: attachment.id) {
            guard let data = attachment.previewData else { return }
            let thumbnailData = await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 228
                      ] as CFDictionary) else { return Data?.none }
                return UIImage(cgImage: image).jpegData(compressionQuality: 0.8)
            }.value
            guard !Task.isCancelled, let thumbnailData else { return }
            thumbnail = UIImage(data: thumbnailData)
        }
    }

    private var preview: some View {
        Group {
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Image(systemName: "photo").font(.title2).foregroundStyle(.secondary)
            }
        }
        .accessibilityHidden(true)
    }

    private var attachmentAction: some View {
        Button {
            if case .failed = attachment.state { showsFailure = true }
            else { remove() }
        } label: {
            Image(systemName: failed ? "arrow.clockwise" : "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(failed ? Color.orange : Color.black.opacity(0.55), in: Circle())
                .frame(width: 44, height: 44, alignment: attachment.type == "image" ? .topTrailing : .center)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("\(failed ? "Retry" : "Remove") \(attachment.name)")
        .accessibilityHint(failed ? "Shows why the upload failed and lets you retry or cancel" : "")
    }

    private var failureReason: String {
        if case .failed(let reason) = attachment.state { return reason }
        return "The attachment could not be uploaded."
    }

    private var failed: Bool {
        if case .failed = attachment.state { return true }
        return false
    }

}
