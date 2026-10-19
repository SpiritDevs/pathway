import Foundation
@testable import Pathway
import Testing

struct PathwayTemporaryConversationTests {
    @Test func conversationNotificationsStayInTheSelectedEnabledFocus() {
        let focuses = [
            PathwayFocus(id: "one", name: "One", iconName: "briefcase", accentColor: "blue", orderKey: "a", includeConversations: true),
            PathwayFocus(id: "two", name: "Two", iconName: "house", accentColor: "green", orderKey: "b", includeConversations: true),
        ]
        let notification = PathwayFocusNotification(id: "notice", environmentId: "env", threadId: "conversation",
            projectKey: "env:conversations", eventKind: "awaiting-input", createdAt: 0)
        for selected in ["one", "two", "all"] {
            #expect(notification.focusID(focuses: focuses, assignments: [], selectedID: selected) == selected)
        }
        #expect(notification.focusID(focuses: focuses, assignments: [], selectedID: "missing") == "all")
        let project = PathwayFocusNotification(id: "project", environmentId: "env", threadId: "project-thread",
            projectKey: "env:project", eventKind: "failed", createdAt: 0)
        #expect(project.focusID(focuses: focuses, assignments: [.init(focusId: "two", projectKey: "env:project")], selectedID: "one") == "two")
    }

    @Test func retainedDraftDecodesBothPlacementPinAndTemporaryChoice() throws {
        let draft = PathwayThreadCreationDraft(prompt: "", initialImageUploads: [], selectedProviderID: "codex",
            selectedModelID: "gpt", optionValues: [:], runtimeMode: "full-access", interactionMode: "default",
            workspaceMode: "worktree", baseReference: "main", branch: "", startFromOrigin: false,
            attempt: nil, placementPinned: true, temporary: true)
        let restored = try JSONDecoder().decode(PathwayThreadCreationDraft.self, from: JSONEncoder().encode(draft))
        #expect(restored.placementPinned == true)
        #expect(restored.temporary == true)
    }

    @Test @MainActor func conversationGitReviewRejectsAncestorAndOpensTerminalInItsOwnFolder() async throws {
        let folder = "/repo/.pathway/userdata/conversations/one"
        let context = PathwayWorkspaceContext(threadID: "one", projectID: nil, cwd: folder, projectRoot: folder)
        var methods: [String] = []
        let ancestor = PathwayWorkspaceClient(context: context) { method, _ in
            methods.append(method)
            return .object(["repositoryRoot": .string("/repo")])
        }
        var rejected = false
        do {
            let _: JSONValue = try await ancestor.call("vcs.refreshStatus", ancestor.cwdPayload)
        } catch PathwayWorkspaceError.conversationRepository { rejected = true }
        #expect(rejected)
        #expect(methods == ["projects.inspectDirectory"])
        methods = []
        var terminalPayload: JSONValue?
        let owned = PathwayWorkspaceClient(context: context) { method, payload in
            methods.append(method)
            if method == "projects.inspectDirectory" { return .object(["repositoryRoot": .string(folder), "repositoryIdentity": .null]) }
            if method == "terminal.open" {
                terminalPayload = payload
                return .object(["terminalId": .string("new-terminal"), "status": .string("running"), "history": .string(""), "label": .string("Terminal")])
            }
            return .object([:])
        }
        let _: JSONValue = try await owned.call("vcs.refreshStatus", owned.cwdPayload)
        #expect(methods == ["projects.inspectDirectory", "vcs.refreshStatus"])
        _ = try await owned.openTerminal("new-terminal")
        #expect(terminalPayload?.objectValue?["cwd"] == .string(folder))
        #expect(terminalPayload?.objectValue?["worktreePath"] == .null)
    }

