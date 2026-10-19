import SwiftUI

struct PathwayDashboardView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let newThreadAction: () -> Void
    var activityOnly = false

    var body: some View {
        List {
            if !activityOnly {
                Section("Work now") {
                    NavigationLink {
                        AgentThreadsView(newThreadAction: newThreadAction, initialFilter: .needsAttention)
                    } label: { Label("\(appModel.cloud.threads.filter(\.needsAction).count) threads need attention", systemImage: "exclamationmark.bubble") }
                    NavigationLink {
                        AgentThreadsView(newThreadAction: newThreadAction, initialFilter: .running)
                    } label: { Label("\(appModel.cloud.threads.filter(\.isRunning).count) agents running", systemImage: "bolt") }
                    NavigationLink("Shared Drafts") { PathwaySharedDraftsDestination() }
                    Button("Start agent thread", systemImage: "square.and.pencil", action: newThreadAction)
                }
                Section("Workspace") {
                    NavigationLink("Connect a server") { PathwayConnectionsDestination() }
                    LabeledContent("Companies", value: String(appModel.cloud.companies.count))
                    NavigationLink { PathwayProjectsDestination() } label: { LabeledContent("Projects", value: String(appModel.cloud.projects.count)) }
                    NavigationLink("Tasks") { PathwayIssuesDestinationView() }
                    NavigationLink("Calendar") { PathwayCalendarView(model: appModel.cloud.calendar, companies: appModel.cloud.companies) }
                }
            }
            Section("Recent activity") {
                ForEach(appModel.cloud.threads.filter { $0.shell.archivedAt == nil && $0.shell.deletedAt == nil }.sorted { $0.shell.updatedAt > $1.shell.updatedAt }.prefix(30)) { thread in
                    NavigationLink { AgentThreadDetailRoute(thread: thread) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(thread.shell.title)
                            Label(thread.shell.isConversation ? "Conversation" : appModel.cloud.projectName(companyId: thread.companyId, projectId: thread.cloudProjectId) ?? "Project",
                                systemImage: thread.shell.isConversation ? "bubble.left.and.bubble.right" : "folder")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let cachedAt = appModel.cloud.cachedAt, !appModel.cloud.isConnected {
                Label("Saved \(cachedAt.formatted())", systemImage: "wifi.slash").font(.caption)
            }
        }
        .navigationTitle(activityOnly ? "Activity" : "Dashboard")
        .refreshable { await appModel.cloud.retry() }
    }
}

struct PathwayProjectsDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    var initialFilter = "all"

    private struct RecentProject: Identifiable {
        let binding: PathwayCompanyEnvironmentBinding
        let environment: PathwayCompanyEnvironment
        let title: String
        let updatedAt: Date
        var id: String { binding.id }
    }

    private var recentProjects: [RecentProject] {
        var latestByBinding: [String: RecentProject] = [:]
        for thread in appModel.cloud.threads where thread.shell.deletedAt == nil {
            guard let environment = appModel.cloud.environments.first(where: {
                $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId && $0.environment.state == "active"
            }), let binding = appModel.cloud.environmentBindings.first(where: {
                $0.companyId == thread.companyId && $0.binding.environmentId == thread.environmentId
                    && $0.binding.localProjectId == thread.shell.projectId && $0.binding.cloudProjectId == thread.cloudProjectId
                    && $0.binding.status == "active"
            }) else { continue }
            if let existing = latestByBinding[binding.id], existing.updatedAt >= thread.sortDate { continue }
            latestByBinding[binding.id] = RecentProject(binding: binding, environment: environment,
                title: appModel.cloud.projectName(companyId: thread.companyId, projectId: thread.cloudProjectId) ?? "Project",
                updatedAt: thread.sortDate)
        }
        return latestByBinding.values.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        List {
            if initialFilter == "recent" {
                Section {
                    ForEach(recentProjects.prefix(20)) { project in
                        NavigationLink {
                            PathwayAdministrationProjectRoute(client: client(project.environment), projectID: project.binding.binding.localProjectId)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.title)
                                Text(project.environment.environment.label).font(.caption).foregroundStyle(.secondary)
                                Text(project.updatedAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: { Text("Projects ordered by their most recent thread activity.") }
                if recentProjects.isEmpty {
                    ContentUnavailableView("No recent projects", systemImage: "clock",
                        description: Text("Projects appear here when their threads have activity."))
                }
            } else {
                ForEach(appModel.cloud.environments) { environment in
                    NavigationLink {
                        PathwayAdministrationProjectsView(client: client(environment))
                    } label: { Label(environment.environment.label, systemImage: "desktopcomputer") }
                }
                if appModel.cloud.environments.isEmpty {
                    ContentUnavailableView("No connected environments", systemImage: "network",
                        description: Text("Connect an environment to manage its projects."))
                }
            }
        }
        .navigationTitle(initialFilter == "recent" ? "Recent projects" : "Projects")
    }

    private func client(_ environment: PathwayCompanyEnvironment) -> PathwayAdministrationClient {
        PathwayAdministrationClient(environment: environment,
            request: { environment, method, payload in
                try await appModel.cloud.environmentRequest(environment: environment, method: method, payload: payload)
            }, http: { environment, method, path, payload in
                guard let connect = appModel.connect else { throw URLError(.notConnectedToInternet) }
                return try await PathwayEnvironmentHTTP.request(environment: environment, connect: connect, method: method, path: path, payload: payload)
            })
    }
}
