import Foundation

/// What the Create project sheet collects. Name and repository name follow their suggestions
/// until the user types their own.
struct PathwayProjectCreationDraft: Equatable {
    enum Source: String, CaseIterable, Identifiable {
        case folders, clone, newRepository

        var id: String { rawValue }
        var title: String {
            switch self {
            case .folders: "Folders"
            case .clone: "Clone repository"
            case .newRepository: "New GitHub repository"
            }
        }
    }

    struct Row: Identifiable, Equatable {
        var id = UUID()
        var environmentID: String
        var path = ""
    }

    var customName: String?
    var icon: PathwayProjectIcon?
    var focusID = ""
    var companyID = ""
    var source = Source.folders
    /// Clone source: "owner/name" on GitHub or any git URL.
    var repository = ""
    var repositoryOwner = ""
    var customRepositoryName: String?
    var visibility = "private"
    var rows: [Row] = []
    /// Where a folder-less project lives, and the environment new rows start on.
    var defaultEnvironmentID = ""

    var suggestedName: String {
        let folder = rows.lazy.map { PathwayProjectCreation.folderName($0.path) }.first { !$0.isEmpty } ?? ""
        if folder.isEmpty && source == .clone { return PathwayProjectCreation.repositoryName(repository) }
        return folder
    }

    var name: String { customName ?? suggestedName }
    var repositoryName: String { customRepositoryName ?? PathwayProjectCreation.slug(name) }
    var repositoryNameWithOwner: String {
        "\(repositoryOwner.trimmingCharacters(in: .whitespacesAndNewlines))/\(repositoryName.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    /// Only a Folders project may start without a folder; it lands on the default environment.
    var plannedRows: [Row] {
        rows.isEmpty && source == .folders ? [Row(environmentID: defaultEnvironmentID)] : rows
    }

    var canCreate: Bool {
        func filled(_ value: String) -> Bool { !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard filled(name), filled(companyID), !plannedRows.isEmpty,
              plannedRows.allSatisfy({ filled($0.environmentID) }),
              rows.allSatisfy({ filled($0.path) }) else { return false }
        switch source {
        case .folders: return true
        case .clone: return filled(repository)
        case .newRepository: return filled(repositoryOwner) && filled(repositoryName)
        }
    }
}

enum PathwayProjectCreationError: LocalizedError {
    case incomplete
    case environmentUnavailable
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .incomplete: "Complete the project name, owner, source, and folders."
        case .environmentUnavailable: "That environment is no longer connected to this workspace."
        case let .invalidResponse(step): "The environment returned an unexpected response while \(step)."
        }
    }
}

enum PathwayProjectCreation {
    static let longTimeout: Duration = .seconds(300)

    /// The folder's last path component, for the default project name.
    static func folderName(_ path: String) -> String {
        let components = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
        guard let last = components.last, last != "~" else { return "" }
        return String(last)
    }

