import SwiftUI
import UniformTypeIdentifiers
import QuickLook

struct PathwayAssetsSettingsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var companyID = ""
    var body: some View {
        Group {
            if let company = appModel.cloud.companies.first(where: { $0.id == companyID }) ?? appModel.cloud.companies.first {
                PathwayAssetsView(companyID: company.id, cloud: appModel.cloud)
                    .toolbar {
                        if appModel.cloud.companies.count > 1 {
                            ToolbarItem(placement: .topBarTrailing) {
                                Menu {
                                    Picker("Company", selection: $companyID) {
                                        ForEach(appModel.cloud.companies) { Text($0.name).tag($0.id) }
                                    }
                                } label: { Label("Company", systemImage: "building.2") }
                            }
                        }
                    }.id(company.id)
            } else { ContentUnavailableView("Connect to your company", systemImage: "cloud", description: Text("Sign in to find your uploaded assets.")) }
        }.navigationTitle("Assets")
    }
}

struct PathwayAssetsView: View {
    let companyID: String
    var threadID: String? = nil
    var environmentID: String? = nil
    @State private var model: PathwayAssetsModel
    @State private var search = ""
    @State private var kind = "all"
    @State private var trash = false
    @State private var sort = "newest"
    @State private var uploader = "all"
    @State private var recentDays = 0
    @State private var importing = false
    @State private var choosingExisting = false
    @State private var selectedAsset: PathwayAsset?
    @State private var selectedIDs: Set<String> = []
    @State private var bulkDelete = false
    @State private var configuringStorage = false

