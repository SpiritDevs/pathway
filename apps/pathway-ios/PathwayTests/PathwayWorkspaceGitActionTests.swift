import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayWorkspaceGitActionTests {
    private func status(dirty: Bool = true, remote: Bool = true, branch: String? = "feature", upstream: Bool = true,
                        ahead: Int = 1, behind: Int = 0, defaultRef: Bool = false, aheadOfDefault: Int? = nil) -> PathwayWorkspaceStatus {
        .init(isRepo: true, refName: branch, hasWorkingTreeChanges: dirty, hasPrimaryRemote: remote,
              hasUpstream: upstream, aheadCount: ahead, behindCount: behind,
              workingTree: .init(files: dirty ? [.init(path: "a.swift", insertions: 1, deletions: 0), .init(path: "b.swift", insertions: 1, deletions: 0)] : []),
              isDefaultRef: defaultRef, aheadOfDefaultCount: aheadOfDefault)
    }

    @Test func committingRequiresACurrentFileSelection() {
        for action in [PathwayWorkspaceGitAction.commit, .commitPush, .commitPushPR] {
            #expect(action.unavailableReason(status: status(), selected: ["a.swift"]) == nil)
            #expect(action.unavailableReason(status: status(), selected: []) != nil)
            #expect(action.unavailableReason(status: status(), selected: ["removed.swift"]) != nil)
            #expect(action.unavailableReason(status: status(dirty: false), selected: ["a.swift"]) != nil)
        }
    }

    @Test func localCommitsWorkWithoutARemoteButRemoteActionsDoNot() {
        #expect(PathwayWorkspaceGitAction.commit.unavailableReason(status: status(remote: false), selected: ["a.swift"]) == nil)
        for action in PathwayWorkspaceGitAction.allCases where action != .commit {
            #expect(action.unavailableReason(status: status(remote: false), selected: ["a.swift"]) != nil)
        }
    }

    @Test func pushAndPullRespectUpstreamState() {
        #expect(PathwayWorkspaceGitAction.push.unavailableReason(status: status(dirty: false, ahead: 0), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.push.unavailableReason(status: status(dirty: false, upstream: false), selected: []) == nil)
        #expect(PathwayWorkspaceGitAction.push.unavailableReason(status: status(dirty: false, behind: 1), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.push.unavailableReason(status: status(dirty: false, branch: nil), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.pull.unavailableReason(status: status(dirty: false, behind: 1), selected: []) == nil)
        #expect(PathwayWorkspaceGitAction.pull.unavailableReason(status: status(), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.pull.unavailableReason(status: status(dirty: false, upstream: false), selected: []) != nil)
    }

    @Test func pullRequestsIncludeAlreadyPushedBranchCommits() {
        #expect(PathwayWorkspaceGitAction.createPR.unavailableReason(status: status(dirty: false, ahead: 0, aheadOfDefault: 2), selected: []) == nil)
        #expect(PathwayWorkspaceGitAction.createPR.unavailableReason(status: status(dirty: false, ahead: 0, aheadOfDefault: 0), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.createPR.unavailableReason(status: status(), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.createPR.unavailableReason(status: status(dirty: false, defaultRef: true), selected: []) != nil)
        #expect(PathwayWorkspaceGitAction.commitPushPR.unavailableReason(status: status(defaultRef: true), selected: ["a.swift"]) != nil)
        #expect(PathwayWorkspaceGitAction.commitPushPR.unavailableReason(status: status(defaultRef: true), selected: ["a.swift"], featureBranch: true) == nil)
    }

    @Test func combinedActionsUseTheSelectedWorktreeAndAllowGeneratedMessages() async throws {
        for action in [PathwayWorkspaceGitAction.commit, .commitPush, .commitPushPR] {
            let client = PathwayWorkspaceClient(context: .init(threadID: "thread", projectID: "project", cwd: "/worktree", projectRoot: "/repo"), subscribe: { method, payload in
                #expect(method == "git.runStackedAction")
                let fields = try #require(payload.objectValue)
                #expect(fields["action"] == .string(action.rawValue))
                #expect(fields["cwd"] == .string("/worktree"))
                #expect(fields["threadId"] == .string("thread"))
                #expect(fields["filePaths"] == .array([.string("a.swift")]))
                #expect(fields["commitMessage"] == nil)
                #expect(fields["featureBranch"] == .bool(true))
                return AsyncThrowingStream { continuation in
                    continuation.yield(.object(["kind": .string("phase_started"), "phase": .string("commit")]))
                    continuation.yield(.object(["kind": .string("action_finished"), "result": .object([
                        "toast": .object(["title": .string("Completed")]),
                        "branch": .object(["status": .string("created"), "name": .string("feature/new")])
                    ])]))
                    continuation.finish()
                }
            }, request: { method, payload in
                #expect(method == "orchestration.dispatchCommand")
                #expect(payload.objectValue?["type"] == .string("thread.metadata.update"))
                #expect(payload.objectValue?["threadId"] == .string("thread"))
                #expect(payload.objectValue?["branch"] == .string("feature/new"))
                #expect(payload.objectValue?["expectedWorktreePath"] == .string("/worktree"))
                return .null
            })
            #expect(try await client.gitAction(action.rawValue, message: " \n", paths: ["a.swift"], featureBranch: true) == "Completed")
        }
    }

    @Test func combinedActionsCannotCommitAnEmptySelectionOrWriteWhileDisconnected() async {
        var calls = 0
        for canMutate in [false, true] {
            let client = PathwayWorkspaceClient(context: .init(threadID: "thread", projectID: "project", cwd: "/worktree", projectRoot: "/repo", canMutate: canMutate), subscribe: { _, _ in
                calls += 1
                return AsyncThrowingStream { $0.finish() }
            }, request: { _, _ in
                calls += 1
                return .null
            })
            do {
                _ = try await client.gitAction("commit_push_pr", message: "", paths: canMutate ? [] : ["a.swift"])
                Issue.record("Expected action to be refused")
            } catch { #expect(calls == 0) }
        }
    }

    @Test func gitStreamsMustFinishWithAResultAndSurfaceFailures() async {
        for events: [JSONValue] in [[], [.object(["kind": .string("action_failed"), "message": .string("Push rejected")])]] {
            let client = PathwayWorkspaceClient(context: .init(threadID: "thread", projectID: "project", cwd: "/worktree", projectRoot: "/repo"), subscribe: { _, _ in
                AsyncThrowingStream { continuation in
                    for event in events { continuation.yield(event) }
                    continuation.finish()
                }
            }, request: { _, _ in Issue.record("Unexpected unary request"); return .null })
            do {
                _ = try await client.gitAction("push", message: "", paths: [])
                Issue.record("Expected incomplete or failed stream to throw")
            } catch {
                #expect(error.localizedDescription.contains(events.isEmpty ? "without a result" : "Push rejected"))
            }
        }
    }

    @Test func gitStreamConnectionFailuresFinishInsteadOfReconnecting() async {
        let rpc = PathwayRPCClient(reconnectsSubscriptions: false) { throw PathwayRPCError.disconnected }
        let events = await rpc.subscribe("git.runStackedAction", payload: .object([:]))
        do {
            for try await _ in events {}
            Issue.record("Expected connection failure")
        } catch {
            #expect(error is PathwayRPCError)
        }
        await rpc.stop()
    }
}
