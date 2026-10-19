import SwiftUI

struct PathwayWorkspaceFilesView: View {
    let client: PathwayWorkspaceClient
    var assetURL: PathwayWorkspaceAssetURL?
    @State private var entries: [PathwayWorkspaceEntries.Entry] = []
    @State private var truncated = false
    @State private var query = ""
    @State private var directory = ""
    @State private var error: String?
    @State private var loading = false
    private var visible: [PathwayWorkspaceEntries.Entry] {
        entries.filter { entry in
            if !query.isEmpty { return entry.path.localizedCaseInsensitiveContains(query) }
            let prefix = directory.isEmpty ? "" : directory + "/"
            guard entry.path.hasPrefix(prefix) else { return false }
            return !entry.path.dropFirst(prefix.count).contains("/")
        }
    }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView("Loading files…") }
            if !directory.isEmpty && query.isEmpty {
                Button("Parent folder", systemImage: "arrow.up") {
                    directory = directory.split(separator: "/").dropLast().joined(separator: "/")
                }
                Text(directory).font(.caption.monospaced())
            }
            ForEach(visible) { entry in
                if entry.kind == "directory" {
                    Button { directory = entry.path; query = "" } label: {
                        Label(entry.path, systemImage: "folder")
                    }
                } else {
                    NavigationLink {
                        PathwayWorkspaceFileView(client: client, path: entry.path, assetURL: assetURL)
                    } label: { Label(entry.path, systemImage: "doc") }
                }
            }
            if truncated { Text("Some files are not included. Search to find files in larger workspaces.").font(.caption).foregroundStyle(.secondary) }
        }.navigationTitle("Files").searchable(text: $query)
            .task(id: query) { await load() }
            .refreshable { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let result: PathwayWorkspaceEntries
            if query.isEmpty { result = try await client.call("projects.listEntries", client.cwdPayload) }
            else {
                result = try await client.call("projects.searchEntries", ["cwd": .string(client.context.cwd), "query": .string(String(query.prefix(256))), "limit": .number(200)])
            }
            try Task.checkCancellation()
            entries = result.entries; truncated = result.truncated; error = nil
        } catch is CancellationError { } catch { self.error = error.localizedDescription }
    }
}

struct PathwayWorkspaceFileView: View {
    let client: PathwayWorkspaceClient
    let path: String
    var assetURL: PathwayWorkspaceAssetURL?
    @Environment(\.openURL) private var openURL
    @State private var original: PathwayWorkspaceFile?
    @State private var contents = ""
    @State private var truncated = false
    @State private var editing = false
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var confirmSave = false
    @State private var confirmReload = false
    var body: some View {
        VStack(alignment: .leading) {
            if let error { Text(error).foregroundStyle(.red).padding(.horizontal) }
            if let notice { Text(notice).foregroundStyle(.secondary).padding(.horizontal) }
            if original != nil && original?.revision == nil && !truncated { Text("Update the environment server to enable revision-protected editing.").foregroundStyle(.secondary).padding(.horizontal) }
            if truncated { Text("Partial file: editing is disabled to preserve the rest of the file.").foregroundStyle(.orange).padding(.horizontal) }
            if busy { ProgressView().padding() }
            if editing {
                TextEditor(text: $contents).font(.caption.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never).disabled(busy)
            } else {
                ScrollView([.vertical, .horizontal]) {
                    Text(contents).font(.caption.monospaced()).textSelection(.enabled).padding()
                }
            }
        }.navigationTitle(URL(fileURLWithPath: path).lastPathComponent)
            .toolbar {
                Menu {
                    Button(editing ? "View" : "Edit") { editing.toggle() }.disabled(original?.revision == nil || truncated || !client.context.canMutate)
                    Button("Save") { confirmSave = true }.disabled(original?.revision == nil || truncated || contents == original?.contents || !client.context.canMutate)
                    Button("Reload") { if contents != original?.contents { confirmReload = true } else { Task { await load() } } }
                    if let assetURL {
                        Button("Open original file") { Task { do { openURL(try await assetURL(path)) } catch { self.error = error.localizedDescription } } }
                    }
                    if original != nil { ShareLink("Share text", item: contents) }
                } label: { Image(systemName: "ellipsis.circle") }.disabled(busy)
            }
            .task { await load() }
            .confirmationDialog("Save changes to this file?", isPresented: $confirmSave) {
                Button("Save file") { Task { await save() } }
                Button("Cancel", role: .cancel) { }
            } message: { Text("This writes to \(path) in the thread's workspace.") }
            .confirmationDialog("Discard unsaved edits and reload?", isPresented: $confirmReload) {
                Button("Reload", role: .destructive) { Task { await load() } }
                Button("Cancel", role: .cancel) { }
            }
    }
    private func load() async {
        busy = true; defer { busy = false }
        do {
            let file = try await client.readFile(path)
            contents = file.contents; original = file; truncated = file.truncated; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func save() async {
        guard let original else { return }
        busy = true; defer { busy = false }
        do {
            let revision = try await client.saveFile(path, original: original, contents: contents)
            self.original = PathwayWorkspaceFile(contents: contents, truncated: false, byteLength: contents.utf8.count, revision: revision); notice = "File saved"; error = nil; editing = false
        } catch { self.error = error.localizedDescription }
    }
}