    init(companyID: String, threadID: String? = nil, environmentID: String? = nil, cloud: PathwayCloudModel) {
        self.companyID = companyID; self.threadID = threadID; self.environmentID = environmentID
        _model = State(initialValue: PathwayAssetsModel { kind, name, args in try await cloud.request(kind: kind, name: name, arguments: args) })
    }
    init(companyID: String, model: PathwayAssetsModel) { self.companyID = companyID; _model = State(initialValue: model) }
    private var context: JSONValue? {
        guard let threadID else { return nil }
        var fields: [String: JSONValue] = ["kind": .string("thread"), "id": .string(threadID)]
        if let environmentID { fields["environmentId"] = .string(environmentID) }
        return .object(fields)
    }
    private var visible: [PathwayAsset] { model.items }
    var body: some View {
        List(selection: $selectedIDs) {
            Section {
                if threadID == nil { NavigationLink("Existing uploads") { PathwayLegacyAssetsView(companyID: companyID, request: model.request) } }
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text("Company storage"); Spacer(); Text(bytes(model.usedBytes) + " of " + bytes(model.maxBytes)).foregroundStyle(.secondary) }.font(.caption)
                    ProgressView(value: Double(model.usedBytes), total: Double(max(1, model.maxBytes)))
                }.accessibilityElement(children: .combine)
                if model.canConfigureQuota { Button("Storage limits", systemImage: "slider.horizontal.3") { configuringStorage = true } }
            }
            if let label = model.uploadLabel {
                Section {
                    HStack { if model.busy { ProgressView() }; Text(label).font(.subheadline) }
                    if !model.busy { Button("Retry upload") { Task { await model.retryUpload(companyID: companyID, context: context); if model.error == nil { await reload() } } } }
                }
            }
            if let error = model.error {
                Section { Text(error).font(.footnote).foregroundStyle(.red); Button("Retry") { Task { await reload() } } }
            }
            if model.loading && model.items.isEmpty { ProgressView("Loading assets…") }
            else if visible.isEmpty {
                ContentUnavailableView(trash ? "Trash is empty" : "No assets", systemImage: trash ? "trash" : "paperclip",
                    description: Text(search.isEmpty ? "Upload a file to make it available across your devices." : "Try another search or filter."))
            } else {
                Section(trash ? "Trash · Kept for 30 days" : threadID == nil ? "Your accessible files" : "Thread assets") {
                    ForEach(visible) { asset in
                        Button { selectedAsset = asset } label: { PathwayAssetListRow(asset: asset) }.buttonStyle(.plain).tag(asset.id)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                if asset.canManage {
                                    if trash { Button("Restore", systemImage: "arrow.uturn.backward") { perform("restore", asset) }.tint(.blue) }
                                    else { Button("Delete", systemImage: "trash", role: .destructive) { selectedAsset = asset } }
                                }
                            }
                    }
                    if model.nextCursor != nil { Button("Load more") { Task { await reload(more: true) } }.disabled(model.loading) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(threadID == nil ? "Assets" : "Thread assets")
        .searchable(text: $search, prompt: "Search files")
        .task(id: "\(companyID):\(search):\(kind):\(trash):\(sort):\(uploader):\(recentDays)") {
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(250)); guard !Task.isCancelled else { return } }
            await reload()
        }
        .refreshable { await reload() }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Toggle("Trash", isOn: $trash)
                    Picker("Type", selection: $kind) {
                        Text("All types").tag("all"); Text("Images").tag("image"); Text("Videos").tag("video")
                        Text("Audio").tag("audio"); Text("Documents").tag("document"); Text("Other files").tag("file")
                    }
                    Picker("Sort", selection: $sort) { Text("Newest first").tag("newest"); Text("Name").tag("name"); Text("Largest first").tag("size") }
                    Picker("Uploaded", selection: $recentDays) { Text("Any date").tag(0); Text("Last 7 days").tag(7); Text("Last 30 days").tag(30) }
                    Picker("Uploader", selection: $uploader) {
                        Text("Everyone").tag("all")
                        ForEach(Array(Set(model.items.compactMap(\.uploaderID))).sorted(), id: \.self) { id in Text(model.items.first { $0.uploaderID == id }?.uploaderName ?? "Uploader").tag(id) }
                    }
                } label: { Label("Filter assets", systemImage: "line.3.horizontal.decrease") }
                EditButton()
                Menu {
                    Button("Upload file", systemImage: "arrow.up.doc") { importing = true }
                    if context != nil { Button("Add existing asset", systemImage: "paperclip") { choosingExisting = true } }
                } label: { Label("Add asset", systemImage: "plus") }.disabled(model.busy || trash)
            }
            if !selectedIDs.isEmpty {
                ToolbarItem(placement: .bottomBar) {
                    Button(trash ? "Restore selected" : "Delete selected", systemImage: trash ? "arrow.uturn.backward" : "trash") { bulkDelete = true }
                        .disabled(model.busy || !visible.filter { selectedIDs.contains($0.id) }.allSatisfy(\.canManage))
                }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url): Task { await model.upload(url: url, companyID: companyID, context: context); if model.error == nil { await reload() } }
            case .failure(let error): model.error = error.localizedDescription
            }
        }
        .sheet(isPresented: $configuringStorage, onDismiss: { Task { await reload() } }) {
            PathwayAssetQuotaView(companyID: companyID, model: model)
        }
        .sheet(isPresented: $choosingExisting, onDismiss: { Task { await reload() } }) {
            if let context { PathwayAssetPicker(companyID: companyID, context: context, request: model.request) }
        }
        .sheet(item: $selectedAsset, onDismiss: { Task { await reload() } }) { asset in
            PathwayAssetDetailView(asset: asset, model: model, gallery: model.items.filter(\.isMedia), context: context)
        }
        .confirmationDialog(trash ? "Restore selected assets?" : "Move selected assets to Trash?", isPresented: $bulkDelete, titleVisibility: .visible) {
            Button(trash ? "Restore" : "Move to Trash", role: trash ? nil : .destructive) {
                Task {
                    do {
                        for asset in visible where selectedIDs.contains(asset.id) { _ = try await model.mutate(trash ? "restore" : "trash", asset: asset) }
                        selectedIDs.removeAll(); await reload()
                    } catch { model.error = error.localizedDescription }
                }
            }
        } message: { Text("Deleting removes access in every attached location and revokes share links. Assets remain in Trash for 30 days.") }
    }
    private func reload(more: Bool = false) async {
        await model.load(companyID: companyID, threadID: threadID, environmentID: environmentID, search: search, kind: kind == "all" ? nil : kind, trashed: trash, more: more, uploaderID: uploader == "all" ? nil : uploader, createdAfter: recentDays == 0 ? nil : Int(Date.now.addingTimeInterval(-Double(recentDays) * 86400).timeIntervalSince1970 * 1000), sort: sort)
    }
    private func perform(_ action: String, _ asset: PathwayAsset) {
        Task { do { _ = try await model.mutate(action, asset: asset); await reload() } catch { model.error = error.localizedDescription } }
    }
    private func bytes(_ value: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file) }
}

struct PathwayAssetListRow: View {
    let asset: PathwayAsset
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: asset.icon).font(.title3).foregroundStyle(.tint).frame(width: 36, height: 42)
                .background(.quaternary, in: .rect(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 4) {
                Text(asset.name).font(.subheadline).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(asset.byteSize), countStyle: .file) + " · " + asset.statusLabel)
                    .font(.caption).foregroundStyle(.secondary)
                if asset.legacyPublic { Label("Legacy public link", systemImage: "globe").font(.caption2).foregroundStyle(.orange) }
            }
        }.accessibilityElement(children: .combine)
    }
}

