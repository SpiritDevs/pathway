#if DEBUG && !os(visionOS)
import AVFoundation
import SwiftUI

/// The production views with an isolated, in-memory cloud fixture. Never reads account data.
struct PathwayAssetsSimulatorScene: View {
    @State private var fixture = PathwayAssetReviewFixture()
    @State private var tab = "thread"
    var body: some View {
        TabView(selection: $tab) {
            Tab("Conversation", systemImage: "bubble.left", value: "thread") {
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            Text("Can you show me the new workspace design and a short review video?")
                                .padding().background(.quaternary, in: .rect(cornerRadius: 18)).frame(maxWidth: .infinity, alignment: .trailing)
                            Text("Here are the design and recording. Both originals are uploaded and available across your devices.")
                            if fixture.ready {
                                ForEach(fixture.records.prefix(2)) { asset in
                                    PathwayAssetReviewCard(asset: asset, fixture: fixture)
                                }
                            } else { ProgressView("Preparing sample media…") }
                            Text("Sample data · UI review").font(.caption).foregroundStyle(.secondary)
                        }.padding()
                    }.navigationTitle("Workspace review")
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { NavigationLink { PathwayAssetsView(companyID: "review-company", model: fixture.model) } label: { Label("Assets", systemImage: "paperclip") } } }
                }
            }
            Tab("Assets", systemImage: "photo.on.rectangle", value: "assets") {
                NavigationStack { PathwayAssetsView(companyID: "review-company", model: fixture.model) }
            }
        }.task { await fixture.prepareMedia() }
    }
}

private struct PathwayAssetReviewCard: View {
    let asset: PathwayAsset
    let fixture: PathwayAssetReviewFixture
    @State private var detail = false
    @State private var gallery = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            PathwayAssetMediaView(asset: asset, model: fixture.model, openGallery: { gallery = true })
            Button { detail = true } label: { Label(asset.name, systemImage: "paperclip").font(.caption) }
        }
        .sheet(isPresented: $detail) { PathwayAssetDetailView(asset: asset, model: fixture.model, gallery: fixture.records.filter(\.isMedia)) }
        .fullScreenCover(isPresented: $gallery) { PathwayAssetGallery(assets: fixture.records.filter(\.isMedia), selectedID: asset.id, model: fixture.model) }
    }
}

