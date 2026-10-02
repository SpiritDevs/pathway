import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import Pathway

struct PathwayImageUploadTests {
    @Test func heicBecomesAnOrientedJPEGWithMatchingMetadata() throws {
        let source = try fixture(type: .heic, orientation: 6)
        let upload = try PathwayImageUpload.convert(data: source, name: "Pasted image.HEIC", mimeType: "image/heic")
        #expect(upload.name == "Pasted image.jpg")
        #expect(upload.mimeType == "image/jpeg")
        let decoded = try #require(CGImageSourceCreateWithData(upload.data as CFData, nil))
        #expect(CGImageSourceGetType(decoded) as String? == UTType.jpeg.identifier)
        let image = try #require(CGImageSourceCreateImageAtIndex(decoded, 0, nil))
        #expect(image.width == 32)
        #expect(image.height == 64)
    }

    @Test func detectsHEICBytesEvenWithGenericMetadata() throws {
        let source = try fixture(type: .heic)
        let upload = try PathwayImageUpload.convert(data: source, name: "photo.bin", mimeType: "application/octet-stream")
        #expect(upload.name == "photo.jpg")
        #expect(upload.mimeType == "image/jpeg")
    }

    @Test func transparentHEICBecomesPNG() throws {
        let source = try fixture(type: .heic, transparent: true)
        let upload = try PathwayImageUpload.convert(data: source, name: "overlay.heic", mimeType: "image/heic")
        #expect(upload.mimeType == "image/png")
        #expect(upload.name == "overlay.png")
        let decoded = try #require(CGImageSourceCreateWithData(upload.data as CFData, nil))
        #expect(CGImageSourceGetType(decoded) as String? == UTType.png.identifier)
    }

    @Test(arguments: [UTType.png, .jpeg]) func compatibleImageBytesArePreserved(type: UTType) throws {
        let data = try fixture(type: type)
        let name = "screen.\(type.preferredFilenameExtension!)"
        let mime = type.preferredMIMEType!
        let upload = try PathwayImageUpload.convert(data: data, name: name, mimeType: mime)
        #expect(upload.data == data)
        #expect(upload.name == name)
        #expect(upload.mimeType == mime)
    }

    @MainActor @Test func orchestratorPreparesConvertedMetadataAndPreview() async throws {
        var metadata: JSONValue?
        let model = PathwayOrchestratorsModel(request: { _, path, args in
            #expect(path == "aiOrchestratorAttachments:prepare")
            metadata = args.objectValue?["attachment"]
            return .object(["ready": .bool(true)])
        }, subscribe: { _, _ in AsyncThrowingStream { $0.finish() } })
        let source = try fixture(type: .heic, orientation: 6)
        await model.addAttachment(chatID: "chat", targetID: "target", data: source, name: "Paste.HEIC", mimeType: "image/heic")
        let draft = try #require(model.attachmentDrafts["chat"]?.first)
        let bytes = try #require(draft.previewData)
        #expect(draft.state == .ready)
        #expect(draft.name == "Paste.jpg")
        #expect(draft.mimeType == "image/jpeg")
        #expect(draft.sizeBytes == bytes.count)
        #expect(metadata?.objectValue?["sizeBytes"]?.intValue == bytes.count)
        #expect(metadata?.objectValue?["mimeType"]?.stringValue == "image/jpeg")
        let decoded = try #require(CGImageSourceCreateWithData(bytes as CFData, nil))
        #expect(CGImageSourceGetType(decoded) as String? == UTType.jpeg.identifier)
        #expect(try #require(CGImageSourceCreateImageAtIndex(decoded, 0, nil)).width == 32)
    }

    @MainActor @Test func orchestratorReportsConversionFailureWithoutUpload() async {
        let model = PathwayOrchestratorsModel(request: { _, _, _ in
            Issue.record("Invalid HEIC must not reach the upload API")
            return .null
        }, subscribe: { _, _ in AsyncThrowingStream { $0.finish() } })
        await model.addAttachment(chatID: "chat", targetID: "target", data: Data("invalid".utf8), name: "broken.heic", mimeType: "image/heic")
        guard case .failed(let message) = model.attachmentDrafts["chat"]?.first?.state else {
            Issue.record("Conversion failure must remain visible on the attachment")
            return
        }
        #expect(message.contains("could not be converted"))
    }

    @Test func invalidHEICIsRejectedInsteadOfUploaded() {
        #expect(throws: (any Error).self) {
            try PathwayImageUpload.convert(data: Data("invalid".utf8), name: "photo.heic", mimeType: "image/heic")
        }
    }

    @Test func ordinaryFilesAreUnchanged() throws {
        let data = Data("plain text".utf8)
        let upload = try PathwayImageUpload.convert(data: data, name: "notes.txt", mimeType: "text/plain")
        #expect(upload.data == data)
        #expect(upload.mimeType == "text/plain")
    }

    private func fixture(type: UTType, orientation: Int = 1, transparent: Bool = false) throws -> Data {
        let context = try #require(CGContext(data: nil, width: 64, height: 32, bitsPerComponent: 8,
            bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: (transparent ? CGImageAlphaInfo.premultipliedLast : .noneSkipLast).rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: transparent ? 0.5 : 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
