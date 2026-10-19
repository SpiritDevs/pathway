import Foundation
import SwiftUI

struct AgentThreadStashAttachment: Sendable {
    let name: String
    let mimeType: String
    let data: Data
}

struct AgentThreadPromptStashEntry: Codable, Identifiable, Equatable, Sendable {
    struct Attachment: Codable, Equatable, Sendable {
        let name: String
        let mimeType: String
        let fileName: String
        let sizeBytes: Int
    }
    let id: String
    let createdAt: Date
    let prompt: String
    let attachments: [Attachment]
}

/// An account-scoped stash carries prompts between threads without changing their model selection.
/// The index is committed only after attachment bytes are durable.
actor AgentThreadPromptStash {
    private let directory: URL
    private let maximumBytes: Int
    private var cachedEntries: [AgentThreadPromptStashEntry]?

    init(directory: URL, maximumBytes: Int = 100 * 1024 * 1024) {
        self.directory = directory
        self.maximumBytes = maximumBytes
    }

    func entries() throws -> [AgentThreadPromptStashEntry] {
        if let cachedEntries { return cachedEntries }
        let index = directory.appending(path: "index.json")
        guard FileManager.default.fileExists(atPath: index.path) else { cachedEntries = []; return [] }
        let entries = try JSONDecoder().decode([AgentThreadPromptStashEntry].self, from: Data(contentsOf: index))
        guard entries.count <= 20, Set(entries.map(\.id)).count == entries.count,
              entries.allSatisfy({ entry in
                UUID(uuidString: entry.id) != nil && entry.attachments.count <= 8
                    && entry.attachments.enumerated().allSatisfy { index, attachment in
                        attachment.fileName == "\(index).data" && (1...50 * 1024 * 1024).contains(attachment.sizeBytes)
                    }
              }) else { throw PathwayThreadConversationError.message("The saved prompt index could not be read.") }
        cachedEntries = entries
        return entries
    }

    @discardableResult
    func save(prompt: String, attachments: [AgentThreadStashAttachment]) throws -> AgentThreadPromptStashEntry {
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !attachments.isEmpty else {
            throw PathwayThreadConversationError.message("Write a message or attach a file before stashing.")
        }
        guard attachments.count <= 8 else { throw PathwayThreadConversationError.message("A saved prompt can contain up to 8 attachments.") }
        guard attachments.allSatisfy({ !$0.data.isEmpty && $0.data.count <= 50 * 1024 * 1024 }) else {
            throw PathwayThreadConversationError.message("Each attachment must contain data and be no larger than 50 MB.")
        }
        let previous = try entries()
        let entry = AgentThreadPromptStashEntry(id: UUID().uuidString, createdAt: Date(), prompt: prompt,
            attachments: attachments.enumerated().map { index, attachment in
                .init(name: attachment.name, mimeType: attachment.mimeType, fileName: "\(index).data", sizeBytes: attachment.data.count)
            })
        let next = Array(([entry] + previous).prefix(20))
        guard next.flatMap(\.attachments).reduce(0, { $0 + $1.sizeBytes }) <= maximumBytes else {
            throw PathwayThreadConversationError.message("The prompt stash is full. Remove a saved prompt before adding more attachments.")
        }
        let folder = directory.appending(path: entry.id, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for (metadata, attachment) in zip(entry.attachments, attachments) {
                try attachment.data.write(to: folder.appending(path: metadata.fileName), options: .atomic)
            }
            try writeIndex(next)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        cachedEntries = next
        for old in previous where !next.contains(where: { $0.id == old.id }) {
            try? FileManager.default.removeItem(at: directory.appending(path: old.id, directoryHint: .isDirectory))
        }
        return entry
    }

    func attachments(for id: String) throws -> [AgentThreadStashAttachment] {
        guard let entry = try entries().first(where: { $0.id == id }) else {
            throw PathwayThreadConversationError.message("This saved prompt was already removed.")
        }
        let folder = directory.appending(path: entry.id, directoryHint: .isDirectory)
        return try entry.attachments.map { attachment in
            .init(name: attachment.name, mimeType: attachment.mimeType,
                  data: try Data(contentsOf: folder.appending(path: attachment.fileName)))
        }
    }

    func remove(id: String) throws {
        let previous = try entries()
        guard previous.contains(where: { $0.id == id }) else { return }
        let next = previous.filter { $0.id != id }
        try writeIndex(next)
        cachedEntries = next
        try? FileManager.default.removeItem(at: directory.appending(path: id, directoryHint: .isDirectory))
    }

    private func writeIndex(_ entries: [AgentThreadPromptStashEntry]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: directory.appending(path: "index.json"), options: .atomic)
    }

    nonisolated static func appending(_ restored: String, to current: String) -> String {
        guard !restored.isEmpty else { return current }
        guard !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return restored }
        return current.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) + "\n\n" + restored
    }
}

struct AgentThreadPromptStashSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: AgentThreadPromptStash
    let restore: (AgentThreadPromptStashEntry) async throws -> Void
    @State private var entries: [AgentThreadPromptStashEntry] = []
    @State private var isRestoring = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if entries.isEmpty {
                    ContentUnavailableView("No saved prompts", systemImage: "tray", description: Text("Stash a draft to reuse it in any thread."))
                }
                ForEach(entries) { entry in
                    Button {
                        isRestoring = true
                        Task {
                            defer { isRestoring = false }
                            do { try await restore(entry); dismiss() }
                            catch { errorMessage = error.localizedDescription }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.prompt.isEmpty ? "Attachments" : entry.prompt).lineLimit(3).foregroundStyle(.primary)
                            HStack {
                                Text(entry.createdAt, style: .relative)
                                if !entry.attachments.isEmpty { Label("\(entry.attachments.count)", systemImage: "paperclip") }
                            }.font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(isRestoring)
                    .swipeActions {
                        Button("Delete", role: .destructive) {
                            Task {
                                do { try await store.remove(id: entry.id); entries = try await store.entries() }
                                catch { errorMessage = error.localizedDescription }
                            }
                        }.disabled(isRestoring)
                    }
                }
            }
            .navigationTitle("Saved prompts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do { entries = try await store.entries() }
                catch { errorMessage = error.localizedDescription }
            }
            .alert("Couldn't restore prompt", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
        }
    }
}
