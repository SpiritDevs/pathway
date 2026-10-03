import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

enum AgentImageEditorTool: String, CaseIterable, Identifiable {
    case pen, arrow, box, text, remove, crop, resize
    var id: String { rawValue }
    var title: String {
        switch self {
        case .pen: "Draw"
        case .arrow: "Arrow"
        case .box: "Box"
        case .text: "Text"
        case .remove: "Remove"
        case .crop: "Crop"
        case .resize: "Resize"
        }
    }
    var icon: String {
        switch self {
        case .pen: "scribble"
        case .arrow: "arrow.up.right"
        case .box: "square"
        case .text: "textformat"
        case .remove: "eraser"
        case .crop: "crop"
        case .resize: "arrow.up.left.and.arrow.down.right"
        }
    }
    var annotates: Bool { self != .crop && self != .resize }
}

/// One annotation in image pixel coordinates. Marks stay vectors until the editor exports.
struct AgentImageMark: Identifiable, Sendable {
    enum Kind: Sendable { case pen, arrow, box, text(String), pixelate }
    let id = UUID()
    var kind: Kind
    var points: [CGPoint]
    var color: UIColor
    var width: CGFloat

    var isPixelate: Bool { if case .pixelate = kind { true } else { false } }

    var strokePath: CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        path.move(to: first)
        points.dropFirst().forEach { path.addLine(to: $0) }
        if points.count == 1 { path.addLine(to: first) }
        return path
    }

    /// Draws into a y-down context already scaled to image pixels. Pixelated strokes go first so annotations stay visible.
    static func draw(_ marks: [AgentImageMark], pixelated: UIImage?, in cg: CGContext) {
        UIGraphicsPushContext(cg)
        defer { UIGraphicsPopContext() }
        if let pixelated {
            for mark in marks where mark.isPixelate {
                cg.saveGState()
                cg.addPath(mark.strokePath.copy(strokingWithWidth: mark.width, lineCap: .round, lineJoin: .round, miterLimit: 1))
                cg.clip()
                pixelated.draw(in: CGRect(origin: .zero, size: pixelated.size))
                cg.restoreGState()
            }
        }
        for mark in marks where !mark.isPixelate { mark.drawAnnotation(in: cg) }
    }

    private func drawAnnotation(in cg: CGContext) {
        cg.setStrokeColor(color.cgColor)
        cg.setFillColor(color.cgColor)
        cg.setLineWidth(width)
        cg.setLineCap(.round)
        cg.setLineJoin(.round)
        switch kind {
        case .pen:
            cg.addPath(strokePath); cg.strokePath()
        case .arrow:
            guard let start = points.first, let end = points.last else { return }
            let angle = atan2(end.y - start.y, end.x - start.x), head = width * 4.5
            cg.move(to: start); cg.addLine(to: end); cg.strokePath()
            cg.move(to: CGPoint(x: end.x + cos(angle) * width, y: end.y + sin(angle) * width))
            cg.addLine(to: CGPoint(x: end.x - cos(angle - .pi / 7) * head, y: end.y - sin(angle - .pi / 7) * head))
            cg.addLine(to: CGPoint(x: end.x - cos(angle + .pi / 7) * head, y: end.y - sin(angle + .pi / 7) * head))
            cg.closePath(); cg.fillPath()
        case .box:
            guard let start = points.first, let end = points.last else { return }
            let rect = CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
            cg.addPath(UIBezierPath(roundedRect: rect, cornerRadius: min(width * 3, min(rect.width, rect.height) / 2)).cgPath)
            cg.strokePath()
        case .text(let text):
            guard let origin = points.first else { return }
            let font = UIFont.systemFont(ofSize: width * 7, weight: .bold)
            let shadow = NSShadow()
            shadow.shadowColor = UIColor.black.withAlphaComponent(0.45); shadow.shadowBlurRadius = width
            // UIKit text drawing targets the current context, which a SwiftUI Canvas does not set.
            UIGraphicsPushContext(cg)
            NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .shadow: shadow])
                .draw(at: CGPoint(x: origin.x, y: origin.y - font.lineHeight / 2))
            UIGraphicsPopContext()
        case .pixelate: break
        }
    }
}

