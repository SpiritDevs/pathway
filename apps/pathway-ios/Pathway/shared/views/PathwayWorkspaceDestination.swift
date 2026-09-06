import SwiftUI

struct PathwayWorkspaceDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayAgentThread
    let environment: PathwayCompanyEnvironment
    let projectRoot: String
    let initialSection: String
    @State private var serverConfig: [String: JSONValue] = [:]
    @State private var configurationError: String?
    @State private var scripts: [PathwayWorkspaceScript] = []

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment, projectRoot: String,
         connect: PathwayConnectClient, storageDirectory: URL?, initialSection: String = "repositories") {
        self.thread = thread
        self.environment = environment
        self.projectRoot = projectRoot
        self.initialSection = initialSection
    }

    private var currentThread: PathwayAgentThread? { appModel.cloud.threads.first { $0.id == thread.id && $0.shell.deletedAt == nil } }
    private var currentEnvironment: PathwayCompanyEnvironment? {
        appModel.cloud.environments.first { $0.id == environment.id && $0.environment.state == "active" }
    }
    private var currentScope: PathwayWorkspaceScope? {
        guard let currentThread, currentEnvironment != nil,
              let binding = appModel.cloud.environmentBindings.first(where: {
                  $0.companyId == currentThread.companyId && $0.binding.environmentId == currentThread.environmentId
                      && $0.binding.localProjectId == currentThread.shell.projectId
                      && $0.binding.cloudProjectId == currentThread.cloudProjectId && $0.binding.status == "active"
              }) else { return nil }
        return .init(companyID: currentThread.companyId, environmentID: currentThread.environmentId,
                     threadID: currentThread.threadId, projectID: currentThread.shell.projectId,
                     projectRoot: binding.binding.localWorkspaceRoot, worktreePath: currentThread.shell.worktreePath)
    }
    private var canMutate: Bool {
        currentThread?.isRunning == false && currentScope != nil
            && appModel.cloud.connectedEnvironmentIDs.contains(environment.id)
    }
    private func context(_ scope: PathwayWorkspaceScope) -> PathwayWorkspaceContext {
        let capabilities = serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue
        return PathwayWorkspaceContext(threadID: scope.threadID, projectID: scope.projectID,
            cwd: scope.cwd, projectRoot: scope.projectRoot,
            supportsPullRequests: capabilities?["pullRequests"]?.boolValue == true,
            canMutate: canMutate, scripts: scripts)
    }

    var body: some View {
        Group {
            if let scope = currentScope, let currentEnvironment {
                workspace(scope: scope, environment: currentEnvironment)
            } else {
                ContentUnavailableView("Workspace unavailable", systemImage: "folder.badge.questionmark",
                    description: Text("This thread or its project binding is no longer available. Return to the thread list and reconnect."))
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let configurationError { Text(configurationError).font(.footnote).foregroundStyle(.red).padding() }
        }
    }

    private func workspace(scope: PathwayWorkspaceScope, environment: PathwayCompanyEnvironment) -> some View {
        PathwayWorkspaceView(context: context(scope),
            request: { method, payload in
                try PathwayWorkspaceScope.validate(method: method, payload: payload, expected: scope,
                    current: currentScope, canMutate: canMutate)
                var fields = payload.objectValue ?? [:]
                if method == "review.getDiffPreview" { fields["ignoreWhitespace"] = .bool(PathwayGeneralPreferences.shared.ignoreDiffWhitespace) }
                return try await appModel.cloud.environmentRequest(environment: environment, method: method, payload: .object(fields))
            },
            subscribe: { method, payload in
                guard method == "terminal.attach", payload.objectValue?["restartIfNotRunning"] == .bool(false) else {
                    throw PathwayWorkspaceError.unavailable
                }
                try PathwayWorkspaceScope.validate(method: method, payload: payload, expected: scope,
                    current: currentScope, canMutate: canMutate)
                return await appModel.cloud.environmentSubscription(environment: environment, method: method, payload: payload)
            },
            assetURL: { path in
                guard let connect = appModel.connect else { throw URLError(.notConnectedToInternet) }
                return try await PathwayEnvironmentHTTP.assetURL(path, threadID: scope.threadID,
                    environment: environment, connect: connect, request: { method, payload in
                        try PathwayWorkspaceScope.validate(method: method, payload: payload, expected: scope,
                            current: currentScope, canMutate: canMutate)
                        return try await appModel.cloud.environmentRequest(environment: environment, method: method, payload: payload)
                    })
            },
            postHTTP: { path, payload in
                guard path == "/api/pull-requests/diff", let connect = appModel.connect else { throw URLError(.badURL) }
                try PathwayWorkspaceScope.validate(method: "/api/pull-requests/diff", payload: payload, expected: scope,
                    current: currentScope, canMutate: canMutate)
                return try await PathwayEnvironmentHTTP.request(environment: environment, connect: connect, method: "POST", path: path, payload: payload)
            }, initialSection: initialSection)
            .task(id: scope) {
                serverConfig = [:]; scripts = []; configurationError = nil
                do {
                    let config = try await appModel.cloud.environmentRequest(environment: environment, method: "server.getConfig", payload: .object([:])).objectValue ?? [:]
                    try Task.checkCancellation()
                    guard currentScope == scope else { return }
                    serverConfig = config
                    if let connect = appModel.connect {
                        let payload = try await PathwayEnvironmentHTTP.request(environment: environment, connect: connect, method: "GET", path: "/api/projects")
                        let projects = try decodePathwayPayload(PathwayAdministrationProjects.self, from: payload)
                        try Task.checkCancellation()
                        guard currentScope == scope else { return }
                        scripts = projects.projects.first(where: { $0.id == scope.projectID })?.scripts.map {
                            PathwayWorkspaceScript(id: $0.id, name: $0.name, command: $0.command, previewUrl: $0.previewUrl)
                        } ?? []
                    }
                } catch is CancellationError {} catch {
                    if currentScope == scope { configurationError = error.localizedDescription }
                }
            }
    }

}

