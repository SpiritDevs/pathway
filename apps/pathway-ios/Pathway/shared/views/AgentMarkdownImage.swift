import SwiftUI

extension EnvironmentValues {
    @Entry var markdownImageWorkspaceRoot: String? = nil
}

struct AgentMarkdownImageContext: Equatable {
    let model: PathwayAgentThreadModel
    let threadID: String

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.model === rhs.model && lhs.threadID == rhs.threadID }
}

struct AgentMarkdownImage: View {
    let source: String
    let alt: String
    let link: URL?
    let context: AgentMarkdownImageContext
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.markdownImageWorkspaceRoot) private var workspaceRoot
    @State private var url: URL?
    @State private var failure: String?
    @State private var attempt = 0
    @State private var showPreview = false

    private struct LoadKey: Equatable {
        let model: ObjectIdentifier
        let threadID: String
        let source: String
        let workspaceRoot: String?
        let connected: Bool
        let active: Bool
        let attempt: Int
    }
    private var loadKey: LoadKey {
        LoadKey(model: ObjectIdentifier(context.model), threadID: context.threadID, source: source, workspaceRoot: imageWorkspaceRoot,
                connected: context.model.isSubscriptionReady, active: scenePhase == .active, attempt: attempt)
    }
    private var imageWorkspaceRoot: String? {
        context.model.thread.shell.worktreePath ?? context.model.thread.shell.conversationPath ?? workspaceRoot
    }
    private var resolvedSource: PathwayMarkdownImageSource {
        PathwayMarkdownImageSource.resolve(source, workspace: imageWorkspaceRoot)
    }

    var body: some View {
        Group {
            if let failure { unavailable(failure) }
            else if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        Button {
                            if let link { openURL(link) } else { showPreview = true }
                        } label: {
                            image.resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 360)
                                .clipShape(.rect(cornerRadius: 12)).accessibilityLabel(alt.isEmpty ? "Image" : alt)
                        }.buttonStyle(.plain).accessibilityLabel(alt.isEmpty ? "Image" : alt)
                    case .failure: unavailable("The file may have moved, or access expired.")
                    default: loading
                    }
                }
                .id("\(url.absoluteString):\(attempt)")
            } else { loading }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: loadKey) {
            let key = loadKey
            guard key.active else { return }
            url = nil; failure = nil
            do {
                let result: URL
                switch resolvedSource {
                case .web(let remote): result = remote
                case .workspace(let path):
                    guard key.connected else { throw PathwayThreadConversationError.message("Connect to this thread's environment to view the image.") }
                    result = try await context.model.markdownImageURL(path, threadID: context.threadID)
                case .unavailable: throw PathwayThreadConversationError.message("This image reference is unavailable. Use a workspace path or an HTTPS image URL.")
                }
                try Task.checkCancellation()
                guard key == loadKey else { return }
                url = result
            } catch {
                guard !Task.isCancelled, key == loadKey else { return }
                failure = error.localizedDescription
            }
        }
        .sheet(isPresented: $showPreview) {
            AgentTranscriptAttachmentPreview(
                attachment: PathwayMessageAttachment(id: source, type: "image", name: alt.isEmpty ? "Image" : alt, mimeType: "image/*", sizeBytes: 0),
                model: context.model, initialURL: url, markdownSource: resolvedSource, sourceThreadID: context.threadID)
        }
    }

    private var loading: some View {
        Label("Loading \(alt.isEmpty ? "image" : alt)…", systemImage: "photo")
            .font(.caption).foregroundStyle(.secondary).frame(minHeight: 72)
    }
    private func unavailable(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(alt.isEmpty ? "Image unavailable" : alt, systemImage: "photo")
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("Retry image") { attempt += 1 }
        }.padding(12).background(.quaternary, in: .rect(cornerRadius: 12))
    }
}