    @Test @MainActor func cleanupNoticesSurviveTransportFramesAndClearWhenTheirEnvironmentSucceeds() throws {
        let model = PathwayWorkspaceCleanupModel()
        let failure: JSONValue = .array([.object([
            "effectId": .string("cleanup-1"), "threadId": .string("thread-1"),
            "title": .string("Conversation"), "message": .string("Local cleanup will retry"),
            "nextAttemptAt": .string("2026-09-08T01:02:03Z")
        ])])
        try model.apply(.object(["_pathwayTransport": .string("connecting")]), environmentID: "one", label: "First")
        #expect(model.entries.isEmpty)
        try model.apply(failure, environmentID: "one", label: "First")
        try model.apply(failure, environmentID: "two", label: "Second")
        #expect(model.entries.count == 2)
        #expect(model.entries.first?.failure.nextAttemptAt == "2026-09-08T01:02:03Z")
        try model.apply(.object(["_pathwayTransport": .string("disconnected")]), environmentID: "one", label: "First")
        #expect(model.entries.count == 2)
        try model.apply(.array([]), environmentID: "one", label: "First")
        #expect(model.entries.map(\.environmentID) == ["two"])
        try model.apply(.array([]), environmentID: "two", label: "Second")
        #expect(model.entries.isEmpty)
    }

    @Test func projectlessShellRetainsDirectoryAndCompanyWithoutInventingProject() throws {
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(makeAgentThread().shell))
        fields["projectId"] = .null
        fields["conversationPath"] = .string("/environment/userdata/conversations/one")
        fields["conversationCompanyId"] = .string("company-1")
        fields["temporary"] = .bool(true)
        let shell = try JSONDecoder().decode(PathwayAgentThreadShell.self, from: JSONEncoder().encode(fields))
        #expect(shell.isConversation)
        #expect(shell.isTemporary)
        #expect(shell.conversationCompanyId == "company-1")
        #expect(shell.conversationPath == "/environment/userdata/conversations/one")
        #expect(!makeAgentThread().shell.isTemporary)
    }

    @Test func conversationLaunchUsesSelectedCompanyAndEnvironmentOwnedFolder() {
        let payload = PathwayAgentThreadCommands.launchThread(draft(projectID: nil)).objectValue
        #expect(payload?["projectId"] == .null)
        #expect(payload?["conversationCompanyId"] == .string("company-1"))
        #expect(payload?["temporary"] == .bool(true))
        #expect(payload?["workspaceStrategy"]?.objectValue?["type"] == .string("root"))
    }

    @Test func temporaryProjectLaunchAlwaysRequestsDedicatedWorktree() {
        let payload = PathwayAgentThreadCommands.launchThread(draft(projectID: "project-1")).objectValue
        #expect(payload?["workspaceStrategy"]?.objectValue?["type"] == .string("worktree"))
        #expect(payload?["conversationCompanyId"] == nil)
    }

    @Test func temporaryRetentionWaitsForServerSettlementChecks() {
        let original = makeAgentThread()
        var shell = original.shell
        shell.temporary = true
        let thread = PathwayAgentThread(companyId: original.companyId, environmentId: original.environmentId,
            cloudProjectId: original.cloudProjectId, shell: shell, cloudUpdatedAt: original.cloudUpdatedAt)
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        #expect(thread.lifecycleSection(at: now, autoSettleAfterDays: 1) == .active)
        #expect(thread.lifecycleSection(at: now, changeRequestState: .merged) == .active)
        #expect(original.lifecycleSection(at: now, autoSettleAfterDays: 1) == .settled)
    }

    @Test func lifecycleCommandsPreserveExplicitDiscardAndKeepIntent() {
        #expect(PathwayThreadAction.settle.command(threadID: "one").objectValue?["discardChanges"] == nil)
        #expect(PathwayThreadAction.discardAndSettle.command(threadID: "one").objectValue?["discardChanges"] == .bool(true))
        #expect(PathwayThreadAction.keepConversation.command(threadID: "one").objectValue?["temporary"] == .bool(false))
        #expect(PathwayThreadAction.keepConversation.command(threadID: "one").objectValue?["keep"] == .bool(true))
        #expect(PathwayThreadAction.settleAfterCompletion(true).command(threadID: "one").objectValue?["type"] == .string("thread.settle-after-completion.set"))
    }

    private func draft(projectID: String?) -> PathwayThreadLaunchDraft {
        PathwayThreadLaunchDraft(projectID: projectID, prompt: "Start here",
            modelSelection: PathwayModelSelection(instanceId: "codex", model: "gpt-5", options: nil),
            runtimeMode: "full-access", interactionMode: "default", workspaceMode: "local", baseReference: "main",
            branch: "", startFromOrigin: true, temporary: true, conversationCompanyID: "company-1")
    }
}
