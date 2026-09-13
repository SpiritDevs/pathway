import SwiftUI
import AVKit

/// URLs are resolved per presentation. Stable asset IDs are the only persisted identity.
struct PathwayAssetMediaView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    let asset: PathwayAsset
    let model: PathwayAssetsModel
    var enlarged = false
    var openGallery: (() -> Void)? = nil
    @State private var url: URL?
    @State private var player: AVPlayer?
    @State private var error: String?
    @State private var attempt = 0
    @State private var playing = false
    @State private var poster: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if asset.isTrashed {
                Label("Asset deleted", systemImage: "trash").foregroundStyle(.secondary)
            } else if asset.previewState != "ready" {
                Label(asset.previewState == "unsupported" ? "Preview unavailable" : asset.previewState == "failed" ? "Preview failed" : asset.statusLabel,
                      systemImage: asset.icon)
                Text(asset.name).font(.caption).foregroundStyle(.secondary)
            } else if let url {
                if asset.kind == "image" {
                    Button { openGallery?() } label: {
                        AgentTranscriptAttachmentImage(url: url, maximumPixelSize: enlarged ? 2048 : 840) { phase in
                            switch phase {
                            case .success(let image):
                                PathwayAssetImageReveal(image: image, assetID: asset.id)
                                    .frame(maxWidth: .infinity)
                            case .failure: retry("This image could not be loaded.")
                            default: placeholder
                            }
                        }
                        .frame(height: enlarged ? nil : 210)
                    }.buttonStyle(.plain).disabled(openGallery == nil)
                } else if asset.kind == "video" || asset.kind == "audio" {
                    if playing, let player {
                        VideoPlayer(player: player)
                            .frame(height: asset.kind == "audio" ? 72 : enlarged ? 420 : 220)
                    } else {
                        Button {
                            let next = AVPlayer(url: url); player = next; playing = true; next.play()
                        } label: {
                            ZStack {
                                if let poster { Image(uiImage: poster).resizable().scaledToFill().frame(height: 190).clipped() }
                                VStack(spacing: 12) {
                                    Image(systemName: "play.circle.fill").font(.system(size: 44))
                                    Text(asset.name).font(.subheadline).lineLimit(2)
                                }.padding(12).background(.regularMaterial, in: .rect(cornerRadius: 12))
                            }.frame(maxWidth: .infinity).frame(height: asset.kind == "audio" ? 84 : 190)
                                .background(.quaternary, in: .rect(cornerRadius: 12))
                        }.buttonStyle(.plain).accessibilityLabel("Play \(asset.name)")
                    }
                    if let openGallery, asset.kind == "video" {
                        Button("Open gallery", systemImage: "arrow.up.left.and.arrow.down.right") { player?.pause(); openGallery() }.font(.caption)
                    }
                } else {
                    Label(asset.name, systemImage: asset.icon).lineLimit(2)
                }
            } else if let error { retry(error) }
            else { placeholder }
        }
        .frame(maxWidth: enlarged ? .infinity : 340)
        .clipShape(.rect(cornerRadius: 12))
        .task(id: "\(asset.id):\(asset.previewState):\(attempt)") {
            guard asset.previewState == "ready", !asset.isTrashed else { return }
            do {
                let resolved = try await model.resolve(asset); url = resolved; error = nil
                if asset.kind == "video" {
                    let thumbnail = await Task.detached(priority: .utility) {
                        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: resolved))
                        generator.appliesPreferredTrackTransform = true
                        generator.maximumSize = CGSize(width: 680, height: 440)
                        guard let result = try? await generator.image(at: .zero) else { return UIImage?.none }
                        return UIImage(cgImage: result.image)
                    }.value
                    if !Task.isCancelled { poster = thumbnail }
                }
            }
            catch { self.error = error.localizedDescription }
        }
        .onDisappear { player?.pause(); player = nil; playing = false }
        .onChange(of: asset.isTrashed) { _, trashed in
            if trashed { player?.pause(); player = nil; playing = false; url = nil }
        }
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemFailedToPlayToEndTime)) { notification in
            guard let item = notification.object as? AVPlayerItem, item === player?.currentItem else { return }
            player?.pause(); player = nil; playing = false; url = nil
            error = "Playback stopped. Retry to reconnect securely."
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { player?.pause() } }
        .onScrollVisibilityChange(threshold: 0.05) { visible in if !visible { player?.pause() } }
        .onChange(of: asset.id) { _, _ in player?.pause(); player = nil; playing = false; url = nil; poster = nil }
    }
    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 12).fill(.quaternary)
            .frame(height: asset.kind == "image" ? 210 : asset.kind == "video" ? 190 : 64)
            .overlay { ProgressView("Loading \(asset.name)").font(.caption) }
            .accessibilityLabel("Loading \(asset.name)")
    }
    private func retry(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("Retry", systemImage: "arrow.clockwise") { url = nil; error = nil; attempt += 1 }
        }.padding()
    }
}