enum AgentImageData {
    static func load(_ url: URL) async throws -> Data {
        if url.isFileURL { return try await Task.detached(priority: .userInitiated) { try Data(contentsOf: url) }.value }
        let (data, response) = try await URLSession.shared.data(from: url)
        if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) { throw URLError(.badServerResponse) }
        return data
    }

    /// Full-resolution, upright, 1x image plus the pixelated copy that Remove paints with.
    static func editable(_ url: URL) async throws -> (image: UIImage, pixelated: UIImage?) {
        let data = try await load(url)
        return try await Task.detached(priority: .userInitiated) {
            guard let decoded = UIImage(data: data) else { throw CocoaError(.fileReadCorruptFile) }
            let format = UIGraphicsImageRendererFormat.preferred()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: decoded.size, format: format).image { _ in decoded.draw(at: .zero) }
            return (image, pixelate(image))
        }.value
    }

    private static func pixelate(_ image: UIImage) -> UIImage? {
        guard let cgImage = image.cgImage else { return nil }
        let input = CIImage(cgImage: cgImage)
        let filter = CIFilter.pixellate()
        filter.inputImage = input.clampedToExtent()
        filter.center = .zero
        filter.scale = Float(max(8, max(input.extent.width, input.extent.height) / 48))
        guard let output = filter.outputImage?.cropped(to: input.extent),
              let result = CIContext().createCGImage(output, from: input.extent) else { return nil }
        return UIImage(cgImage: result)
    }

    static func render(_ image: UIImage, pixelated: UIImage?, marks: [AgentImageMark], crop: CGRect, scale: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        let size = CGSize(width: max(1, (crop.width * scale).rounded()), height: max(1, (crop.height * scale).rounded()))
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -crop.minX, y: -crop.minY)
            image.draw(at: .zero)
            AgentImageMark.draw(marks, pixelated: pixelated, in: cg)
        }
    }
}

/// Edits one image: annotate, pixelate, crop and resize, then hands back a temporary PNG.
struct AgentImageEditor: View {
    let sourceURL: URL
    let onApply: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var tool: AgentImageEditorTool
    @State private var image: UIImage?
    @State private var pixelated: UIImage?
    @State private var failure: String?
    @State private var marks: [AgentImageMark] = []
    @State private var draft: AgentImageMark?
    @State private var crop = CGRect.null
    @State private var cropStart: CGRect?
    @State private var scale: CGFloat = 1
    @State private var color = UIColor.systemRed
    @State private var textPoint: CGPoint?
    @State private var textValue = ""
    @State private var exporting = false

    private static let palette: [UIColor] = [.systemRed, .systemYellow, .systemGreen, .systemBlue, .white, .black]
    private static let scales: [CGFloat] = [1, 0.75, 0.5, 0.25]

