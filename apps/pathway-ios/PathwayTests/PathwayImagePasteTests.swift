import Foundation
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Pathway

@MainActor
struct PathwayImagePasteTests {
    private func png() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
    }

    private func provider(data: Data) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
            DispatchQueue.global().async { completion(data, nil) }
            return nil
        }
        return provider
    }

    @Test func backgroundImageCallbackReturnsToMainActor() async throws {
        let data = png()
        let image = try await PathwayPastedImage.load(provider(data: data))
        MainActor.assertIsolated()
        #expect(image.data == data)
        #expect(image.mimeType == "image/png")
        #expect(image.name == "Pasted image.png")
    }

    @Test func invalidAndOversizedImagesReportErrors() async {
        for data in [Data("invalid".utf8), Data(), Data(repeating: 0, count: 10 * 1024 * 1024 + 1)] {
            await #expect(throws: (any Error).self) { try await PathwayPastedImage.load(provider(data: data)) }
        }
    }

    @Test func providerFailureIsReported() async {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
            DispatchQueue.global().async { completion(nil, NSError(domain: "paste-test", code: 1)) }
            return nil
        }
        await #expect(throws: (any Error).self) { try await PathwayPastedImage.load(provider) }
    }

    @Test func directImagePastePreservesTextAndSelection() {
        let view = AgentComposerTextView()
        view.text = "Keep this message 👋"
        let selection = NSRange(location: 5, length: 4)
        view.selectedRange = selection
        var received = 0
        view.onPasteImages = { received += $0.count }
        view.paste(itemProviders: [provider(data: png()), provider(data: png())])
        #expect(received == 2)
        #expect(view.text == "Keep this message 👋")
        #expect(view.selectedRange == selection)
        #expect(view.pasteConfiguration?.acceptableTypeIdentifiers.contains(UTType.image.identifier) == true)
    }

    @Test func keyboardImageTransformUsesAttachmentHandler() {
        let view = AgentComposerTextView()
        let item = PasteItem(provider: provider(data: png()))
        var received = 0
        view.onPasteImages = { received += $0.count }
        view.textPasteConfigurationSupporting(view, transform: item)
        #expect(received == 1)
        #expect(item.result == "none")
    }

    @Test func ordinaryTextUsesNativePasteBehavior() {
        let view = AgentComposerTextView()
        let item = PasteItem(provider: NSItemProvider(object: "Hello" as NSString))
        view.onPasteImages = { _ in Issue.record("Text must not become an attachment") }
        view.textPasteConfigurationSupporting(view, transform: item)
        #expect(item.result == "default")
    }
}

@MainActor private final class PasteItem: NSObject, UITextPasteItem {
    let itemProvider: NSItemProvider
    let localObject: Any? = nil
    let defaultAttributes: [NSAttributedString.Key: Any] = [:]
    var result: String?
    init(provider: NSItemProvider) { itemProvider = provider }
    func setResult(string: String) { result = "string" }
    func setResult(attributedString: NSAttributedString) { result = "attributed" }
    func setResult(attachment: NSTextAttachment) { result = "attachment" }
    func setNoResult() { result = "none" }
    func setDefaultResult() { result = "default" }
}
