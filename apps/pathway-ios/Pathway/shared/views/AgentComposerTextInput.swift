import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A native text input advertises image support to the edit menu and keyboard paste suggestions.
struct AgentComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange?
    @Binding var isFocused: Bool
    let placeholder: String
    let pasteImages: @MainActor ([NSItemProvider]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> AgentComposerTextView {
        let view = AgentComposerTextView()
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "agent-thread-composer-field"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: AgentComposerTextView, context: Context) {
        context.coordinator.parent = self
        view.onPasteImages = pasteImages
        view.accessibilityLabel = placeholder
        context.coordinator.updating = true
        defer { context.coordinator.updating = false }
        // Do not replace marked text while an input method is composing it.
        if view.markedTextRange == nil {
            if view.text != text { view.text = text }
            if let selection, selection.location <= text.utf16.count,
               selection.length <= text.utf16.count - selection.location,
               view.selectedRange != selection {
                view.selectedRange = selection
            }
        }
        if isFocused != view.isFirstResponder {
            Task { @MainActor [weak view, weak coordinator = context.coordinator] in
                guard let view, let coordinator else { return }
                if coordinator.parent.isFocused { view.becomeFirstResponder() }
                else { view.resignFirstResponder() }
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: AgentComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let line = uiView.font?.lineHeight ?? 22
        let measured = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let height = min(max(measured, line * 2), ceil(line * 7))
        uiView.isScrollEnabled = measured > height
        return CGSize(width: width, height: height)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: AgentComposerTextInput
        var updating = false
        init(_ parent: AgentComposerTextInput) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard !updating else { return }
            parent.text = textView.text
            parent.selection = textView.selectedRange
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !updating else { return }
            parent.selection = textView.selectedRange
        }

        func textViewDidBeginEditing(_ textView: UITextView) { parent.isFocused = true }
        func textViewDidEndEditing(_ textView: UITextView) { parent.isFocused = false }
    }
}

final class AgentComposerTextView: UITextView, UITextPasteDelegate {
    var onPasteImages: (@MainActor ([NSItemProvider]) -> Void)?

    init() {
        super.init(frame: .zero, textContainer: nil)
        pasteDelegate = self
        pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.text.identifier, UTType.image.identifier])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        itemProviders.contains(where: PathwayPastedImage.supports) || super.canPaste(itemProviders)
    }

    override func paste(_ sender: Any?) {
        if UIPasteboard.general.hasImages {
            paste(itemProviders: UIPasteboard.general.itemProviders)
        } else {
            super.paste(sender)
        }
    }

    override func paste(itemProviders: [NSItemProvider]) {
        let images = itemProviders.filter(PathwayPastedImage.supports)
        if !images.isEmpty { onPasteImages?(images) }
        let text = itemProviders.filter { !PathwayPastedImage.supports($0) }
        if !text.isEmpty { super.paste(itemProviders: text) }
    }

    func textPasteConfigurationSupporting(_ textPasteConfigurationSupporting: any UITextPasteConfigurationSupporting,
                                         transform item: any UITextPasteItem) {
        if PathwayPastedImage.supports(item.itemProvider) {
            onPasteImages?([item.itemProvider])
            item.setNoResult()
        } else {
            item.setDefaultResult()
        }
    }
}
