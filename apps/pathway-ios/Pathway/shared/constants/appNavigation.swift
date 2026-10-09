import Foundation

enum AppDestination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case issues
    case agentThreads

    static let sidebarSections: [AppDestinationSection] = [
        AppDestinationSection(id: "workspace", title: "Workspace", destinations: allCases)
    ]

    var id: Self { self }

    var title: String {
        switch self {
        case .issues: "Tasks"
        case .agentThreads: "Agent Threads"
        }
    }

    var systemImage: String {
        switch self {
        case .issues: "checklist"
        case .agentThreads: "bubble.left.and.bubble.right"
        }
    }

    var description: String {
        switch self {
        case .issues: "Track work that needs attention across your environments."
        case .agentThreads: "Continue conversations with your Pathway agents."
        }
    }

    var contextDestinations: [AppContextDestination] {
        switch self {
        case .issues:
            [
                .init(id: "all", title: "All tasks", systemImage: "checklist"),
                .init(id: "assigned", title: "Assigned to me", systemImage: "person.crop.circle"),
                .init(id: "triage", title: "Triage", systemImage: "tray")
            ]
        case .agentThreads:
            [
                .init(id: "all", title: "All threads", systemImage: "bubble.left.and.bubble.right"),
                .init(id: "running", title: "Running", systemImage: "bolt"),
                .init(id: "needs-attention", title: "Needs attention", systemImage: "exclamationmark.circle")
            ]
        }
    }

    var defaultContextDestination: AppContextDestination {
        contextDestinations[0]
    }
}

struct AppDestinationSection: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let destinations: [AppDestination]
}

struct AppContextDestination: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let systemImage: String
}

enum AppShellLayout: Equatable, Sendable {
    case compact
    case sidebar
    case spatial

    static func resolve(usesRegularWidth: Bool, isVisionOS: Bool) -> AppShellLayout {
        if isVisionOS {
            return .spatial
        }
        return usesRegularWidth ? .sidebar : .compact
    }
}

enum PathwayWindow: String {
    case agentOrchestrator = "agent-orchestrator"
    case settings
}
