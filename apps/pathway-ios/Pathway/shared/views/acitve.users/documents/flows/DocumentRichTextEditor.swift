import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class DocumentRichTextModel {
    var attributedText = NSAttributedString(string: "")
    @ObservationIgnored weak var textView: UITextView?

    var isEmpty: Bool {
        attributedText.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func toggleBold() { toggleTrait(.traitBold) }
    func toggleItalic() { toggleTrait(.traitItalic) }

    func toggleUnderline() {
        guard let textView else { return }
        let range = effectiveRange(in: textView)
        if range.length == 0 {
            let current = textView.typingAttributes[.underlineStyle] as? Int
            textView.typingAttributes[.underlineStyle] =
                current == NSUnderlineStyle.single.rawValue ? 0 : NSUnderlineStyle.single.rawValue
            return
        }
        let current = textView.attributedText.attribute(.underlineStyle, at: range.location, effectiveRange: nil) as? Int
        textView.textStorage.addAttribute(
            .underlineStyle,
            value: current == NSUnderlineStyle.single.rawValue ? 0 : NSUnderlineStyle.single.rawValue,
            range: range
        )
        sync(from: textView)
    }

    func applyLink(_ value: String) {
        guard let textView,
              textView.selectedRange.length > 0,
              let url = normalizedURL(value) else { return }
        textView.textStorage.addAttribute(.link, value: url, range: textView.selectedRange)
        sync(from: textView)
    }

    func applyBulletedList() { prefixSelectedParagraphs { _ in "• " } }
    func applyNumberedList() { prefixSelectedParagraphs { "\($0 + 1). " } }

    func html() -> String {
        guard attributedText.length > 0,
              let data = try? attributedText.data(
                from: NSRange(location: 0, length: attributedText.length),
                documentAttributes: [.documentType: NSAttributedString.DocumentType.html]
              ),
              let value = String(data: data, encoding: .utf8) else {
            return "<p></p>"
        }
        return value
    }

    func sync(from textView: UITextView) {
        attributedText = NSAttributedString(attributedString: textView.attributedText)
    }

    private func toggleTrait(_ trait: UIFontDescriptor.SymbolicTraits) {
        guard let textView else { return }
        let range = effectiveRange(in: textView)
        if range.length == 0 {
            let font = (textView.typingAttributes[.font] as? UIFont) ?? .preferredFont(forTextStyle: .body)
            var traits = font.fontDescriptor.symbolicTraits
            if traits.contains(trait) { traits.remove(trait) } else { traits.insert(trait) }
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
            textView.typingAttributes[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
            return
        }
        textView.textStorage.enumerateAttribute(.font, in: range) { value, subrange, _ in
            let font = (value as? UIFont) ?? .preferredFont(forTextStyle: .body)
            var traits = font.fontDescriptor.symbolicTraits
            if traits.contains(trait) { traits.remove(trait) } else { traits.insert(trait) }
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
            textView.textStorage.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: subrange)
        }
        sync(from: textView)
    }

    private func effectiveRange(in textView: UITextView) -> NSRange {
        if textView.selectedRange.length > 0 { return textView.selectedRange }
        let location = min(textView.selectedRange.location, max(0, textView.textStorage.length - 1))
        return NSRange(location: location, length: textView.textStorage.length == 0 ? 0 : 1)
    }

    private func prefixSelectedParagraphs(prefix: (Int) -> String) {
        guard let textView else { return }
        let nsText = textView.text as NSString
        let selected = nsText.paragraphRange(for: textView.selectedRange)
        let value = nsText.substring(with: selected)
        let lines = value.components(separatedBy: .newlines)
        let transformed = lines.enumerated().map { index, line in
            line.isEmpty ? line : prefix(index) + line
        }.joined(separator: "\n")
        textView.textStorage.replaceCharacters(in: selected, with: transformed)
        textView.selectedRange = NSRange(location: selected.location, length: transformed.utf16.count)
        sync(from: textView)
    }

    private func normalizedURL(_ value: String) -> URL? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if let url = URL(string: value), url.scheme != nil { return url }
        return URL(string: "https://\(value)")
    }
}

struct DocumentRichTextEditor: UIViewRepresentable {
    let model: DocumentRichTextModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.isScrollEnabled = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        view.accessibilityLabel = "Message"
        model.textView = view
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        model.textView = uiView
        if !uiView.isFirstResponder, uiView.attributedText != model.attributedText {
            uiView.attributedText = model.attributedText
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        let model: DocumentRichTextModel
        init(model: DocumentRichTextModel) { self.model = model }
        func textViewDidChange(_ textView: UITextView) { model.sync(from: textView) }
    }
}
