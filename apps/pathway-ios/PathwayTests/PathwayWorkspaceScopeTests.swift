import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayWorkspaceScopeTests {
    private let scope = PathwayWorkspaceScope(companyID: "company", environmentID: "environment", threadID: "thread", projectID: "project", projectRoot: "/repo", worktreePath: "/worktrees/one")

    @Test func rejectsAnEditorFromThePreviousCheckout() {
        let moved = PathwayWorkspaceScope(companyID: "company", environmentID: "environment", threadID: "thread", projectID: "project", projectRoot: "/repo", worktreePath: "/worktrees/two")
        #expect(throws: PathwayWorkspaceScopeError.self) {
            try PathwayWorkspaceScope.validate(method: "projects.writeFile", payload: .object(["cwd": .string("/worktrees/one")]), expected: scope, current: moved, canMutate: true)
        }
        #expect(throws: PathwayWorkspaceScopeError.self) {
            try PathwayWorkspaceScope.validate(method: "projects.writeFile", payload: .object(["cwd": .string("/worktrees/one")]), expected: scope, current: nil, canMutate: true)
        }
    }

    @Test func rejectsMismatchedThreadProjectAndWorkspaceFields() {
        for payload: JSONValue in [
            .object(["threadId": .string("another-thread")]),
            .object(["projectId": .string("another-project")]),
            .object(["cwd": .string("/repo")]),
            .object(["expectedWorktreePath": .null])
        ] {
            #expect(throws: PathwayWorkspaceScopeError.self) {
                try PathwayWorkspaceScope.validate(method: "orchestration.dispatchCommand", payload: payload, expected: scope, current: scope, canMutate: true)
            }
        }
    }

    @Test func terminalOpenUsesProjectRootAndExplicitWorktree() throws {
        try PathwayWorkspaceScope.validate(method: "terminal.open", payload: .object([
            "threadId": .string("thread"), "cwd": .string("/repo"), "worktreePath": .string("/worktrees/one")
        ]), expected: scope, current: scope, canMutate: true)
    }

    @Test func reviewerReadsRemainAvailableWhileWritesAreBlocked() throws {
        try PathwayWorkspaceScope.validate(method: "pullRequests.reviewerCandidates", payload: .object(["projectId": .string("project")]), expected: scope, current: scope, canMutate: false)
        #expect(throws: PathwayWorkspaceError.self) {
            try PathwayWorkspaceScope.validate(method: "pullRequests.requestReviewers", payload: .object(["projectId": .string("project")]), expected: scope, current: scope, canMutate: false)
        }
    }

    @Test func originalFilesUseSignedAssetURLsOnTheSelectedEnvironment() throws {
        let base = URL(string: "https://environment.example/")!
        let signed: JSONValue = .object(["relativeUrl": .string("/api/assets/signed-token/file.png")])
        #expect(try PathwayEnvironmentHTTP.signedAssetURL(signed, base: base).absoluteString == "https://environment.example/api/assets/signed-token/file.png")
        for path in ["src/file.png", "https://another.example/api/assets/token/file.png", "//another.example/api/assets/token/file.png"] {
            #expect(throws: (any Error).self) {
                _ = try PathwayEnvironmentHTTP.signedAssetURL(.object(["relativeUrl": .string(path)]), base: base)
            }
        }
    }
}
