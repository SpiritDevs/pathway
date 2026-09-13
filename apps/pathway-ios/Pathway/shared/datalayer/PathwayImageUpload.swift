import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Image representations for previews and legacy delivery. Company assets retain original bytes.
struct PathwayImageUpload: Sendable {
    let data: Data
    let name: String
    let mimeType: String

    /// Composer previews are bounded independently of the immutable uploaded original.
    static func thumbnail(_ data: Data) async -> Data? {
        await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1024
                  ] as CFDictionary) else { return nil }
            let result = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(result, UTType.png.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, nil)
            return CGImageDestinationFinalize(destination) ? result as Data : nil
        }.value
    }

    static func prepare(data: Data, name: String, mimeType: String) async throws -> Self {
        let worker = Task.detached(priority: .userInitiated) {
            try convert(data: data, name: name, mimeType: mimeType)
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }

    nonisolated static func convert(data: Data, name: String, mimeType: String) throws -> Self {
        try Task.checkCancellation()
        let declaredHEIF = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].contains(mimeType.lowercased())
            || ["heic", "heif", "hif"].contains((name as NSString).pathExtension.lowercased())
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let identifier = CGImageSourceGetType(source) else {
            if declaredHEIF { throw ConversionError.invalidImage }
            return Self(data: data, name: name, mimeType: mimeType)
        }
        let type = UTType(identifier as String)
        let isHEIF = type?.conforms(to: .heic) == true || type?.conforms(to: .heif) == true
        guard isHEIF || declaredHEIF else { return Self(data: data, name: name, mimeType: mimeType) }
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary) else { throw ConversionError.invalidImage }
        try Task.checkCancellation()
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let hasAlpha = properties?[kCGImagePropertyHasAlpha] as? Bool ?? false
        let outputType: UTType = hasAlpha ? .png : .jpeg
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, outputType.identifier as CFString, 1, nil) else {
            throw ConversionError.invalidImage
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length > 0, output.length <= 10 * 1024 * 1024 else {
            throw ConversionError.tooLarge
        }
        let stem = ((name as NSString).lastPathComponent as NSString).deletingPathExtension
        let filename = String((stem.isEmpty ? "Image" : stem).prefix(245)) + (hasAlpha ? ".png" : ".jpg")
        return Self(data: output as Data, name: filename, mimeType: hasAlpha ? "image/png" : "image/jpeg")
    }

    enum ConversionError: LocalizedError {
        case invalidImage, tooLarge
        var errorDescription: String? {
            switch self {
            case .invalidImage: "This photo could not be converted. Choose another image."
            case .tooLarge: "The converted photo exceeds 10 MB. Choose a smaller image."
            }
        }
    }
}