struct PathwayAssetDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let asset: PathwayAsset
    let model: PathwayAssetsModel
    var gallery: [PathwayAsset] = []
    var context: JSONValue? = nil
    @State private var name = ""
    @State private var error: String?
    @State private var busy = false
    @State private var deleting = false
    @State private var sharing = false
    @State private var days = 7
    @State private var shareURL: URL?
    @State private var createdShareID: String?
    @State private var downloadURL: URL?
    @State private var previewURL: URL?
    @State private var showingGallery = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PathwayAssetMediaView(asset: asset, model: model, openGallery: asset.isMedia ? { showingGallery = true } : nil)
                    if asset.originalReady && !asset.isTrashed {
                        Button("Download original", systemImage: "arrow.down.to.line") { download(preview: false) }
                        if asset.mimeType == "application/pdf" || asset.mimeType == "text/plain" { Button("Preview document", systemImage: "doc.text.magnifyingglass") { download(preview: true) } }
                    }
                    if let downloadURL { ShareLink(item: downloadURL) { Label("Save or send original", systemImage: "square.and.arrow.up") } }
                    if busy { ProgressView() }
                }
                Section("Details") {
                    if asset.canManage && !asset.isTrashed {
                        TextField("File name", text: $name)
                        Button("Save name") { action("rename", extra: ["name": .string(name)]) }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name == asset.name)
                        Button(asset.kept ? "Stop keeping in Assets" : "Keep in Assets", systemImage: "pin") { action("keep", extra: ["keep": .bool(!asset.kept)]) }
                    } else { Text(asset.name) }
                    LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: Int64(asset.byteSize), countStyle: .file))
                    LabeledContent("Status", value: asset.statusLabel)
                    if let uploaderName = asset.uploaderName { LabeledContent("Uploaded by", value: uploaderName) }
                    if asset.previewState == "failed", asset.canManage { Button("Retry preview", systemImage: "arrow.clockwise") { action("retryProcessing") } }
                    if asset.legacyPublic { Text("This legacy file has a public link. Private access has not been verified.").font(.caption).foregroundStyle(.orange) }
                }
                Section("Used in") {
                    if asset.usages.isEmpty { Text("Standalone library file").foregroundStyle(.secondary) }
                    ForEach(asset.usages) { usage in
                        Label(usage.title ?? (usage.kind == "task" ? "Task attachment" : "Thread attachment"), systemImage: "paperclip")
                    }
                    if let context, asset.canManage, !asset.isTrashed { Button("Remove from this thread", systemImage: "link.badge.minus") { action("detach", extra: ["context": context]) } }
                }
                if asset.canShare && !asset.isTrashed {
                    Section("External sharing") {
                        Button("Create share link", systemImage: "link") { sharing = true }.disabled(!asset.originalReady || asset.state != "ready")
                        if let shareURL { ShareLink(item: shareURL) { Label("Share link", systemImage: "square.and.arrow.up") } }
                        if let createdShareID { Button("Revoke new share link", systemImage: "xmark.circle") { action("revokeShare", extra: ["shareId": .string(createdShareID)]) } }
                        ForEach(asset.shares.filter { !$0.revoked && $0.expiresAt > .now }) { share in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Expires \(share.expiresAt.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                                Button("Revoke share link", systemImage: "xmark.circle") { action("revokeShare", extra: ["shareId": .string(share.id)]) }
                            }
                        }
                    }
                }
                if asset.canManage {
                    Section {
                        if asset.isTrashed { Button("Restore asset", systemImage: "arrow.uturn.backward") { action("restore") } }
                        else { Button("Delete asset", systemImage: "trash", role: .destructive) { deleting = true } }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(asset.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .disabled(busy)
            .onAppear { name = asset.name }
            .quickLookPreview($previewURL)
            .fullScreenCover(isPresented: $showingGallery) {
                PathwayAssetGallery(assets: gallery.isEmpty ? [asset] : gallery, selectedID: asset.id, model: model)
            }
            .confirmationDialog("Delete this asset?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Move to Trash", role: .destructive) { action("trash") }
            } message: { Text("This affects \(asset.usages.count) attached locations and revokes all share links. The original can be restored for 30 days.") }
            .sheet(isPresented: $sharing) {
                NavigationStack {
                    Form {
                        Text("Anyone with the link can view this file until it expires or you revoke it.")
                        Picker("Expires after", selection: $days) { Text("1 day").tag(1); Text("7 days").tag(7); Text("30 days").tag(30) }
                        Button("Create link") {
                            Task {
                                do {
                                    let result = try await model.mutate("share", asset: asset, extra: ["expiresInDays": .number(Double(days))])
                                    guard let raw = result.objectValue?["url"]?.stringValue, let url = URL(string: raw), url.scheme == "https" else { throw URLError(.badServerResponse) }
                                    shareURL = url; createdShareID = result.objectValue?["shareId"]?.stringValue; sharing = false
                                } catch { self.error = error.localizedDescription; sharing = false }
                            }
                        }
                    }.navigationTitle("Share asset").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { sharing = false } } }
                }.presentationDetents([.medium])
            }
        }
    }
    private func action(_ operation: String, extra: [String: JSONValue] = [:]) {
        busy = true
        Task {
            defer { busy = false }
            do { _ = try await model.mutate(operation, asset: asset, extra: extra); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
    private func download(preview: Bool) {
        busy = true
        Task {
            defer { busy = false }
            do {
                let remote = try await model.resolve(asset, original: true)
                let (temporary, response) = try await URLSession.shared.download(from: remote)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.cannotLoadFromNetwork) }
                let directory = FileManager.default.temporaryDirectory.appending(path: "PathwayAssetDownloads/\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let local = directory.appending(path: URL(fileURLWithPath: asset.name).lastPathComponent)
                try FileManager.default.moveItem(at: temporary, to: local)
                if preview { previewURL = local } else { downloadURL = local }
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct PathwayAssetPicker: View {
    @Environment(\.dismiss) private var dismiss
    let companyID: String
    let context: JSONValue
    @State private var model: PathwayAssetsModel
    @State private var search = ""
    @State private var selected: PathwayAsset?
    @State private var confirming = false
    @State private var attaching = false
    init(companyID: String, context: JSONValue, request: @escaping PathwayAssetsModel.Request) {
        self.companyID = companyID; self.context = context; _model = State(initialValue: PathwayAssetsModel(request: request))
    }
    var body: some View {
        NavigationStack {
            List {
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red) }
                if model.loading { ProgressView("Loading assets…") }
                ForEach(model.items) { asset in
                    Button { selected = asset; confirming = true } label: { PathwayAssetListRow(asset: asset) }
                        .buttonStyle(.plain).disabled(!asset.originalReady || asset.isTrashed)
                }
                if model.nextCursor != nil { Button("Load more") { Task { await model.load(companyID: companyID, search: search, more: true) } } }
            }
            .navigationTitle("Add existing asset")
            .searchable(text: $search, prompt: "Search assets")
            .task(id: search) { await model.load(companyID: companyID, search: search) }
            .disabled(attaching)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .confirmationDialog("Attach \(selected?.name ?? "asset")?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Attach and allow thread access") {
                    guard let selected else { return }
                    attaching = true
                    Task {
                        defer { attaching = false }
                        do {
                            _ = try await model.mutate("attach", asset: selected, extra: ["context": context, "confirmBroaderAccess": .bool(true)])
                            dismiss()
                        } catch { model.error = error.localizedDescription }
                    }
                }
            } message: { Text("People who can read this thread will be able to view and download this file. Its existing attachments stay available.") }
        }
    }
}

private struct PathwayAssetQuotaView: View {
    @Environment(\.dismiss) private var dismiss
    let companyID: String
    let model: PathwayAssetsModel
    @State private var gigabytes = 10
    @State private var megabytes = 250
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Company storage") {
                    TextField("Storage limit (GB)", value: $gigabytes, format: .number).keyboardType(.numberPad)
                    TextField("Maximum file size (MB)", value: $megabytes, format: .number).keyboardType(.numberPad)
                    Text("Maximum file size is 250 MB. Lowering storage limits never deletes existing files.").font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }.navigationTitle("Storage limits")
                .onAppear { gigabytes = max(1, model.maxBytes / 1024 / 1024 / 1024); megabytes = model.maxFileBytes / 1024 / 1024 }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            saving = true
                            Task {
                                defer { saving = false }
                                do {
                                    _ = try await model.request("mutation", "assets:configureQuota", .object([
                                        "companyId": .string(companyID), "maxBytes": .number(Double(gigabytes) * 1024 * 1024 * 1024),
                                        "maxFileBytes": .number(Double(megabytes) * 1024 * 1024)]))
                                    dismiss()
                                } catch { self.error = error.localizedDescription }
                            }
                        }.disabled(saving || gigabytes <= 0 || megabytes <= 0 || megabytes > 250)
                    }
                }
        }.presentationDetents([.medium, .large])
    }
}
