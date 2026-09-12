import Foundation
import ImageIO
import UniformTypeIdentifiers

struct PathwayPastedImage: Sendable {
    let data: Data
    let name: String
    let mimeType: String

    nonisolated static func supports(_ provider: NSItemProvider) -> Bool {
        provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
    }

    @MainActor static func load(_ provider: NSItemProvider) async throws -> Self {
        guard let type = provider.registeredTypeIdentifiers.compactMap(UTType.init)
            .first(where: { $0.conforms(to: .image) }) else {
            throw PathwayThreadConversationError.message("The clipboard does not contain an image.")
        }
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier,
                                            completionHandler: completion(for: continuation))
        }
        try Task.checkCancellation()
        guard !data.isEmpty, data.count <= 10 * 1024 * 1024 else {
            throw PathwayThreadConversationError.message("Choose an image under 10 MB.")
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let identifier = CGImageSourceGetType(source),
              let actualType = UTType(identifier as String) else {
            throw PathwayThreadConversationError.message("The pasted image could not be read.")
        }
        return Self(data: data, name: "Pasted image.\(actualType.preferredFilenameExtension ?? "png")",
                    mimeType: actualType.preferredMIMEType ?? "image/png")
    }

    // Item providers call back on background queues. Construct the callback outside UI actor isolation.
    private nonisolated static func completion(for continuation: CheckedContinuation<Data, any Error>)
        -> @Sendable (Data?, (any Error)?) -> Void {
        { data, error in
            if let error { continuation.resume(throwing: error) }
            else if let data { continuation.resume(returning: data) }
            else { continuation.resume(throwing: PathwayThreadConversationError.message("The image could not be pasted.")) }
        }
    }

}