@MainActor @Observable
private final class PathwayAssetReviewFixture {
    var ready = false
    var values: [JSONValue] = []
    var records: [PathwayAsset] { values.compactMap { PathwayAsset($0, companyID: "review-company") } }
    let directory = FileManager.default.temporaryDirectory.appending(path: "AssetReview")
    @ObservationIgnored lazy var model = PathwayAssetsModel(mediaResolver: { [weak self] asset, _ in
        guard let self else { throw CancellationError() }
        return directory.appending(path: asset.kind == "video" ? "review.mp4" : "design.png")
    }, request: { [weak self] kind, name, arguments in
        guard let self else { throw CancellationError() }
        return try request(kind, name, arguments)
    })
    init() {
        values = [
            value("design", "Workspace design.png", "image", "image/png", 328_400),
            value("recording", "Workspace walkthrough.mp4", "video", "video/mp4", 1_203_240),
            value("brief", "Project brief.pdf", "document", "application/pdf", 24_830),
            value("pending", "Client review.mov", "video", "video/quicktime", 8_283_943, state: "preparing"),
            value("deleted", "Previous concept.png", "image", "image/png", 340_428, state: "trashed")
        ]
    }
    private func value(_ id: String, _ name: String, _ kind: String, _ mime: String, _ size: Int, state: String = "ready") -> JSONValue {
        .object(["id": .string(id), "name": .string(name), "kind": .string(kind), "mimeType": .string(mime), "byteSize": .number(Double(size)),
            "state": .string(state), "previewState": .string(state == "ready" ? "ready" : "pending"), "originalReady": .bool(true),
            "createdAt": .number(Date.now.timeIntervalSince1970 * 1000), "uploaderId": .string("Corey"), "keepInLibrary": .bool(false),
            "permissions": .object(["canManage": .bool(true), "canShare": .bool(true)]),
            "contexts": .array([.object(["kind": .string("thread"), "id": .string("review-thread"), "title": .string("Workspace review")])])])
    }
    private func request(_ kind: String, _ name: String, _ arguments: JSONValue) throws -> JSONValue {
        let args = arguments.objectValue ?? [:]
        if name == "assets:list" {
            let trashed = args["trashed"]?.boolValue ?? false
            let filter = args["kind"]?.stringValue
            let search = args["search"]?.stringValue ?? ""
            return .object(["items": .array(values.filter {
                guard let asset = PathwayAsset($0, companyID: "review-company") else { return false }
                return asset.isTrashed == trashed && (filter == nil || asset.kind == filter) && (search.isEmpty || asset.name.localizedCaseInsensitiveContains(search))
            }), "nextCursor": .null, "usage": .object(["usedBytes": .number(164_820_224), "reservedBytes": .number(0), "maxBytes": .number(10_737_418_240), "maxFileBytes": .number(262_144_000)])])
        }
        guard let id = args["assetId"]?.stringValue, let index = values.firstIndex(where: { $0.objectValue?["id"]?.stringValue == id }), var fields = values[index].objectValue else { throw URLError(.resourceUnavailable) }
        switch name {
        case "assets:rename": fields["name"] = args["name"]
        case "assets:trash": fields["state"] = .string("trashed")
        case "assets:restore": fields["state"] = .string("ready")
        case "assets:keep": fields["keepInLibrary"] = args["keep"]
        case "assets:share": throw PathwayIssueWriteError(message: "This is sample data. Share links are created only for real uploaded assets.")
        default: break
        }
        values[index] = .object(fields)
        return .object(fields)
    }
    func prepareMedia() async {
        guard !ready else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let image = UIGraphicsImageRenderer(size: CGSize(width: 960, height: 600)).image { ctx in
                UIColor.systemIndigo.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 960, height: 600))
                UIColor.white.setFill(); UIBezierPath(roundedRect: CGRect(x: 45, y: 45, width: 870, height: 510), cornerRadius: 28).fill()
                let title = "Your workspace, together" as NSString
                title.draw(at: CGPoint(x: 84, y: 88), withAttributes: [.font: UIFont.systemFont(ofSize: 38, weight: .bold), .foregroundColor: UIColor.label])
                ("Projects · Conversations · Assets" as NSString).draw(at: CGPoint(x: 84, y: 145), withAttributes: [.font: UIFont.systemFont(ofSize: 22), .foregroundColor: UIColor.secondaryLabel])
                for column in 0..<3 {
                    UIColor.systemIndigo.withAlphaComponent(0.09 + Double(column) * 0.03).setFill()
                    UIBezierPath(roundedRect: CGRect(x: 84 + column * 267, y: 210, width: 245, height: 278), cornerRadius: 18).fill()
                    (["Design", "Review", "Deliver"][column] as NSString).draw(at: CGPoint(x: 105 + column * 267, y: 242), withAttributes: [.font: UIFont.systemFont(ofSize: 27, weight: .semibold), .foregroundColor: UIColor.systemIndigo])
                }
            }
            try image.pngData()?.write(to: directory.appending(path: "design.png"))
            let video = directory.appending(path: "review.mp4")
            if !FileManager.default.fileExists(atPath: video.path) { try await Self.makeVideo(video) }
            ready = true
        } catch { model.error = error.localizedDescription }
    }
    private nonisolated static func makeVideo(_ url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 360])
        writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(10)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 640, 360, kCVPixelFormatType_32ARGB, nil, &buffer)
            guard let buffer else { throw URLError(.cannotCreateFile) }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: 640, height: 360, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) {
                context.setFillColor(CGColor(red: 0.23, green: 0.25, blue: 0.7, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
                context.setFillColor(CGColor(red: 0.96, green: 0.97, blue: 1, alpha: 1)); context.fill(CGRect(x: 36, y: 38, width: 568, height: 284))
                context.setFillColor(CGColor(red: 0.5, green: 0.55, blue: 0.9, alpha: 1)); context.fill(CGRect(x: 60, y: 75, width: 8 * (frame + 1), height: 195))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 20))
        }
        input.markAsFinished(); await writer.finishWriting()
        if let error = writer.error { throw error }
    }
}
#endif
