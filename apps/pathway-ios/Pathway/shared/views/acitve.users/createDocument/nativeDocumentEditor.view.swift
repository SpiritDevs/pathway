import SwiftUI

struct NativeDocumentEditorView: View {
    let document: CreatedDocument
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Native editor coming soon", systemImage: "doc.text")
            } description: {
                Text(
                    "This document is ready. Editing will be available here directly on your phone."
                )
            }
            .accessibilityIdentifier("nativeDocumentEditorPlaceholder")
            .id(document.id)
            .navigationTitle("Document Editor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onClose)
                        .accessibilityHint("Returns to your documents")
                }
            }
        }
    }
}
