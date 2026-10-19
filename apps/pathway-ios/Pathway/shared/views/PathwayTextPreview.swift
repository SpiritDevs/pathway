import SwiftUI
import UIKit

/// One Text lays out every glyph on the main thread, so huge code and tool output display their head and tail.
enum PathwayTextPreview {
    nonisolated static let marker = "\n\n… Shortened for display. View all or copy to get the full text. …\n\n"

    /// The head and tail of text over the limit, or nil when it fits. Counting Unicode scalars rather than
    /// characters also bounds bytes, even when one character carries thousands of combining marks.
    nonisolated static func shortened(_ text: String, limit: Int = 20_000) -> String? {
        // The UTF-8 length is O(1) and bounds the scalar count, which is only measured for large text.
        guard text.utf8.count > limit else { return nil }
        let scalars = text.unicodeScalars
        guard scalars.count > limit else { return nil }
        let head = scalars.index(scalars.startIndex, offsetBy: limit / 2)
        let tail = scalars.index(scalars.endIndex, offsetBy: -(limit / 2))
        return String(scalars[..<head]) + marker + String(scalars[tail...])
    }

    /// Reader rows: one per line, with long lines split so no row lays out more than `width` scalars.
    nonisolated static func rows(_ text: String, width: Int = 2_000) -> [String] {
        var rows: [String] = []
        for line in text.components(separatedBy: "\n") {
            var rest = line.unicodeScalars[...]
            repeat {
                let end = rest.index(rest.startIndex, offsetBy: width, limitedBy: rest.endIndex) ?? rest.endIndex
                rows.append(String(rest[..<end]))
                rest = rest[end...]
            } while !rest.isEmpty
        }
        return rows
    }
}

/// Shown under shortened text so the full text stays one tap away.
struct PathwayFullTextActions: View {
    let title: String
    let text: String
    @State private var reading = false

    var body: some View {
        HStack(spacing: 18) {
            Button("View all", systemImage: "text.alignleft") { reading = true }
            Button("Copy all", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
        .font(.subheadline).foregroundStyle(.secondary).buttonStyle(.plain)
        .sheet(isPresented: $reading) { PathwayFullTextReader(title: title, text: text) }
    }
}

/// The complete text as lazily created rows, so opening it never lays out the whole text at once.
struct PathwayFullTextReader: View {
    let title: String
    let text: String
    private let rows: [String]
    @Environment(\.dismiss) private var dismiss

    init(title: String, text: String) {
        self.title = title
        self.text = text
        rows = PathwayTextPreview.rows(text)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows.indices, id: \.self) { index in
                        // An empty Text has no height; a space keeps blank lines visible.
                        Text(rows[index].isEmpty ? " " : rows[index]).font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .textSelection(.enabled)
                .padding(16)
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy all", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                }
            }
        }
    }
}
