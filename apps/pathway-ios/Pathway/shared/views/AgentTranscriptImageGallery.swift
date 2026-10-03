import Photos
import SwiftUI
import UIKit

/// Full-screen pager for a message's images, with save, share, copy and the image editor.
struct AgentTranscriptImageGallery: View {
    let attachments: [PathwayMessageAttachment]
    let model: PathwayAgentThreadModel
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String
    @State private var urls: [String: URL]
    @State private var edits: [String: URL] = [:]
    @State private var editing: EditorRequest?
    @State private var notice: String?

    private struct EditorRequest: Identifiable {
        let attachmentID: String
        let url: URL
        let tool: AgentImageEditorTool
        var id: String { "\(attachmentID):\(tool.rawValue)" }
    }

    init(attachments: [PathwayMessageAttachment], model: PathwayAgentThreadModel, initialID: String, initialURL: URL?) {
        self.attachments = attachments
        self.model = model
        _selection = State(initialValue: initialID)
        _urls = State(initialValue: initialURL.map { [initialID: $0] } ?? [:])
    }

    private var currentURL: URL? { edits[selection] ?? urls[selection] }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(attachments) { attachment in
                    AgentGalleryPage(attachment: attachment, model: model, url: edits[attachment.id] ?? urls[attachment.id]) { urls[attachment.id] = $0 }
                        .tag(attachment.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            VStack {
                topBar
                Spacer()
                if let notice {
                    Text(notice).font(.subheadline).padding(.horizontal, 14).padding(.vertical, 8)
                        .glassEffect(.regular, in: .capsule).padding(.bottom, 8)
                }
                bottomBar
            }
            .padding(.horizontal, 16)
        }
        .preferredColorScheme(.dark)
        .task(id: notice) {
            guard notice != nil else { return }
            try? await Task.sleep(for: .seconds(2))
            notice = nil
        }
        .fullScreenCover(item: $editing) { request in
            AgentImageEditor(sourceURL: request.url, tool: request.tool) { edited in
                if let previous = edits[request.attachmentID] { try? FileManager.default.removeItem(at: previous) }
                edits[request.attachmentID] = edited
            }
        }
        .onDisappear { edits.values.forEach { try? FileManager.default.removeItem(at: $0) } }
        .accessibilityIdentifier("transcript-image-gallery")
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            circleButton("Close", icon: "xmark") { dismiss() }
                .accessibilityIdentifier("transcript-image-gallery-close")
            Spacer()
            VStack(spacing: 4) {
                if attachments.count > 1 {
                    Text("\((attachments.firstIndex { $0.id == selection } ?? 0) + 1) of \(attachments.count)")
                        .font(.subheadline.weight(.semibold)).monospacedDigit()
                }
                if edits[selection] != nil {
                    Button("Revert edits") {
                        if let edited = edits.removeValue(forKey: selection) { try? FileManager.default.removeItem(at: edited) }
                    }.font(.caption).buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            Spacer()
            circleButton("Copy", icon: "doc.on.doc") { copy() }.disabled(currentURL == nil)
            if let currentURL {
                ShareLink(item: currentURL) { circleLabel("square.and.arrow.up") }
                    .buttonStyle(.plain).accessibilityLabel("Share")
            }
            circleButton("Save to Photos", icon: "arrow.down.to.line") { save() }
                .disabled(currentURL == nil)
                .accessibilityIdentifier("transcript-image-gallery-save")
        }
        .padding(.top, 8)
    }

    private var bottomBar: some View {
        HStack(spacing: 22) {
            toolButton("Edit", icon: "pencil.tip.crop.circle", tool: .pen)
            toolButton("Crop", icon: "crop", tool: .crop)
            toolButton("Resize", icon: "arrow.up.left.and.arrow.down.right", tool: .resize)
            toolButton("Remove", icon: "eraser", tool: .remove)
        }
        .padding(.bottom, 8)
        .disabled(currentURL == nil)
    }

    private func toolButton(_ title: String, icon: String, tool: AgentImageEditorTool) -> some View {
        Button {
            if let currentURL { editing = EditorRequest(attachmentID: selection, url: currentURL, tool: tool) }
        } label: {
            VStack(spacing: 6) {
                circleLabel(icon, size: 56)
                Text(title).font(.caption)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("transcript-image-gallery-\(title.lowercased())")
    }

    private func circleButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { circleLabel(icon) }.buttonStyle(.plain).accessibilityLabel(title)
    }

    private func circleLabel(_ icon: String, size: CGFloat = 44) -> some View {
        Image(systemName: icon).font(.body.weight(.medium)).frame(width: size, height: size)
            .glassEffect(.regular.interactive(), in: .circle)
    }

    private func copy() {
        guard let currentURL else { return }
        Task {
            do {
                guard let image = UIImage(data: try await AgentImageData.load(currentURL)) else { throw CocoaError(.fileReadCorruptFile) }
                UIPasteboard.general.image = image
                notice = "Copied image"
            } catch { notice = error.localizedDescription }
        }
    }

    private func save() {
        guard let currentURL else { return }
        Task {
            do {
                let data = try await AgentImageData.load(currentURL)
                let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
                guard status == .authorized || status == .limited else {
                    throw PathwayThreadConversationError.message("Allow Pathway to add photos in Settings.")
                }
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
                }
                notice = "Saved to Photos"
            } catch { notice = error.localizedDescription }
        }
    }
}

/// One zoomable page. Only the gallery decodes images at screen-filling resolution.
private struct AgentGalleryPage: View {
    let attachment: PathwayMessageAttachment
    let model: PathwayAgentThreadModel
    let url: URL?
    let onLoad: (URL) -> Void
    @State private var zoom: CGFloat = 1
    @State private var baseZoom: CGFloat = 1
    @State private var failure: String?
    @State private var attempt = 0

    var body: some View {
        GeometryReader { geometry in
            if let url {
                ScrollView(zoom > 1 ? [.horizontal, .vertical] : []) {
                    AgentTranscriptAttachmentImage(url: url, maximumPixelSize: 2_560) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                                .frame(width: geometry.size.width * zoom, height: geometry.size.height * zoom)
                                .onTapGesture(count: 2) { withAnimation(.snappy) { zoom = zoom > 1 ? 1 : 2.5 }; baseZoom = zoom }
                                .gesture(MagnifyGesture().onChanged { value in
                                    zoom = min(5, max(1, baseZoom * value.magnification))
                                }.onEnded { _ in baseZoom = zoom })
                                .accessibilityLabel(attachment.name)
                        case .failure:
                            unavailable("This image couldn’t be loaded.").frame(width: geometry.size.width, height: geometry.size.height)
                        default:
                            ProgressView().frame(width: geometry.size.width, height: geometry.size.height)
                        }
                    }
                    .id(url)
                }
                .scrollIndicators(.hidden)
                .defaultScrollAnchor(.center)
            } else if let failure {
                unavailable(failure).frame(width: geometry.size.width, height: geometry.size.height)
            } else {
                ProgressView().frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
        .task(id: attempt) {
            guard url == nil else { return }
            do {
                let loaded: URL
                if let cached = model.cachedAttachmentImageURL(attachment.id) { loaded = cached }
                else { loaded = try await model.attachmentURL(attachment) }
                guard !Task.isCancelled else { return }
                failure = nil
                onLoad(loaded)
            } catch {
                guard !Task.isCancelled else { return }
                failure = error.localizedDescription
            }
        }
    }

    private func unavailable(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Image unavailable", systemImage: "photo")
        } description: { Text(message) } actions: {
            Button("Retry") { failure = nil; attempt += 1 }
        }
    }
}