    init(sourceURL: URL, tool: AgentImageEditorTool, onApply: @escaping (URL) -> Void) {
        self.sourceURL = sourceURL
        self.onApply = onApply
        _tool = State(initialValue: tool)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let image {
                    canvas(image).frame(maxWidth: .infinity, maxHeight: .infinity)
                    controls(image).padding(.horizontal, 16).padding(.vertical, 12)
                } else if let failure {
                    ContentUnavailableView("Image unavailable", systemImage: "photo", description: Text(failure))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(tool.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button("Undo", systemImage: "arrow.uturn.backward") { _ = marks.popLast() }
                        .disabled(marks.isEmpty).accessibilityIdentifier("image-editor-undo")
                    Button("Apply") { apply() }
                        .disabled(image == nil || exporting).accessibilityIdentifier("image-editor-apply")
                }
            }
            .alert("Add text", isPresented: Binding(get: { textPoint != nil }, set: { if !$0 { textPoint = nil } })) {
                TextField("Text", text: $textValue)
                Button("Cancel", role: .cancel) { textPoint = nil }
                Button("Add") {
                    let text = textValue.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let textPoint, !text.isEmpty, let image { marks.append(AgentImageMark(kind: .text(text), points: [textPoint], color: color, width: lineWidth(.text, image))) }
                    textPoint = nil
                }
            }
        }
        .preferredColorScheme(.dark)
        .task {
            do {
                let loaded = try await AgentImageData.editable(sourceURL)
                image = loaded.image; pixelated = loaded.pixelated
                crop = CGRect(origin: .zero, size: loaded.image.size)
            } catch { failure = error.localizedDescription }
        }
    }

    private func canvas(_ image: UIImage) -> some View {
        GeometryReader { geometry in
            let available = CGSize(width: max(1, geometry.size.width - 32), height: max(1, geometry.size.height - 32))
            let ratio = min(available.width / image.size.width, available.height / image.size.height)
            let fitted = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
            let visible = marks + (draft.map { [$0] } ?? [])
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable()
                if let pixelated, visible.contains(where: \.isPixelate) {
                    Image(uiImage: pixelated).resizable().mask {
                        Canvas { context, _ in
                            context.withCGContext { cg in
                                cg.scaleBy(x: ratio, y: ratio)
                                for mark in visible where mark.isPixelate {
                                    cg.addPath(mark.strokePath)
                                    cg.setLineWidth(mark.width); cg.setLineCap(.round); cg.setLineJoin(.round)
                                    cg.setStrokeColor(UIColor.white.cgColor); cg.strokePath()
                                }
                            }
                        }
                    }
                }
                Canvas { context, _ in
                    context.withCGContext { cg in
                        cg.scaleBy(x: ratio, y: ratio)
                        AgentImageMark.draw(visible.filter { !$0.isPixelate }, pixelated: nil, in: cg)
                    }
                }
                cropOverlay(image, ratio: ratio, size: fitted)
            }
            .frame(width: fitted.width, height: fitted.height)
            .contentShape(.rect)
            .gesture(drawGesture(image, ratio: ratio), isEnabled: tool.annotates)
            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
        }
        .accessibilityIdentifier("image-editor-canvas")
    }

    @ViewBuilder
    private func cropOverlay(_ image: UIImage, ratio: CGFloat, size: CGSize) -> some View {
        let bounds = CGRect(origin: .zero, size: image.size)
        if !crop.isNull, tool == .crop || crop != bounds {
            let shown = CGRect(x: crop.minX * ratio, y: crop.minY * ratio, width: crop.width * ratio, height: crop.height * ratio)
            ZStack(alignment: .topLeading) {
                Path { path in path.addRect(CGRect(origin: .zero, size: size)); path.addRect(shown) }
                    .fill(.black.opacity(0.55), style: FillStyle(eoFill: true))
                    .allowsHitTesting(false)
                if tool == .crop {
                    Rectangle().stroke(.white, lineWidth: 2)
                        .contentShape(.rect)
                        .frame(width: shown.width, height: shown.height)
                        .offset(x: shown.minX, y: shown.minY)
                        .gesture(cropGesture(bounds, ratio: ratio) { start, delta in
                            start.offsetBy(dx: min(max(delta.width, -start.minX), bounds.maxX - start.maxX),
                                           dy: min(max(delta.height, -start.minY), bounds.maxY - start.maxY))
                        })
                    ForEach(0..<4, id: \.self) { corner in
                        let left = corner % 2 == 0, top = corner < 2
                        Circle().fill(.white).frame(width: 22, height: 22)
                            .frame(width: 44, height: 44).contentShape(.rect)
                            .position(x: left ? shown.minX : shown.maxX, y: top ? shown.minY : shown.maxY)
                            .gesture(cropGesture(bounds, ratio: ratio) { start, delta in
                                resized(start, left: left, top: top, delta: delta, bounds: bounds)
                            })
                            .accessibilityLabel("Crop handle")
                    }
                }
            }
        }
    }

    private func cropGesture(_ bounds: CGRect, ratio: CGFloat, update: @escaping (CGRect, CGSize) -> CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let start = cropStart ?? crop
                cropStart = start
                crop = update(start, CGSize(width: value.translation.width / ratio, height: value.translation.height / ratio)).intersection(bounds)
            }
            .onEnded { _ in cropStart = nil }
    }

    private func resized(_ rect: CGRect, left: Bool, top: Bool, delta: CGSize, bounds: CGRect) -> CGRect {
        let minimum = max(bounds.width, bounds.height) * 0.05
        var (minX, minY, maxX, maxY) = (rect.minX, rect.minY, rect.maxX, rect.maxY)
        if left { minX = min(max(bounds.minX, minX + delta.width), maxX - minimum) } else { maxX = max(min(bounds.maxX, maxX + delta.width), minX + minimum) }
        if top { minY = min(max(bounds.minY, minY + delta.height), maxY - minimum) } else { maxY = max(min(bounds.maxY, maxY + delta.height), minY + minimum) }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    private func drawGesture(_ image: UIImage, ratio: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let point = clamped(value.location, ratio: ratio, size: image.size)
                switch tool {
                case .pen, .remove:
                    if draft == nil { draft = AgentImageMark(kind: tool == .pen ? .pen : .pixelate, points: [], color: color, width: lineWidth(tool, image)) }
                    draft?.points.append(point)
                case .arrow, .box:
                    let start = clamped(value.startLocation, ratio: ratio, size: image.size)
                    draft = AgentImageMark(kind: tool == .arrow ? .arrow : .box, points: [start, point], color: color, width: lineWidth(tool, image))
                default: break
                }
            }
            .onEnded { value in
                if tool == .text {
                    textValue = ""
                    textPoint = clamped(value.location, ratio: ratio, size: image.size)
                } else if let draft, draft.points.count > 1 || tool == .pen || tool == .remove {
                    marks.append(draft)
                }
                draft = nil
            }
    }

    private func clamped(_ point: CGPoint, ratio: CGFloat, size: CGSize) -> CGPoint {
        CGPoint(x: min(max(0, point.x / ratio), size.width), y: min(max(0, point.y / ratio), size.height))
    }

    private func lineWidth(_ tool: AgentImageEditorTool, _ image: UIImage) -> CGFloat {
        let base = max(image.size.width, image.size.height)
        return tool == .remove ? max(24, base * 0.05) : max(3, base * 0.006)
    }

    private func controls(_ image: UIImage) -> some View {
        VStack(spacing: 14) {
            Group {
                switch tool {
                case .pen, .arrow, .box, .text:
                    HStack(spacing: 14) {
                        ForEach(Self.palette, id: \.self) { swatch in
                            Button { color = swatch } label: {
                                Circle().fill(Color(uiColor: swatch)).frame(width: 28, height: 28)
                                    .overlay { Circle().stroke(.white, lineWidth: swatch == color ? 3 : 1).padding(-3) }
                            }.accessibilityLabel("Color")
                        }
                    }
                case .remove:
                    Text("Paint over anything you want to hide.").font(.footnote).foregroundStyle(.secondary)
                case .crop:
                    Button("Reset crop") { crop = CGRect(origin: .zero, size: image.size) }.font(.footnote)
                case .resize:
                    HStack(spacing: 8) {
                        ForEach(Self.scales, id: \.self) { option in
                            Button { scale = option } label: {
                                VStack(spacing: 2) {
                                    Text("\(Int(option * 100))%").font(.subheadline.weight(.semibold))
                                    Text("\(Int((crop.width * option).rounded()))×\(Int((crop.height * option).rounded()))").font(.caption2).foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                                .background(option == scale ? Color.white.opacity(0.2) : Color.white.opacity(0.06), in: .rect(cornerRadius: 12))
                            }.accessibilityIdentifier("image-editor-scale-\(Int(option * 100))")
                        }
                    }
                }
            }
            .frame(minHeight: 44)
            if let failure { Text(failure).font(.footnote).foregroundStyle(.red) }
            HStack(spacing: 4) {
                ForEach(AgentImageEditorTool.allCases) { option in
                    Button { tool = option } label: {
                        Image(systemName: option.icon).font(.body.weight(.medium))
                            .frame(width: 42, height: 42)
                            .background(option == tool ? Color.white.opacity(0.2) : .clear, in: .circle)
                    }
                    .accessibilityLabel(option.title)
                    .accessibilityIdentifier("image-editor-tool-\(option.rawValue)")
                }
            }
        }
        .buttonStyle(.plain).foregroundStyle(.white)
    }

    private func apply() {
        guard let image, !exporting else { return }
        exporting = true
        let (pixelated, marks, crop, scale) = (pixelated, marks, crop, scale)
        Task {
            defer { exporting = false }
            do {
                let url = try await Task.detached(priority: .userInitiated) {
                    let rendered = AgentImageData.render(image, pixelated: pixelated, marks: marks, crop: crop, scale: scale)
                    guard let data = rendered.pngData() else { throw CocoaError(.fileWriteUnknown) }
                    let url = FileManager.default.temporaryDirectory.appending(path: "pathway-edited-\(UUID().uuidString).png")
                    try data.write(to: url, options: .atomic)
                    return url
                }.value
                onApply(url)
                dismiss()
            } catch { failure = error.localizedDescription }
        }
    }
}
