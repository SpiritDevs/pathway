import SwiftUI

struct AgentSnapShotDetails: View {
    let source: [String: JSONValue]
    @State private var expanded = false
    @State private var accessibilityText: String?

    var body: some View {
        DisclosureGroup("Capture details", isExpanded: $expanded) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(source["appName"]?.stringValue ?? "SnapShot").font(.headline)
                    if let title = source["windowTitle"]?.stringValue, !title.isEmpty {
                        Text(title)
                    }
                    if let capturedAt = source["capturedAt"]?.stringValue {
                        Text(capturedAt).font(.caption).foregroundStyle(.secondary)
                    }
                    if let accessibilityText {
                        Text("App text").font(.subheadline.bold())
                        Text(accessibilityText).font(.caption.monospaced())
                    } else {
                        Text("No app text was included.").foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            }
            .frame(maxHeight: 200)
        }
        .padding()
        .background(.regularMaterial)
        .task(id: expanded) {
            guard expanded else { return }
            accessibilityText = await Task.detached(priority: .utility) {
                if let text = source["accessibleText"]?.stringValue { return text }
                guard let accessibility = source["accessibility"] else { return String?.none }
                if let text = accessibility.objectValue?["text"]?.stringValue { return text }
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                guard let data = try? encoder.encode(accessibility) else { return nil }
                return String(data: data, encoding: .utf8)
            }.value
        }
    }
}
