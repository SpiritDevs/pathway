import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayWorkspaceTests {
    private var context: PathwayWorkspaceContext {
        .init(threadID: "thread-a", projectID: "project-a", cwd: "/worktrees/a", projectRoot: "/repo")
    }

    @Test func commitsOnlySelectedFilesInTheThreadsWorkspace() async throws {
        var captured: [String: JSONValue] = [:]
        let client = PathwayWorkspaceClient(context: context) { method, payload in
            #expect(method == "git.runStackedAction")
            captured = payload.objectValue ?? [:]
            return .object(["toast": .object(["title": .string("Committed")])])
        }
        let result = try await client.gitAction("commit", message: "Fix selection", paths: ["src/a.swift"])
        #expect(result == "Committed")
        #expect(captured["cwd"] == .string("/worktrees/a"))
        #expect(captured["threadId"] == .string("thread-a"))
        #expect(captured["filePaths"] == .array([.string("src/a.swift")]))
        #expect(captured["actionId"]?.stringValue?.isEmpty == false)
    }

    @Test func refusesWritesWhenThreadCannotMutate() async {
        var blocked = context; blocked.canMutate = false
        var called = false
        let client = PathwayWorkspaceClient(context: blocked) { _, _ in called = true; return .null }
        do { _ = try await client.run("vcs.pull", client.cwdPayload); Issue.record("Expected unavailable error") }
        catch { #expect(!called) }
    }

    @Test func sendsTheLoadedRevisionWithFileEdits() async throws {
        let client = PathwayWorkspaceClient(context: context) { method, payload in
            #expect(method == "projects.writeFile")
            #expect(payload.objectValue?["cwd"] == .string("/worktrees/a"))
            #expect(payload.objectValue?["expectedRevision"] == .string("read-revision"))
            #expect(payload.objectValue?["contents"] == .string("my edit"))
            return .object(["revision": .string("saved-revision")])
        }
        let original = PathwayWorkspaceFile(contents: "old", truncated: false, byteLength: 3, revision: "read-revision")
        let savedRevision = try await client.saveFile("a.txt", original: original, contents: "my edit")
        #expect(savedRevision == "saved-revision")
    }

    @Test func preventsSavingTruncatedOrUnversionedFiles() async {
        var writes = 0
        let client = PathwayWorkspaceClient(context: context) { _, _ in writes += 1; return .null }
        for original in [PathwayWorkspaceFile(contents: "partial", truncated: true, byteLength: 10000, revision: "partial"), PathwayWorkspaceFile(contents: "old server", truncated: false, byteLength: 10)] {
            do { _ = try await client.saveFile("a.txt", original: original, contents: "edit"); Issue.record("Expected refusal") }
            catch { #expect(writes == 0) }
        }
    }

    @Test func intersectsHostPermissionsAndRepositoryMergeMethods() throws {
        let data = Data(#"{"title":"PR","body":"","state":"open","isDraft":false,"mergeability":"mergeable","headBranch":"feature","baseBranch":"main","additions":1,"deletions":0,"checks":[],"capabilities":{"diff":true,"comment":true,"actions":["merge","close","draft"],"mergeMethods":["merge","squash","rebase"],"reviewers":{"request":true,"listCandidates":true},"review":{"inlineComment":true,"reply":true,"resolve":true,"verdicts":["comment","approve"]}},"viewerPermissions":{"requestReviewers":false,"actions":["merge"],"comment":false,"resolve":false,"verdicts":["comment"]},"mergeCapabilities":{"merge":false,"squash":true,"rebase":false}}"#.utf8)
        let detail = try JSONDecoder().decode(PathwayWorkspacePullRequestDetail.self, from: data)
        #expect(detail.availableActions == ["merge"])
        #expect(detail.availableMergeMethods == ["squash"])
        #expect(detail.availableVerdicts == ["comment"])
        #expect(!detail.canComment)
    }

    @Test func keepsTerminalInTheThreadWorktree() async throws {
        let client = PathwayWorkspaceClient(context: context) { method, payload in
            #expect(method == "terminal.open")
            #expect(payload.objectValue?["threadId"] == .string("thread-a"))
            #expect(payload.objectValue?["terminalId"] == .string("term-mobile-owned"))
            #expect(payload.objectValue?["cwd"] == .string("/repo"))
            #expect(payload.objectValue?["worktreePath"] == .string("/worktrees/a"))
            return .object(["terminalId": .string("term-mobile-owned"), "status": .string("running"), "history": .string(""), "label": .string("Shell")])
        }
        _ = try await client.openTerminal("term-mobile-owned")
    }
    @Test func anchorsReviewCommentsToTheCorrectRenameAndDiffSide() {
        let patch = "diff --git a/old.swift b/new.swift\n--- a/old.swift\n+++ b/new.swift\n@@ -4,2 +7,2 @@\n-old\n+new\n context\n"
        let lines = PathwayWorkspaceDiffLine.parse(patch)
        let removed = lines.first { $0.text == "-old" }?.anchor
        let added = lines.first { $0.text == "+new" }?.anchor
        #expect(removed?.line == 4)
        #expect(removed?.side == "left")
        #expect(added?.line == 7)
        #expect(added?.side == "right")
        #expect(added?.path == "new.swift")
        #expect(added?.oldPath == "old.swift")
        #expect(lines.first { $0.text == " context" }?.anchor?.line == 8)
        if let added {
            let draft = PathwayWorkspaceReviewDraft(anchor: added, body: "Explain this change")
            #expect(draft.payload.objectValue?["oldPath"] == .string("old.swift"))
            #expect(draft.payload.objectValue?["side"] == .string("right"))
            #expect(draft.isValid)
        }
    }

    @Test func neverInventsAnchorsForUnparsedPathsOrInvalidHunks() {
        let quoted = #"diff --git "a/file name" "b/file name""# + "\n" + #"--- "a/file name""# + "\n" + #"+++ "b/file name""# + "\n@@ -1 +1 @@\n-before\n+after"
        #expect(PathwayWorkspaceDiffLine.parse(quoted).allSatisfy { $0.anchor == nil })
        let invalid = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ invalid @@\n+after"
        #expect(PathwayWorkspaceDiffLine.parse(invalid).allSatisfy { $0.anchor == nil })
        let addition = "diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+created\n+outside hunk"
        let lines = PathwayWorkspaceDiffLine.parse(addition)
        #expect(lines.first { $0.text == "+created" }?.anchor?.line == 1)
        #expect(lines.last?.anchor == nil)
    }

    @Test func terminalAssetsStayInsideTheirOfflineBundle() {
        let root = URL(fileURLWithPath: "/app/PathwayTerminal.bundle")
        #expect(PathwayTerminalAssets.assetURL(root: root, path: "/index.html")?.lastPathComponent == "index.html")
        #expect(PathwayTerminalAssets.assetURL(root: root, path: "/assets/core.wasm")?.lastPathComponent == "core.wasm")
        #expect(PathwayTerminalAssets.assetURL(root: root, path: "/assets/../../private.txt") == nil)
        #expect(PathwayTerminalAssets.assetURL(root: root, path: "/private.txt") == nil)
    }

}
