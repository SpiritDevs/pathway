import Foundation

enum AppDestination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case dashboard
    case issues
    case agentThreads
    case email
    case sourceControl
    case calendar
    case projects
    case contacts
    case timeTracker

    static let compactDestinations: [AppDestination] = [
        .dashboard,
        .issues,
        .agentThreads
    ]

    static let sidebarSections: [AppDestinationSection] = [
        AppDestinationSection(
            id: "workspace",
            title: "Workspace",
            destinations: [.dashboard, .issues, .agentThreads]
        ),
        AppDestinationSection(
            id: "work",
            title: "Work",
            destinations: [.projects, .sourceControl, .timeTracker]
        ),
        AppDestinationSection(
            id: "connected-apps",
            title: "Connected apps",
            destinations: [.email, .calendar, .contacts]
        )
    ]

    var id: Self { self }

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .issues: "Issues"
        case .agentThreads: "Agent Threads"
        case .email: "Email"
        case .sourceControl: "Source Control"
        case .calendar: "Calendar"
        case .projects: "Projects"
        case .contacts: "Contacts"
        case .timeTracker: "Time Tracker"
        }
    }

    var systemImage: String {
        switch self {
        case .dashboard: "square.grid.2x2"
        case .issues: "checklist"
        case .agentThreads: "bubble.left.and.bubble.right"
        case .email: "envelope"
        case .sourceControl: "arrow.triangle.branch"
        case .calendar: "calendar"
        case .projects: "folder"
        case .contacts: "person.2"
        case .timeTracker: "clock"
        }
    }

    var description: String {
        switch self {
        case .dashboard: "Your Pathway workspace overview will appear here."
        case .issues: "Track work that needs attention across your environments."
        case .agentThreads: "Continue conversations with your Pathway agents."
        case .email: "Read and work through your email with Pathway."
        case .sourceControl: "Review repositories, changes, and source control activity."
        case .calendar: "View your schedule and upcoming events."
        case .projects: "Organize work across your Pathway projects."
        case .contacts: "Find the people and teams you work with."
        case .timeTracker: "Track where your working time goes."
        }
    }

    var contextDestinations: [AppContextDestination] {
        switch self {
        case .dashboard:
            [
                .init(id: "overview", title: "Overview", systemImage: "square.grid.2x2"),
                .init(id: "activity", title: "Activity", systemImage: "waveform.path.ecg")
            ]
        case .issues:
            [
                .init(id: "all", title: "All issues", systemImage: "checklist"),
                .init(id: "assigned", title: "Assigned to me", systemImage: "person.crop.circle")
            ]
        case .agentThreads:
            [
                .init(
                    id: "all",
                    title: "All threads",
                    systemImage: "bubble.left.and.bubble.right"
                ),
                .init(id: "running", title: "Running", systemImage: "bolt"),
                .init(
                    id: "needs-attention",
                    title: "Needs attention",
                    systemImage: "exclamationmark.circle"
                )
            ]
        case .email:
            [
                .init(id: "inbox", title: "Inbox", systemImage: "tray"),
                .init(id: "starred", title: "Starred", systemImage: "star"),
                .init(id: "sent", title: "Sent", systemImage: "paperplane")
            ]
        case .sourceControl:
            [
                .init(id: "repositories", title: "Repositories", systemImage: "shippingbox"),
                .init(id: "changes", title: "Changes", systemImage: "arrow.triangle.branch"),
                .init(id: "pull-requests", title: "Pull requests", systemImage: "arrow.triangle.pull")
            ]
        case .calendar:
            [
                .init(id: "schedule", title: "Schedule", systemImage: "calendar"),
                .init(id: "upcoming", title: "Upcoming", systemImage: "calendar.badge.clock")
            ]
        case .projects:
            [
                .init(id: "all", title: "All projects", systemImage: "folder"),
                .init(id: "recent", title: "Recent", systemImage: "clock.arrow.circlepath"),
                .init(id: "archived", title: "Archived", systemImage: "archivebox")
            ]
        case .contacts:
            [
                .init(id: "people", title: "People", systemImage: "person.2"),
                .init(id: "teams", title: "Teams", systemImage: "person.3")
            ]
        case .timeTracker:
            [
                .init(id: "today", title: "Today", systemImage: "clock"),
                .init(id: "this-week", title: "This week", systemImage: "calendar.day.timeline.left"),
                .init(id: "reports", title: "Reports", systemImage: "chart.bar")
            ]
        }
    }

    var defaultContextDestination: AppContextDestination {
        contextDestinations[0]
    }

    var isCompactDestination: Bool {
        Self.compactDestinations.contains(self)
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
