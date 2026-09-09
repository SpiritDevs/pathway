import SwiftUI

struct PathwayStorageSettingsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var bytes = 0
    @State private var clearing = false
    @State private var confirm = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("Downloaded history") {
                LabeledContent("Saved on this device", value: ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                Button("Clear downloaded history", role: .destructive) { confirm = true }
                    .disabled(clearing || appModel.localStorageDirectory == nil)
                Text("This removes saved discovery and conversation history for this account. Open conversations can save fresh copies while connected. Unsent drafts and saved prompts are kept.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Storage")
        .task(id: appModel.localStorageDirectory) { await refresh() }
        .confirmationDialog("Clear this account's downloaded history?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Clear downloaded history", role: .destructive) {
                Task {
                    guard let directory = appModel.localStorageDirectory else { return }
                    clearing = true
                    do { try await PathwayDownloadedHistory.clear(directory: directory); error = nil }
                    catch { self.error = error.localizedDescription }
                    clearing = false
                    await refresh()
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
    private func refresh() async {
        guard let directory = appModel.localStorageDirectory else { bytes = 0; return }
        let size = await PathwayDownloadedHistory.size(directory: directory)
        if directory == appModel.localStorageDirectory { bytes = size }
    }
}

actor PathwayDownloadedHistory {
    private static func paths(_ directory: URL) -> [URL] {
        [directory.appending(path: "Discovery.json"), directory.appending(path: "AgentThreads"), directory.appending(path: "EnvironmentStorage")]
    }
    static func size(directory: URL) async -> Int {
        await Task.detached {
            paths(directory).reduce(0) { sum, path in
                if path.pathExtension == "json" { return sum + ((try? path.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
                let files = (try? FileManager.default.contentsOfDirectory(at: path, includingPropertiesForKeys: [.fileSizeKey])) ?? []
                return sum + files.filter { $0.pathExtension == "json" }.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            }
        }.value
    }
    static func clear(directory: URL) async throws {
        try await Task.detached {
            for path in paths(directory) where FileManager.default.fileExists(atPath: path.path) {
                try FileManager.default.removeItem(at: path)
            }
        }.value
    }
}
