import Foundation

struct PathwayThreadChangeRequestStatus: Equatable, Sendable {
    var state: PathwayChangeRequestState?
    var checksFailed = false
    var checksPending = false
    var isDraft = false
    var unavailable = false

    var label: String {
        if unavailable { return "Status unavailable" }
        switch state {
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .open:
            if checksFailed { return "Checks failed" }
            if checksPending { return "Checks pending" }
            return isDraft ? "Draft" : "Open"
        case nil: return "Attached"
        }
    }
}

struct PathwayThreadChangeRequestSource: Equatable, Sendable {
    let projectID: String?
    let branch: String?
    let cwd: String?
    let attachment: PathwayPullRequestAttachment?

    init(_ shell: PathwayAgentThreadShell) {
        projectID = shell.projectId
        branch = shell.branch
        cwd = shell.worktreePath
        attachment = shell.attachedPullRequest
    }
}

struct PathwayThreadChangeRequestResolution: Sendable {
    let threadID: String
    let status: PathwayThreadChangeRequestStatus
}

struct PathwayAttachedPullRequestReference: Equatable, Sendable {
    let host: String
    let repository: String
    let number: Int

    init?(_ attachment: PathwayPullRequestAttachment) {
        guard let url = URL(string: attachment.url),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host?.lowercased() else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        let marker: String
        if parts.contains("merge_requests") { marker = "merge_requests" }
        else if host == "github.com" || host.hasSuffix(".github.com") || host.hasPrefix("github.") { marker = "pull" }
        else if host == "bitbucket.org" || host.hasPrefix("bitbucket.") { marker = "pull-requests" }
        else if host == "dev.azure.com" || host.hasSuffix(".visualstudio.com") { marker = "pullrequest" }
        else { return nil }
        guard let index = parts.lastIndex(of: marker), index >= 2,
              parts.indices.contains(index + 1), let number = Int(parts[index + 1]),
              number > 0, number == attachment.number else { return nil }
        if marker == "merge_requests", parts[index - 1] != "-" { return nil }
        let repositoryEnd = marker == "merge_requests" ? index - 1 : index
        guard repositoryEnd >= 2 else { return nil }
        self.host = host
        self.repository = parts[..<repositoryEnd].joined(separator: "/").lowercased()
        self.number = number
    }
}

enum PathwayThreadChangeRequestResolver {
    struct Request: Sendable {
        let method: String
        let payload: JSONValue
        let cacheKey: String
        let branch: String?
        let attachment: PathwayAttachedPullRequestReference?

        func status(from value: JSONValue) -> PathwayThreadChangeRequestStatus {
            let detail: [String: JSONValue]?
            if let attachment {
                detail = value.objectValue
                guard let url = detail?["url"]?.stringValue,
                      detail?["number"] == .number(Double(attachment.number)),
                      PathwayAttachedPullRequestReference(.init(number: attachment.number, url: url)) == attachment
                else { return .init(unavailable: true) }
            } else {
                guard value.objectValue?["refName"]?.stringValue == branch else { return .init() }
                detail = value.objectValue?["pr"]?.objectValue
            }
            let checks = detail?["checks"]?.arrayValue?.compactMap { $0.objectValue?["status"]?.stringValue } ?? []
            return .init(
                state: detail?["state"]?.stringValue.flatMap(PathwayChangeRequestState.init(rawValue:)),
                checksFailed: checks.contains("failure") || checks.contains("cancelled"),
                checksPending: checks.contains("pending"),
                isDraft: detail?["isDraft"] == .bool(true)
            )
        }
    }

    static func request(
        for thread: PathwayAgentThread,
        environment: PathwayCompanyEnvironment,
        bindings: [PathwayCompanyEnvironmentBinding]
    ) -> Request? {
        if let attachment = thread.shell.attachedPullRequest {
            guard environment.environment.descriptor.capabilities?["pullRequests"] == .bool(true),
                  let projectID = thread.shell.projectId,
                  let reference = PathwayAttachedPullRequestReference(attachment) else { return nil }
            return Request(
                method: "pullRequests.detail",
                payload: .object(["projectId": .string(projectID), "repository": .string(reference.repository), "number": .number(Double(reference.number))]),
                cacheKey: "attachment:\(projectID):\(reference.host):\(reference.repository):\(reference.number)",
                branch: nil, attachment: reference
            )
        }
        guard let branch = thread.shell.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty else { return nil }
        let binding = bindings.first {
            $0.companyId == thread.companyId && $0.binding.environmentId == thread.environmentId
                && ($0.binding.localProjectId == thread.shell.projectId
                    || (thread.cloudProjectId != nil && $0.binding.cloudProjectId == thread.cloudProjectId))
        }
        guard let cwd = (thread.shell.worktreePath ?? binding?.binding.localWorkspaceRoot)?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty else { return nil }
        return Request(method: "vcs.refreshStatus", payload: .object(["cwd": .string(cwd)]), cacheKey: "cwd:\(cwd)", branch: branch, attachment: nil)
    }

    static func resolve(
        threads: [PathwayAgentThread],
        environments: [PathwayCompanyEnvironment],
        bindings: [PathwayCompanyEnvironmentBinding],
        connect: PathwayConnectClient
    ) async -> [PathwayThreadChangeRequestResolution] {
        let candidates = threads.compactMap { thread -> Candidate? in
            guard !thread.isRunning,
                  let environment = environments.first(where: {
                      $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId
                  }),
                  let request = request(for: thread, environment: environment, bindings: bindings) else { return nil }
            return Candidate(threadID: thread.id, environment: environment, request: request)
        }
        return await withTaskGroup(of: [PathwayThreadChangeRequestResolution].self) { group in
            for candidates in Dictionary(grouping: candidates, by: \.environment.id).values {
                group.addTask { await resolve(candidates: candidates, connect: connect) }
            }
            var resolutions: [PathwayThreadChangeRequestResolution] = []
            for await results in group { resolutions.append(contentsOf: results) }
            return resolutions
        }
    }

    private struct Candidate: Sendable {
        let threadID: String
        let environment: PathwayCompanyEnvironment
        let request: Request
    }

    private static func resolve(candidates: [Candidate], connect: PathwayConnectClient) async -> [PathwayThreadChangeRequestResolution] {
        guard let environment = candidates.first?.environment else { return [] }
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        var resolutions: [PathwayThreadChangeRequestResolution] = []
        var responses: [String: JSONValue] = [:]
        for candidate in candidates {
            guard !Task.isCancelled else { break }
            do {
                let request = candidate.request
                let value: JSONValue
                if let cached = responses[request.cacheKey] { value = cached }
                else {
                    value = try await rpc.request(request.method, payload: request.payload)
                    responses[request.cacheKey] = value
                }
                resolutions.append(.init(threadID: candidate.threadID, status: request.status(from: value)))
            } catch is CancellationError { break }
            catch {
                if candidate.request.attachment != nil {
                    resolutions.append(.init(threadID: candidate.threadID, status: .init(unavailable: true)))
                }
            }
        }
        await rpc.stop()
        return resolutions
    }
}
