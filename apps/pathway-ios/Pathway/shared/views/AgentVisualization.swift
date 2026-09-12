import SwiftUI

struct AgentVisualization: View {
    let visualization: PathwayVisualization
    let context: AgentMarkdownImageContext
    @Environment(\.openURL) private var openURL
    @State private var opening = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                opening = true
                failure = nil
                Task { @MainActor in
                    defer { opening = false }
                    do {
                        let url = try await context.model.visualizationURL(visualization.path, threadID: context.threadID)
                        openURL(url) { accepted in
                            if !accepted { failure = "Couldn’t open the visualization. Tap to retry." }
                        }
                    } catch { failure = error.localizedDescription }
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "chart.xyaxis.line").font(.title3).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(visualization.title).font(.headline).lineLimit(2)
                        Text(opening ? "Opening…" : "Open visualization in browser").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right.square").foregroundStyle(.secondary)
                }.padding(.horizontal, 16).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: .rect(cornerRadius: 12))
            }.buttonStyle(.plain).disabled(opening)
                .accessibilityLabel("Open visualization: \(visualization.title)")
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
        }
    }
}
