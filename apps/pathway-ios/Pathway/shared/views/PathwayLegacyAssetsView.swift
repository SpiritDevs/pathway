import SwiftUI

private struct PathwayLegacyAsset: Identifiable {
    let id: String
    let name: String
    let byteSize: Int
    let isPublic: Bool
    let migrated: Bool
    let canMigrate: Bool
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
        self.id = id; name = fields["name"]?.stringValue ?? "File"; byteSize = fields["byteSize"]?.intValue ?? 0
        isPublic = fields["storage"]?.stringValue == "legacy-public"
        migrated = fields["migrationState"]?.stringValue == "migrated"
        canMigrate = fields["canMigrate"]?.boolValue ?? false
    }
}

struct PathwayLegacyAssetsView: View {
    let companyID: String
    let request: PathwayAssetsModel.Request
    @State private var source = "tasks"
    @State private var items: [PathwayLegacyAsset] = []
    @State private var nextCursor: String?
    @State private var selected: PathwayLegacyAsset?
    @State private var confirming = false
    @State private var loading = false
    @State private var migrating = false
    @State private var error: String?
    @State private var completed: PathwayAsset?
    var body: some View {
        List {
            Section {
                Picker("Source", selection: $source) { Text("Tasks").tag("tasks"); Text("Conversations").tag("queue") }.pickerStyle(.segmented)
                Text("Existing uploads keep their current links until you create a private copy. Copying does not revoke older public links.").font(.footnote).foregroundStyle(.secondary)
            }
            if loading { ProgressView("Loading existing uploads…") }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Label(item.name, systemImage: "paperclip").font(.subheadline).lineLimit(2)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(item.byteSize), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                    if item.migrated { Label("Private copy in Assets", systemImage: "checkmark.shield").font(.caption).foregroundStyle(.green) }
                    else {
                        Label(item.isPublic ? "Legacy public link" : "Existing cloud attachment", systemImage: item.isPublic ? "globe" : "cloud")
                            .font(.caption).foregroundStyle(item.isPublic ? .orange : .secondary)
                        if item.canMigrate { Button(item.isPublic ? "Create private copy" : "Make available in Assets") { selected = item; confirming = true } }
                    }
                }.padding(.vertical, 4)
            }
            if !loading && items.isEmpty { ContentUnavailableView("No existing uploads", systemImage: "paperclip") }
            if nextCursor != nil { Button("Load more") { Task { await load(more: true) } } }
        }
        .navigationTitle("Existing uploads")
        .disabled(migrating)
        .task(id: source) { await load() }
        .refreshable { await load() }
        .overlay { if migrating { ProgressView("Creating private copy…").padding().background(.regularMaterial, in: .rect(cornerRadius: 16)) } }
        .confirmationDialog("Create a private copy?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Create private copy") {
                guard let selected else { return }
                migrating = true
                let capturedSource = source
                Task {
                    defer { migrating = false }
                    do {
                        let result = try await request("action", "assets:migrateLegacy", .object(["companyId": .string(companyID), "source": .string(capturedSource), "legacyId": .string(selected.id)]))
                        completed = PathwayAsset(result, companyID: companyID)
                        await load()
                    } catch { self.error = error.localizedDescription }
                }
            }
        } message: { Text("The copy counts toward company storage and follows its attached context's permissions. Original links and message history remain intact.") }
        .sheet(item: $completed) { asset in PathwayAssetDetailView(asset: asset, model: PathwayAssetsModel(request: request)) }
    }
    private func load(more: Bool = false) async {
        let capturedSource = source
        loading = true
        var args: [String: JSONValue] = ["companyId": .string(companyID), "source": .string(source), "limit": .number(40)]
        if more, let nextCursor { args["cursor"] = .string(nextCursor) }
        do {
            let result = try await request("query", "assets:legacyList", .object(args))
            guard capturedSource == source, !Task.isCancelled else { return }
            let values = (result.objectValue?["items"]?.arrayValue ?? []).compactMap(PathwayLegacyAsset.init)
            items = more ? items + values.filter { value in !items.contains { $0.id == value.id } } : values
            nextCursor = result.objectValue?["nextCursor"]?.stringValue; error = nil
        } catch { if capturedSource == source { self.error = error.localizedDescription } }
        if capturedSource == source { loading = false }
    }
}
