import SwiftUI
import UniformTypeIdentifiers

/// Local deliverable links are opened through the owning environment, never the viewer's disk.
struct AgentMarkdownFileLink: View {
    let source: String
    let label: String
    let context: AgentMarkdownImageContext
    @Environment(\.markdownImageWorkspaceRoot) private var workspaceRoot
    @State private var preview = false
    private var resolved: PathwayMarkdownImageSource {
        PathwayMarkdownImageSource.resolve(source, workspace: context.model.thread.shell.worktreePath ?? context.model.thread.shell.conversationPath ?? workspaceRoot)
    }
    private var name: String {
        if case .workspace(let path) = resolved { return URL(fileURLWithPath: path).lastPathComponent }
        return label.isEmpty ? "File" : label
    }
    private var mime: String { UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream" }
    var body: some View {
        Button { preview = true } label: {
            Label(label.isEmpty ? name : label, systemImage: mime.hasPrefix("video/") ? "video" : "doc")
                .lineLimit(2).padding(12).background(.quaternary, in: .rect(cornerRadius: 12))
        }.buttonStyle(.plain)
        .accessibilityHint("Open the file from this thread's environment")
        .sheet(isPresented: $preview) {
            AgentTranscriptAttachmentPreview(
                attachment: PathwayMessageAttachment(id: source, type: mime.hasPrefix("image/") ? "image" : "file", name: name, mimeType: mime, sizeBytes: 0),
                model: context.model, initialURL: nil, markdownSource: resolved, sourceThreadID: context.threadID)
        }
    }
}
