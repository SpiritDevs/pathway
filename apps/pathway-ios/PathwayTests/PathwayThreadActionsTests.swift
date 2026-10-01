import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadActionsTests {
    @Test func encodesLifecycleCommands() {
        let cases: [(PathwayThreadAction, String)] = [
            (.pin, "thread.pin"), (.unpin, "thread.unpin"), (.settle, "thread.settle"),
            (.reopen, "thread.unsettle"), (.wake, "thread.unsnooze")
        ]
        for (action, type) in cases {
            let command = action.command(threadID: "thread", commandID: "command").objectValue
            #expect(command?["type"]?.stringValue == type)
            #expect(command?["threadId"]?.stringValue == "thread")
            #expect(command?["commandId"]?.stringValue == "command")
            #expect(command?["reason"]?.stringValue == (action == .reopen || action == .wake ? "user" : nil))
        }
        let wakeDate = Date(timeIntervalSince1970: 1_800_000_000)
        let sleep = PathwayThreadAction.sleep(until: wakeDate).command(threadID: "thread").objectValue
        #expect(sleep?["type"]?.stringValue == "thread.snooze")
        #expect(sleep?["snoozedUntil"]?.stringValue.flatMap(pathwayDate) == wakeDate)
    }

    @Test func encodesParentCommands() {
        let child = makeAgentThread(id: "child")
        let here = makeAgentThread(id: "here")
        let elsewhere = makeAgentThread(id: "elsewhere", environmentId: "environment-2")

        let local = PathwayThreadAction.setParent(PathwayThreadParent(here, for: child))
            .command(threadID: "child", commandID: "command").objectValue
        #expect(local?["type"]?.stringValue == "thread.parent.set")
        #expect(local?["parent"] == .object(["threadId": .string("here")]))

        let remote = PathwayThreadAction.setParent(PathwayThreadParent(elsewhere, for: child))
            .command(threadID: "child").objectValue
        #expect(remote?["parent"] == .object(["threadId": .string("elsewhere"), "environmentId": .string("environment-2")]))

        let toList = PathwayThreadAction.setParent(nil).command(threadID: "child").objectValue
        #expect(toList?["parent"] == .null)
    }

    @Test func listsAttachedThreadsUnderAListedParent() {
        let parent = makeAgentThread(id: "parent")
        let attached = makeAgentThread(id: "attached", parentThreadId: "parent")
        let remote = makeAgentThread(
            id: "remote", environmentId: "environment-2", parentThreadId: "parent",
            parentEnvironmentId: "environment-1"
        )
        let orphan = makeAgentThread(id: "orphan", parentThreadId: "gone")

        let partition = PathwayThreadLifecyclePartition(threads: [parent, attached, remote, orphan], now: Date())
        let listed = partition.active + partition.snoozed + partition.settled
        #expect(Set(listed.map(\.threadId)) == ["parent", "orphan"])

        let lineage = PathwayThreadParents.lineage(of: parent, in: partition.all)
        #expect(Set(lineage.children.map(\.threadId)) == ["attached", "remote"])
        #expect(PathwayThreadParents.lineage(of: remote, in: partition.all).parent?.threadId == "parent")
    }

    @Test func parentCandidatesSkipTheThreadAndEverythingBeneathIt() {
        let target = makeAgentThread(id: "target")
        let child = makeAgentThread(id: "child", parentThreadId: "target")
        let grandchild = makeAgentThread(
            id: "grandchild", environmentId: "environment-2", parentThreadId: "child",
            parentEnvironmentId: "environment-1"
        )
        let sibling = makeAgentThread(id: "sibling")
        let archived = makeAgentThread(id: "archived", archivedAt: "2026-08-29T03:00:00.000Z")

        let candidates = PathwayThreadParents.candidates(
            for: target, in: [target, child, grandchild, sibling, archived]
        )
        #expect(candidates.map(\.threadId) == ["sibling"])
    }

    @Test func optimisticParentChangeIsReflectedOnceDiscoveryAgrees() {
        let child = makeAgentThread(id: "child", relationshipToParent: "subagent")
        let parent = makeAgentThread(id: "parent", environmentId: "environment-2")
        let overlay = PathwayOptimisticThreadAction(
            threadID: child.id, action: .setParent(PathwayThreadParent(parent, for: child)), date: Date()
        )
        let moved = overlay.applying(to: child)
        #expect(moved.shell.lineage?.relationshipToParent == nil)
        #expect(moved.parentKey == "environment-2:parent")
        #expect(moved.shell.lineage?.rootThreadId == "child")
        #expect(!overlay.isReflected(in: child))
        #expect(overlay.isReflected(in: moved))
    }

    @Test func preventsDuplicateActionsAndClearsBusyStateOnFailure() async {
        let actions = PathwayThreadActions()
        var duplicated = false
        await actions.perform(threadID: "thread") {
            #expect(actions.pendingThreadIDs.contains("thread"))
            await actions.perform(threadID: "thread") { duplicated = true }
            throw URLError(.notConnectedToInternet)
        }
        #expect(!duplicated)
        #expect(actions.pendingThreadIDs.isEmpty)
        #expect(actions.errorMessage != nil)
    }

    @Test func reportsAnUnavailableEnvironmentWithoutChangingTheThread() async {
        let actions = PathwayThreadActions()
        await actions.perform(.settle, thread: makeAgentThread(), environments: [], request: { _, _, _ in Issue.record("No request without an environment"); return .null })
        #expect(actions.errorMessage != nil)
        #expect(actions.pendingThreadIDs.isEmpty)
    }
    @Test func settleUsesEnvironmentTransportAndRetriesTheSameCommand() async throws {
        let actions = PathwayThreadActions()
        let thread = makeAgentThread()
        let environment = environment(for: thread)
        var commands: [JSONValue] = []
        await actions.perform(.settle, thread: thread, environments: [environment]) { target, method, command in
            #expect(target.id == environment.id)
            #expect(method == "orchestration.dispatchCommand")
            #expect(command.objectValue?["type"] == .string("thread.settle"))
            #expect(command.objectValue?["force"] == nil)
            commands.append(command)
            throw PathwayRPCError.timedOut
        }
        #expect(actions.failedAction?.action == .settle)
        #expect(actions.pendingThreadIDs.isEmpty)
        #expect(actions.errorMessage?.contains("did not confirm") == true)
        await actions.perform(.settle, thread: thread, environments: [environment]) { _, _, command in
            commands.append(command)
            return .object(["sequence": .number(1)])
        }
        #expect(commands.count == 2)
        #expect(commands[0] == commands[1])
        #expect(actions.failedAction == nil)
        #expect(actions.errorMessage == nil)
        #expect(actions.pendingThreadIDs.isEmpty)
    }

    @Test func rejectedSettleKeepsServerReasonAndDoesNotOfferConnectionRetry() async {
        let actions = PathwayThreadActions()
        let thread = makeAgentThread()
        await actions.perform(.settle, thread: thread, environments: [environment(for: thread)]) { _, _, _ in
            throw PathwayRPCError.remote("This thread has active work.")
        }
        #expect(actions.errorMessage == "This thread has active work.")
        #expect(actions.failedAction == nil)
        #expect(actions.pendingThreadIDs.isEmpty)
    }

    @Test func requestSeesOptimisticStateAndFailureRestoresIt() async {
        let actions = PathwayThreadActions()
        let cloud = PathwayCloudModel()
        let thread = makeAgentThread()
        await actions.perform(.settle, thread: thread, environments: [environment(for: thread)], cloud: cloud) { _, _, _ in
            #expect(cloud.optimisticThread(thread).shell.settledOverride == "settled")
            throw PathwayRPCError.timedOut
        }
        #expect(cloud.optimisticThread(thread) == thread)
        #expect(actions.failedAction?.action == .settle)
        #expect(actions.pendingThreadIDs.isEmpty)
    }

    private func environment(for thread: PathwayAgentThread) -> PathwayCompanyEnvironment {
        .init(companyId: thread.companyId, environment: .init(id: "environment", environmentId: thread.environmentId,
            descriptor: .init(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
    }

    @Test func settleMovesPinnedAndSnoozedThreadImmediately() {
        let thread = makeAgentThread(snoozedUntil: "2099-01-01T00:00:00Z", pinnedAt: "2026-01-01T00:00:00Z")
        let cloud = PathwayCloudModel()
        let token = cloud.beginThreadAction(.settle, thread: thread)
        let optimistic = cloud.optimisticThread(thread)
        #expect(optimistic.lifecycleSection(at: Date()) == .settled)
        #expect(optimistic.shell.pinnedAt == nil)
        #expect(optimistic.shell.snoozedUntil == nil)
        cloud.reconcileThreadActions(with: [thread])
        #expect(cloud.optimisticThread(thread).lifecycleSection(at: Date()) == .settled)
        cloud.rollbackThreadAction(token)
        #expect(cloud.optimisticThread(thread) == thread)
    }

    @Test func failureRestoresLatestServerFieldsAndKeepsOtherActions() {
        let thread = makeAgentThread()
        let cloud = PathwayCloudModel()
        let failed = cloud.beginThreadAction(.settle, thread: thread)
        cloud.beginThreadAction(.rename("New title"), thread: thread)
        var updated = thread
        updated.shell.status = "running"
        cloud.rollbackThreadAction(failed)
        let visible = cloud.optimisticThread(updated)
        #expect(visible.shell.title == "New title")
        #expect(visible.shell.status == "running")
        #expect(visible.shell.settledOverride == nil)
    }

    @Test func skippedIntermediateSnapshotAcknowledgesReverseAction() {
        let thread = makeAgentThread()
        let cloud = PathwayCloudModel()
        cloud.beginThreadAction(.settle, thread: thread)
        cloud.beginThreadAction(.reopen, thread: thread)
        #expect(cloud.optimisticThread(thread).lifecycleSection(at: Date()) == .active)
        var reopened = thread
        reopened.shell.settledOverride = "active"
        cloud.reconcileThreadActions(with: [reopened])
        // A later remote settle must be visible after the reopen was acknowledged.
        var settled = reopened
        settled.shell.settledOverride = "settled"
        settled.shell.settledAt = Date().ISO8601Format()
        #expect(cloud.optimisticThread(settled) == settled)
    }

    @Test func acknowledgedActionDoesNotMaskLaterRemoteChanges() {
        let thread = makeAgentThread()
        let cloud = PathwayCloudModel()
        cloud.beginThreadAction(.pin, thread: thread)
        var confirmed = thread
        confirmed.shell.pinnedAt = Date().ISO8601Format()
        cloud.reconcileThreadActions(with: [confirmed])
        #expect(cloud.optimisticThread(thread) == thread)
    }

    @Test func metadataAndLifecycleActionsHaveImmediatePredictedValues() {
        let thread = makeAgentThread()
        let now = Date()
        let cases: [PathwayThreadAction] = [
            .pin, .unpin, .rename("  Renamed  "), .archive, .restore, .delete,
            .settle, .forceSettle, .discardAndSettle, .reopen, .wake,
            .sleep(until: now.addingTimeInterval(3600)), .keepConversation,
            .attachProject("new-project"), .settleAfterCompletion(true),
            .settleAfterCompletion(false), .reorder("a1")
        ]
        for action in cases {
            let mutation = PathwayOptimisticThreadAction(threadID: thread.id, action: action, date: now)
            let updated = mutation.applying(to: thread)
            #expect(mutation.isReflected(in: updated))
            #expect(updated.id == thread.id)
            #expect(updated.shell.modelSelection == thread.shell.modelSelection)
        }
    }

    @Test func temporarySettleDisappearsAndCanBeRestoredForGitConfirmation() {
        var thread = makeAgentThread()
        thread.shell.temporary = true
        let cloud = PathwayCloudModel()
        let mutation = cloud.beginThreadAction(.settle, thread: thread)
        #expect(PathwayThreadLifecyclePartition(threads: [cloud.optimisticThread(thread)], now: Date()).all.isEmpty)
        cloud.rollbackThreadAction(mutation)
        #expect(cloud.optimisticThread(thread) == thread)
    }

    @Test func optimisticActionsAreScopedToCompanyAndEnvironment() {
        let thread = makeAgentThread()
        let other = PathwayAgentThread(companyId: thread.companyId, environmentId: "other",
            cloudProjectId: thread.cloudProjectId, shell: thread.shell, cloudUpdatedAt: 0)
        let cloud = PathwayCloudModel()
        cloud.beginThreadAction(.archive, thread: thread)
        #expect(cloud.optimisticThread(other) == other)
        #expect(cloud.optimisticThread(thread).shell.archivedAt != nil)
    }


    @Test func pinnedReorderingChangesTheRenderedOrderImmediately() {
        let first = makeAgentThread(pinnedAt: "2026-01-01T00:00:00Z")
        let second = PathwayAgentThread(companyId: first.companyId, environmentId: "second",
            cloudProjectId: first.cloudProjectId, shell: first.shell, cloudUpdatedAt: 0)
        let cloud = PathwayCloudModel()
        let writes = PathwayThreadOrder.plan(ordered: [second, first], movedID: second.id)
        for (thread, key) in writes { cloud.beginThreadAction(.reorder(key), thread: thread) }
        let partition = PathwayThreadLifecyclePartition(threads: [first, second].map { cloud.optimisticThread($0) }, now: Date())
        #expect(partition.active.map(\.id) == [second.id, first.id])
    }

}
