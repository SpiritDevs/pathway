import Foundation

struct PathwayThreadChangeRequestResolution: Sendable {
    let threadID: String
    let state: PathwayChangeRequestState?
}

enum PathwayThreadChangeRequestResolver {
    static func resolve(
        threads: [PathwayAgentThread],
        environments: [PathwayCompanyEnvironment],
        bindings: [PathwayCompanyEnvironmentBinding],
        connect: PathwayConnectClient
    ) async -> [PathwayThreadChangeRequestResolution] {
        let candidates = threads.compactMap { thread in
            candidate(
                for: thread,
                environments: environments,
                bindings: bindings
            )
        }
        let candidatesByEnvironment = Dictionary(grouping: candidates, by: \.environment.id)

        return await withTaskGroup(
            of: [PathwayThreadChangeRequestResolution].self,
            returning: [PathwayThreadChangeRequestResolution].self
        ) { group in
            for candidates in candidatesByEnvironment.values {
                group.addTask {
                    await resolve(candidates: candidates, connect: connect)
                }
            }

            var resolutions: [PathwayThreadChangeRequestResolution] = []
            for await environmentResolutions in group {
                resolutions.append(contentsOf: environmentResolutions)
            }
            return resolutions
        }
    }

    private struct Candidate: Sendable {
        let threadID: String
        let branch: String
        let cwd: String
        let environment: PathwayCompanyEnvironment
    }

    private static func candidate(
        for thread: PathwayAgentThread,
        environments: [PathwayCompanyEnvironment],
        bindings: [PathwayCompanyEnvironmentBinding]
    ) -> Candidate? {
        guard let branch = thread.shell.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty,
              let environment = environments.first(where: {
                  $0.companyId == thread.companyId
                      && $0.environment.environmentId == thread.environmentId
              })
        else {
            return nil
        }

        let binding = bindings.first {
            $0.companyId == thread.companyId
                && $0.binding.environmentId == thread.environmentId
                && ($0.binding.localProjectId == thread.shell.projectId
                    || $0.binding.cloudProjectId == thread.cloudProjectId)
        }
        let cwd = thread.shell.worktreePath ?? binding?.binding.localWorkspaceRoot
        guard let cwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty else {
            return nil
        }

        return Candidate(
            threadID: thread.id,
            branch: branch,
            cwd: cwd,
            environment: environment
        )
    }

    private static func resolve(
        candidates: [Candidate],
        connect: PathwayConnectClient
    ) async -> [PathwayThreadChangeRequestResolution] {
        guard let environment = candidates.first?.environment else { return [] }
        let rpc = PathwayRPCClient {
            try await connect.prepare(environment: environment).webSocketURL
        }
        var resolutions: [PathwayThreadChangeRequestResolution] = []

        for candidate in candidates {
            guard !Task.isCancelled else { break }
            do {
                let value = try await rpc.request(
                    "vcs.refreshStatus",
                    payload: .object(["cwd": .string(candidate.cwd)])
                )
                guard value.objectValue?["refName"]?.stringValue == candidate.branch else {
                    resolutions.append(
                        PathwayThreadChangeRequestResolution(
                            threadID: candidate.threadID,
                            state: nil
                        )
                    )
                    continue
                }
                let state = value.objectValue?["pr"]?.objectValue?["state"]?.stringValue
                    .flatMap(PathwayChangeRequestState.init(rawValue:))
                resolutions.append(
                    PathwayThreadChangeRequestResolution(
                        threadID: candidate.threadID,
                        state: state
                    )
                )
            } catch is CancellationError {
                break
            } catch {
                continue
            }
        }

        await rpc.stop()
        return resolutions
    }
}
