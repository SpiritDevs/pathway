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

    private func environment(for thread: PathwayAgentThread) -> PathwayCompanyEnvironment {
        .init(companyId: thread.companyId, environment: .init(id: "environment", environmentId: thread.environmentId,
            descriptor: .init(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
    }

}
