import SwiftUI

struct AgentMarkdownFileLinks: ViewModifier {
    let context: AgentMarkdownImageContext?
    @Environment(\.openURL) private var openURL
    @State private var selectedFile: PathwayMarkdownFileLink?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                if context != nil, let file = PathwayMarkdownFileLink(url: url) {
                    selectedFile = file
                } else {
                    openURL(url)
                }
                return .handled
            })
            .sheet(item: $selectedFile) { file in
                if let context { AgentMarkdownFileDestination(file: file, context: context) }
            }
    }
}

private struct AgentMarkdownFileDestination: View {
    let file: PathwayMarkdownFileLink
    let context: AgentMarkdownImageContext
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    private var thread: PathwayAgentThread? {
        appModel.cloud.threads.filter {
            $0.threadId == context.threadID && $0.companyId == context.model.thread.companyId
                && $0.environmentId == context.model.thread.environmentId && $0.shell.deletedAt == nil
        }.max { $0.cloudUpdatedAt < $1.cloudUpdatedAt }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let thread, let connect = appModel.connect,
                   let environment = appModel.cloud.environments.first(where: {
                       $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId
                           && $0.environment.state == "active"
                   }) {
                    PathwayWorkspaceDestination(thread: thread, environment: environment, projectRoot: "",
                        connect: connect, storageDirectory: appModel.localStorageDirectory, fileLink: file)
                } else {
                    ContentUnavailableView("File unavailable", systemImage: "doc.badge.ellipsis",
                        description: Text("Reconnect to this thread's environment to open the linked file."))
                }
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