struct PathwayAssetGallery: View {
    @Environment(\.dismiss) private var dismiss
    let assets: [PathwayAsset]
    let model: PathwayAssetsModel
    @State private var selectedID: String
    init(assets: [PathwayAsset], selectedID: String, model: PathwayAssetsModel) {
        self.assets = assets; self.model = model; _selectedID = State(initialValue: selectedID)
    }
    private var index: Int { assets.firstIndex { $0.id == selectedID } ?? 0 }
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let asset = assets.first(where: { $0.id == selectedID }) {
                    Spacer(minLength: 0)
                    PathwayAssetMediaView(asset: asset, model: model, enlarged: true).id(asset.id)
                    Spacer(minLength: 0)
                    HStack {
                        Button("Previous", systemImage: "chevron.left") { selectedID = assets[index - 1].id }.disabled(index == 0).keyboardShortcut(.leftArrow, modifiers: [])
                        Spacer()
                        Text("\(index + 1) of \(assets.count)").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Next", systemImage: "chevron.right") { selectedID = assets[index + 1].id }.disabled(index >= assets.count - 1).keyboardShortcut(.rightArrow, modifiers: [])
                    }
                    ScrollView(.horizontal) {
                        LazyHStack(spacing: 8) {
                            ForEach(assets) { item in
                                Button { selectedID = item.id } label: {
                                    VStack(spacing: 4) {
                                        PathwayGalleryThumbnail(asset: item, model: model)
                                        Text(item.name).font(.caption2).lineLimit(1)
                                    }.frame(width: 96).padding(6)
                                        .background(selectedID == item.id ? Color.accentColor.opacity(0.15) : .clear, in: .rect(cornerRadius: 8))
                                }.buttonStyle(.plain).accessibilityLabel("Show \(item.name)")
                            }
                        }
                    }.frame(height: 94)
                }
            }.padding().navigationTitle(assets.first { $0.id == selectedID }?.name ?? "Gallery")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .onChange(of: assets.isEmpty) { _, empty in if empty { dismiss() } }
    }
}

struct PathwayTranscriptAsset: View {
    @Environment(PathwayAppModel.self) private var appModel
    let assetID: String
    let companyID: String
    let threadID: String
    let environmentID: String
    @State private var asset: PathwayAsset?
    @State private var error: String?
    @State private var attempt = 0
    @State private var detail = false
    @State private var model: PathwayAssetsModel?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let asset, let model {
                PathwayAssetMediaView(asset: asset, model: model, openGallery: { detail = true })
                Button { detail = true } label: { Label(asset.name, systemImage: "paperclip").font(.caption).lineLimit(1) }.buttonStyle(.plain)
            } else if let error {
                Label(error, systemImage: "doc.badge.ellipsis").font(.caption).foregroundStyle(.secondary)
                Button("Retry") { attempt += 1 }
            } else { ProgressView("Loading asset…").font(.caption).frame(height: 100) }
        }
        .task(id: "\(assetID):\(attempt)") {
            model = PathwayAssetsModel { kind, name, args in try await appModel.cloud.request(kind: kind, name: name, arguments: args) }
            do {
                for try await value in appModel.cloud.subscribe(name: "assets:get", arguments: .object(["companyId": .string(companyID), "assetId": .string(assetID)])) {
                    asset = PathwayAsset(value, companyID: companyID)
                    error = asset == nil ? "Asset unavailable" : nil
                }
            } catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $detail) {
            if let asset, let model {
                PathwayAssetDetailView(asset: asset, model: model, gallery: ([asset] + model.items.filter { $0.isMedia && $0.id != asset.id }).sorted { $0.createdAt < $1.createdAt })
                    .task { await model.load(companyID: companyID, threadID: threadID, environmentID: environmentID) }
            }
        }
    }
}

private struct PathwayAssetImageReveal: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let image: Image
    let assetID: String
    @State private var visible = false
    private static var revealed: Set<String> = []
    var body: some View {
        image.resizable().scaledToFit()
            .opacity(visible || reduceMotion ? 1 : 0.25)
            .blur(radius: visible || reduceMotion ? 0 : 8)
            .onAppear {
                if reduceMotion || Self.revealed.contains(assetID) { visible = true }
                else {
                    if Self.revealed.count > 1000 { Self.revealed.removeAll(keepingCapacity: true) }
                    Self.revealed.insert(assetID)
                    withAnimation(.easeOut(duration: 0.28)) { visible = true }
                }
            }
    }
}

private struct PathwayGalleryThumbnail: View {
    let asset: PathwayAsset
    let model: PathwayAssetsModel
    @State private var url: URL?
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(.quaternary)
            if let url {
                AgentTranscriptAttachmentImage(url: url, maximumPixelSize: 192) { phase in
                    if case .success(let image) = phase { image.resizable().scaledToFill() }
                    else { Image(systemName: asset.icon).foregroundStyle(.secondary) }
                }
            } else { Image(systemName: asset.icon).foregroundStyle(.secondary) }
        }.frame(width: 90, height: 56).clipShape(.rect(cornerRadius: 6))
            .task(id: asset.id) { url = try? await model.resolve(asset, poster: asset.kind == "video") }
            .accessibilityHidden(true)
    }
}
