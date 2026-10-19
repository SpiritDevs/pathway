import SwiftUI

struct AgentThreadGitActionsMenu: View {
    let model: PathwayAgentThreadModel
    let workspaceRoot: String?
    let onSelectAction: () -> Void
    @State private var selectedAction: PathwayWorkspaceGitAction?

    var body: some View {
        Menu {
            if let workspaceRoot, let connect = model.connect {
                Section {
                    ForEach(PathwayWorkspaceGitAction.allCases) { action in
                        Button(action.title, systemImage: action.systemImage) {
                            onSelectAction()
                            selectedAction = action
                        }
                    }
                }
                Section {
                    NavigationLink {
                        PathwayWorkspaceDestination(thread: model.thread, environment: model.environment,
                            projectRoot: workspaceRoot, connect: connect, storageDirectory: model.storageDirectory,
                            initialSection: PathwayWorkspaceSection.changes.rawValue)
                    } label: { Label("Review changes & branches", systemImage: "arrow.triangle.branch") }
                    NavigationLink {
                        PathwayWorkspaceDestination(thread: model.thread, environment: model.environment,
                            projectRoot: workspaceRoot, connect: connect, storageDirectory: model.storageDirectory,
                            initialSection: PathwayWorkspaceSection.pullRequests.rawValue)
                    } label: { Label("Pull requests & reviews", systemImage: "arrow.triangle.pull") }
                }
            } else {
                Text("Connect this thread to a workspace to use Git actions.")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                Image(systemName: "chevron.down").font(.caption2)
            }
        }
        .accessibilityLabel("Git actions")
        .accessibilityIdentifier("agent-thread-git-actions")
        .sheet(item: $selectedAction) { action in
            NavigationStack {
                if let workspaceRoot, let connect = model.connect {
                    PathwayWorkspaceDestination(thread: model.thread, environment: model.environment,
                        projectRoot: workspaceRoot, connect: connect, storageDirectory: model.storageDirectory,
                        initialSection: PathwayWorkspaceSection.changes.rawValue, initialGitAction: action)
                }
            }
        }
    }
}
