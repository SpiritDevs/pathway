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
        await actions.perform(.settle, thread: makeAgentThread(), environments: [], connect: nil)
        #expect(actions.errorMessage != nil)
        #expect(actions.pendingThreadIDs.isEmpty)
    }
}
