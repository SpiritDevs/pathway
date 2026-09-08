import Foundation

struct PathwayWorkspaceContext: Equatable {
    let threadID: String
    let projectID: String?
    let cwd: String
    let projectRoot: String
    var supportsPullRequests = false
    var canMutate = true
    var scripts: [PathwayWorkspaceScript] = []
}

struct PathwayWorkspaceScript: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let command: String
    let previewUrl: String?
}

typealias PathwayWorkspaceSubscribe = @MainActor (String, JSONValue) async throws -> AsyncThrowingStream<JSONValue, Error>
typealias PathwayWorkspacePostHTTP = @MainActor (String, JSONValue) async throws -> JSONValue
typealias PathwayWorkspaceAssetURL = @MainActor (String) async throws -> URL

typealias PathwayWorkspaceRequest = @MainActor (String, JSONValue) async throws -> JSONValue

/// Uses the selected environment transport. Paths always belong to the selected thread's workspace.
@MainActor
struct PathwayWorkspaceClient {
    let context: PathwayWorkspaceContext
    let request: PathwayWorkspaceRequest

    func call<T: Decodable>(_ method: String, _ fields: [String: JSONValue] = [:]) async throws -> T {
        try await verifyConversationGitRoot(for: method)
        let result = try await request(method, .object(fields))
        return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(result))
    }

    func run(_ method: String, _ fields: [String: JSONValue]) async throws -> JSONValue {
        guard context.canMutate else { throw PathwayWorkspaceError.unavailable }
        try await verifyConversationGitRoot(for: method)
        return try await request(method, .object(fields))
    }

    private func verifyConversationGitRoot(for method: String) async throws {
        guard context.projectID == nil,
              method.hasPrefix("vcs.") || method.hasPrefix("git.") || method.hasPrefix("review.") else { return }
        let inspected = try await request("projects.inspectDirectory", .object(cwdPayload)).objectValue
        let root = inspected?["repositoryRoot"]?.stringValue
            ?? inspected?["repositoryIdentity"]?.objectValue?["rootPath"]?.stringValue
        guard root == context.cwd else { throw PathwayWorkspaceError.conversationRepository }
    }

    var cwdPayload: [String: JSONValue] { ["cwd": .string(context.cwd)] }
    func filePayload(_ path: String) -> [String: JSONValue] {
        ["cwd": .string(context.cwd), "relativePath": .string(path)]
    }

    func gitAction(_ action: String, message: String, paths: Set<String>) async throws -> String {
        var payload = cwdPayload
        payload["threadId"] = .string(context.threadID)
        payload["actionId"] = .string(UUID().uuidString)
        payload["action"] = .string(action)
        if action.contains("commit") {
            guard !paths.isEmpty, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw PathwayWorkspaceError.invalidCommit
            }
            payload["commitMessage"] = .string(message)
            payload["filePaths"] = .array(paths.sorted().map(JSONValue.string))
        }
        let result = try await run("git.runStackedAction", payload)
        return result.objectValue?["toast"]?.objectValue?["title"]?.stringValue ?? "Git action completed"
    }

    func readFile(_ path: String) async throws -> PathwayWorkspaceFile {
        try await call("projects.readFile", filePayload(path))
    }

    func saveFile(_ path: String, original: PathwayWorkspaceFile, contents: String) async throws -> String? {
        guard !original.truncated else { throw PathwayWorkspaceError.fileChanged }
        guard let revision = original.revision, !revision.isEmpty else { throw PathwayWorkspaceError.revisionUnavailable }
        var payload = filePayload(path)
        payload["contents"] = .string(contents)
        payload["expectedRevision"] = .string(revision)
        let result = try await run("projects.writeFile", payload)
        return result.objectValue?["revision"]?.stringValue
    }

    func terminalPayload(_ terminalID: String) -> [String: JSONValue] {
        ["threadId": .string(context.threadID), "terminalId": .string(terminalID)]
    }

    func openTerminal(_ terminalID: String) async throws -> PathwayWorkspaceTerminal {
        var payload = terminalPayload(terminalID)
        payload["cwd"] = .string(context.projectRoot)
        payload["worktreePath"] = context.cwd == context.projectRoot ? .null : .string(context.cwd)
        payload["cols"] = .number(80)
        payload["rows"] = .number(24)
        let result = try await run("terminal.open", payload)
        return try JSONDecoder().decode(PathwayWorkspaceTerminal.self, from: JSONEncoder().encode(result))
    }

}

enum PathwayWorkspaceError: LocalizedError {
    case unavailable, invalidCommit, fileChanged, revisionUnavailable, conversationRepository
    var errorDescription: String? {
        switch self {
        case .unavailable: "Reconnect and wait for the thread to finish before changing its workspace."
        case .invalidCommit: "Select files and enter a commit message."
        case .revisionUnavailable: "Update the environment server to enable revision-protected file editing."
        case .fileChanged: "This file changed on the environment. Reload it before saving your edit."
        case .conversationRepository: "Use Files or open a terminal in this folder to review its Git repositories. This folder has no verified repository at its root."
        }
    }
}

struct PathwayWorkspaceStatus: Decodable {
    let isRepo: Bool
    let refName: String?
    let hasWorkingTreeChanges: Bool
    let hasPrimaryRemote: Bool
    let hasUpstream: Bool
    let aheadCount: Int
    let behindCount: Int
    let workingTree: WorkingTree
    var canCreatePullRequest: Bool { isRepo && hasPrimaryRemote && !hasWorkingTreeChanges }
    struct WorkingTree: Decodable {
        let files: [File]
        struct File: Decodable, Identifiable {
            let path: String
            let insertions: Int
            let deletions: Int
            var id: String { path }
        }
    }
}
struct PathwayWorkspaceRefs: Decodable {
    let refs: [Ref]
    let nextCursor: Int?
    struct Ref: Decodable, Identifiable {
        let name: String
        let current: Bool
        let worktreePath: String?
        var id: String { name }
    }
}
struct PathwayWorkspaceDiff: Decodable {
    let sources: [Source]
    struct Source: Decodable, Identifiable {
        let id: String
        let title: String
        let diff: String
        let truncated: Bool
    }
}
struct PathwayWorkspaceEntries: Decodable {
    let entries: [Entry]
    let truncated: Bool
    struct Entry: Decodable, Identifiable {
        let path: String
        let kind: String
        var id: String { path }
    }
}
struct PathwayWorkspaceFile: Decodable {
    let contents: String
    let truncated: Bool
    let byteLength: Int
    var revision: String? = nil
}
struct PathwayWorkspaceTerminal: Decodable {
    let terminalId: String
    let status: String
    let history: String
    let label: String
}
struct PathwayWorkspaceMovePreview: Decodable {
    let fileCount: Int
    let terminalCount: Int
    let blockers: [Blocker]
    struct Blocker: Decodable, Identifiable {
        let kind: String
        let message: String
        var id: String { kind }
    }
}