struct PathwaySourceControlDestination: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var query = ""
    var initialSection = "repositories"

    var body: some View {
        List {
            ForEach(appModel.cloud.threads.filter { thread in
                thread.shell.deletedAt == nil && thread.shell.archivedAt == nil
                    && (query.isEmpty || thread.shell.title.localizedStandardContains(query))
            }) { thread in
                if let environment = appModel.cloud.environments.first(where: { $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId }),
                   let binding = appModel.cloud.environmentBindings.first(where: { $0.companyId == thread.companyId && $0.binding.environmentId == thread.environmentId && $0.binding.localProjectId == thread.shell.projectId }),
                   let connect = appModel.connect {
                    NavigationLink {
                        PathwayWorkspaceDestination(thread: thread, environment: environment,
                            projectRoot: binding.binding.localWorkspaceRoot, connect: connect, storageDirectory: appModel.localStorageDirectory, initialSection: initialSection)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(thread.shell.title)
                            Text("\(thread.shell.branch ?? "Working tree") · \(environment.environment.label)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .overlay {
            if appModel.cloud.threads.isEmpty { ContentUnavailableView("No thread workspaces", systemImage: "arrow.triangle.branch", description: Text("Start an agent thread in a connected project to review its workspace.")) }
        }
        .searchable(text: $query, prompt: "Search workspaces")
        .navigationTitle((PathwayWorkspaceSection(rawValue: initialSection) ?? .repositories).title)
    }
}


/// Captured by a destination's transport so an old editor cannot silently act on
/// a different checkout after a project binding or worktree changes.
struct PathwayWorkspaceScope: Equatable {
    let companyID: String
    let environmentID: String
    let threadID: String
    let projectID: String
    let projectRoot: String
    let worktreePath: String?
    var cwd: String { worktreePath ?? projectRoot }

    static let readMethods: Set<String> = [
        "projects.readFile", "projects.listEntries", "projects.searchEntries",
        "pullRequests.list", "pullRequests.detail", "pullRequests.activity", "pullRequests.reviewerCandidates",
        "vcs.refreshStatus", "review.getDiffPreview", "vcs.listRefs", "orchestration.previewWorkspaceMove",
        "assets.createUrl", "terminal.attach", "/api/pull-requests/diff"
    ]

    static func validate(method: String, payload: JSONValue, expected: Self, current: Self?, canMutate: Bool) throws {
        guard current == expected else { throw PathwayWorkspaceScopeError.changed }
        guard readMethods.contains(method) || canMutate else { throw PathwayWorkspaceError.unavailable }
        guard let fields = payload.objectValue else { throw PathwayWorkspaceScopeError.changed }
        let terminal = method == "terminal.open" || method == "terminal.attach"
        let requiredCWD = terminal ? expected.projectRoot : expected.cwd
        for (key, value) in [("threadId", expected.threadID), ("projectId", expected.projectID), ("cwd", requiredCWD)] {
            if let provided = fields[key], provided != .string(value) { throw PathwayWorkspaceScopeError.changed }
        }
        let expectedWorktree: JSONValue = expected.worktreePath.map(JSONValue.string) ?? .null
        for key in ["worktreePath", "expectedWorktreePath"] {
            if let provided = fields[key], provided != expectedWorktree { throw PathwayWorkspaceScopeError.changed }
        }
        if let resource = fields["resource"]?.objectValue, let thread = resource["threadId"], thread != .string(expected.threadID) {
            throw PathwayWorkspaceScopeError.changed
        }
    }
}

enum PathwayWorkspaceScopeError: LocalizedError {
    case changed
    var errorDescription: String? { "This thread's workspace changed. Return to Workspace and reload before continuing; your edits have not been saved." }
}