    /// "owner/name", "https://github.com/owner/name.git" and "git@github.com:owner/name.git" all give "name".
    static func repositoryName(_ repository: String) -> String {
        let last = repository.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == "/" || $0 == ":" }).last.map(String.init) ?? ""
        return last.hasSuffix(".git") ? String(last.dropLast(4)) : last
    }

    /// A GitHub-safe repository name: lowercase ASCII words joined by dashes.
    static func slug(_ value: String) -> String {
        let folded: String = value.folding(options: .diacriticInsensitive, locale: nil).lowercased()
        return folded.split(whereSeparator: { !($0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_")) })
            .joined(separator: "-")
    }

    /// A bare "owner/name" clones from GitHub; anything else is a git remote URL.
    static func cloneSource(_ repository: String) -> [String: JSONValue] {
        let value = repository.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.range(of: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", options: .regularExpression) != nil {
            return ["provider": .string("github"), "repository": .string(value)]
        }
        return ["remoteUrl": .string(value)]
    }

    static func projectCreatePayload(projectID: String, commandID: String, title: String, workspaceRoot: String?) -> JSONValue {
        var payload: [String: JSONValue] = [
            "type": .string("project.create"), "commandId": .string(commandID), "projectId": .string(projectID),
            "title": .string(title), "workspaceRoot": workspaceRoot.map(JSONValue.string) ?? .null
        ]
        if workspaceRoot != nil { payload["createWorkspaceRootIfMissing"] = .bool(true) }
        return .object(payload)
    }

    /// Links a created local project to the company. The first row creates the cloud project;
    /// later rows join it by id so every environment shares one project.
    static func ensureArguments(
        companyID: String, environmentID: String, cloudProjectID: String?, name: String, project: JSONValue, fallbackRoot: String?
    ) -> JSONValue {
        let fields = project.objectValue ?? [:]
        var arguments: [String: JSONValue] = [
            "companyId": .string(companyID), "environmentId": .string(environmentID),
            "localProjectId": fields["id"] ?? .null,
            "localWorkspaceRoot": fields["workspaceRoot"] ?? fallbackRoot.map(JSONValue.string) ?? .null,
            "repositoryIdentity": fields["repositoryIdentity"] ?? .null,
            "name": .string(name), "matchRepository": .bool(false)
        ]
        if let internalRoot = fields["internalWorkspaceRoot"] { arguments["internalWorkspaceRoot"] = internalRoot }
        if let cloudProjectID { arguments["cloudProjectId"] = .string(cloudProjectID) }
        return .object(arguments)
    }

    static func iconArguments(companyID: String, cloudProjectID: String, icon: PathwayProjectIcon?) -> JSONValue {
        .object(["companyId": .string(companyID), "cloudProjectId": .string(cloudProjectID), "icon": icon?.json ?? .null])
    }
}

/// Runs the Create project sequence: set up each environment's folder, create its local project,
/// link it to one cloud project, then apply the icon and Focus.
@MainActor
struct PathwayProjectCreator {
    typealias EnvironmentRequest = @MainActor (_ environmentID: String, _ method: String, _ payload: JSONValue, _ timeout: Duration) async throws -> JSONValue
    typealias CloudMutation = @MainActor (_ name: String, _ arguments: JSONValue) async throws -> JSONValue

    let environmentRequest: EnvironmentRequest
    let cloudMutation: CloudMutation
    var progress: @MainActor (String) -> Void = { _ in }
    var makeID: @MainActor () -> String = { UUID().uuidString.lowercased() }

    /// Returns the cloud project id.
    func create(_ draft: PathwayProjectCreationDraft) async throws -> String {
        guard draft.canCreate else { throw PathwayProjectCreationError.incomplete }
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        var cloudProjectID: String?
        var projectKeys: [String] = []
        var newRepositoryURL: String?
        for (index, row) in draft.plannedRows.enumerated() {
            let path = row.path.trimmingCharacters(in: .whitespacesAndNewlines)
            var root: String? = path.isEmpty ? nil : path
            switch draft.source {
            case .folders:
                break
            case .newRepository where index == 0:
                progress("Creating \(draft.repositoryNameWithOwner)…")
                _ = try await environmentRequest(row.environmentID, "vcs.init",
                    .object(["cwd": .string(path), "createDirectory": .bool(true)]), PathwayProjectCreation.longTimeout)
                let published = try await environmentRequest(row.environmentID, "sourceControl.publishRepository", .object([
                    "cwd": .string(path), "provider": .string("github"),
                    "repository": .string(draft.repositoryNameWithOwner), "visibility": .string(draft.visibility)
                ]), PathwayProjectCreation.longTimeout)
                guard let url = published.objectValue?["repository"]?.objectValue?["sshUrl"]?.stringValue else {
                    throw PathwayProjectCreationError.invalidResponse("publishing the repository")
                }
                newRepositoryURL = url
            case .clone, .newRepository:
                progress("Cloning into \(path)…")
                var payload: [String: JSONValue] = ["destinationPath": .string(path)]
                // A second environment clones the repository the first one just published.
                if let newRepositoryURL { payload["remoteUrl"] = .string(newRepositoryURL) }
                else { payload.merge(PathwayProjectCreation.cloneSource(draft.repository)) { _, new in new } }
                let cloned = try await environmentRequest(row.environmentID, "sourceControl.cloneRepository",
                    .object(payload), PathwayProjectCreation.longTimeout)
                guard let cwd = cloned.objectValue?["cwd"]?.stringValue else {
                    throw PathwayProjectCreationError.invalidResponse("cloning the repository")
                }
                root = cwd
            }
            progress("Adding \(name)…")
            let localProjectID = makeID()
            let project = try await environmentRequest(row.environmentID, "projects.mutate",
                PathwayProjectCreation.projectCreatePayload(projectID: localProjectID, commandID: makeID(), title: name, workspaceRoot: root),
                .seconds(30))
            var created = project.objectValue ?? [:]
            created["id"] = created["id"] ?? .string(localProjectID)
            let linked = try await cloudMutation("cloudProjects:ensureEnvironmentProject", PathwayProjectCreation.ensureArguments(
                companyID: draft.companyID, environmentID: row.environmentID, cloudProjectID: cloudProjectID,
                name: name, project: .object(created), fallbackRoot: root))
            if cloudProjectID == nil {
                guard let id = linked.stringValue else { throw PathwayProjectCreationError.invalidResponse("linking the project") }
                cloudProjectID = id
            }
            projectKeys.append("\(row.environmentID):\(created["id"]?.stringValue ?? localProjectID)")
        }
        guard let cloudProjectID else { throw PathwayProjectCreationError.incomplete }
        if let icon = draft.icon {
            _ = try await cloudMutation("cloudProjects:setCompanyProjectIcon",
                PathwayProjectCreation.iconArguments(companyID: draft.companyID, cloudProjectID: cloudProjectID, icon: icon))
        }
        if !draft.focusID.isEmpty {
            for key in projectKeys {
                _ = try await cloudMutation("focuses:assignProject", .object(["focusId": .string(draft.focusID), "projectKey": .string(key)]))
            }
        }
        return cloudProjectID
    }
}

/// `sourceControl.listRepositoryOwners`: the signed-in user first, then their organizations.
struct PathwayRepositoryOwners: Decodable {
    struct Owner: Decodable, Identifiable, Equatable {
        let login: String
        let kind: String
        var id: String { login }
    }

    let owners: [Owner]
}

/// `filesystem.browse` result for picking a folder on an environment.
struct PathwayDirectoryListing: Decodable {
    struct Entry: Decodable, Identifiable, Equatable {
        let name: String
        let fullPath: String
        var id: String { fullPath }
    }

    let parentPath: String
    let entries: [Entry]
}
