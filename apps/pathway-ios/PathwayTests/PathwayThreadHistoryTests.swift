import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadHistoryTests {
    @Test func olderPagesPrependInOrderWithOneRequestInFlight() async throws {
        let model = makeModel()
        var requests: [(Int, String?)] = []
        model.historyPageLoader = { _, limit, before in
            requests.append((limit, before))
            return page(1...50, hasOlder: false, sequence: 4)
        }
        model.installSnapshot(projection(51...100), sequence: 9, history: history(hasOlder: true, before: "item-51"))
        #expect(model.items.count == 50)

        let task = try #require(model.loadOlderHistory())
        #expect(model.loadOlderHistory() == nil)
        await task.value

        #expect(requests.count == 1)
        #expect(requests.first?.0 == PathwayThreadHistory.olderPageLimit)
        #expect(requests.first?.1 == "item-51")
        #expect(model.items.map(\.id) == (1...100).map { "item-\($0)" })
        #expect(model.history == PathwayThreadHistory(hasOlder: false, beforeCursor: "item-1"))
        #expect(model.loadOlderHistory() == nil)
        // The older page's sequence does not rewind the live stream.
        model.applySubscriptionValue(event(sequence: 9, item: message(100, text: "stale")))
        #expect(model.items.last?.text == "Message 100")
        model.applySubscriptionValue(event(sequence: 10, item: message(100, text: "live")))
        #expect(model.items.last?.text == "live")
    }

    @Test func aReplacingSnapshotDiscardsAnInFlightOlderPage() async throws {
        let model = makeModel()
        model.historyPageLoader = { _, _, _ in page(1...50, hasOlder: false) }
        model.installSnapshot(projection(51...100), history: history(hasOlder: true, before: "item-51"))
        let task = try #require(model.loadOlderHistory())
        // A reconnect after more than a page of new rows leaves no overlap to stitch.
        model.installSnapshot(projection(200...249), history: history(hasOlder: true, before: "item-200"))
        await task.value
        #expect(model.items.map(\.id) == (200...249).map { "item-\($0)" })
        #expect(model.history?.beforeCursor == "item-200")
        #expect(!model.isLoadingOlderHistory)
    }

    @Test func aReconnectPageKeepsTheOlderRowsItOverlaps() async throws {
        let model = makeModel()
        model.historyPageLoader = { _, _, _ in page(1...50, hasOlder: false) }
        model.installSnapshot(projection(51...100), history: history(hasOlder: true, before: "item-51"))
        await model.loadOlderHistory()?.value
        model.installSnapshot(projection(61...110), history: history(hasOlder: true, before: "item-61"))
        #expect(model.items.map(\.id) == (1...110).map { "item-\($0)" })
        #expect(model.history?.hasOlder == false)
    }

    @Test func completeSnapshotsHaveNoHistoryWindow() {
        let model = makeModel()
        var loads = 0
        model.historyPageLoader = { _, _, _ in loads += 1; return .null }
        model.installSnapshot(projection(1...20))
        #expect(model.history == nil)
        #expect(model.loadOlderHistory() == nil)
        #expect(loads == 0)
    }

    @Test func aFailedPageCanBeRetried() async throws {
        let model = makeModel()
        var fails = true
        model.historyPageLoader = { _, _, _ in
            if fails { throw URLError(.notConnectedToInternet) }
            return page(1...50, hasOlder: false)
        }
        model.installSnapshot(projection(51...100), history: history(hasOlder: true, before: "item-51"))
        await model.loadOlderHistory()?.value
        #expect(model.olderHistoryError != nil)
        #expect(model.items.count == 50)
        fails = false
        await model.loadOlderHistory()?.value
        #expect(model.olderHistoryError == nil)
        #expect(model.items.count == 100)
    }

    @Test func rowsOlderThanTheSliceWaitForTheirPageButPendingQuestionsStayReachable() {
        let model = makeModel()
        let supportQuestion = question(5)
        var snapshot = projection(51...100).objectValue ?? [:]
        snapshot["turnItems"] = .array([supportQuestion])
        snapshot["runtimeRequests"] = .array([.object(["id": .string("request-5"), "status": .string("pending"), "isBlocking": .bool(false)])])
        model.installSnapshot(.object(snapshot), sequence: 1, history: history(hasOlder: true, before: "item-51"))
        #expect(model.items.count == 50)
        #expect(model.pendingAsyncQuestions.map(\.id) == ["item-5"])

        // An older row updated live is not inserted ahead of the gap.
        model.applySubscriptionValue(event(sequence: 2, item: message(10, text: "edited")))
        #expect(model.items.first?.id == "item-51")
        #expect(model.items.count == 50)
    }

    @Test func theCacheKeepsOnlyTheLatestRows() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = PathwayThreadCache(directory: directory)
        let model = makeModel(persistsLocalState: true, cache: cache)
        model.installSnapshot(projection(1...300))
        await model.stop()
        let cached = try #require(await cache.load(threadID: model.thread.id))
        #expect(cached.count == PathwayAgentThreadModel.cachedItemLimit)
        #expect(cached.last?.id == "item-300")
    }

    private func makeModel(persistsLocalState: Bool = false, cache: PathwayThreadCache = PathwayThreadCache()) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: thread, environment: environment, request: { _, _ in .object([:]) }, persistsLocalState: persistsLocalState, cache: cache)
    }
}

private func message(_ ordinal: Int, text: String? = nil) -> JSONValue {
    .object(["id": .string("item-\(ordinal)"), "ordinal": .number(Double(ordinal)), "type": .string("assistant_message"),
             "status": .string("completed"), "text": .string(text ?? "Message \(ordinal)")])
}

private func question(_ ordinal: Int) -> JSONValue {
    .object(["id": .string("item-\(ordinal)"), "ordinal": .number(Double(ordinal)), "type": .string("user_input_request"),
             "status": .string("waiting"), "requestId": .string("request-\(ordinal)"),
             "questions": .array([.object(["id": .string("q"), "header": .string("Pick"), "question": .string("Which?"), "options": .array([])])])])
}

private func projection(_ ordinals: ClosedRange<Int>) -> JSONValue {
    .object(["thread": .object(["id": .string("thread-1")]), "runs": .array([]),
             "visibleTurnItems": .array(ordinals.map { .object(["item": message($0)]) })])
}

private func history(hasOlder: Bool, before: String) -> JSONValue {
    .object(["hasOlder": .bool(hasOlder), "hasNewer": .bool(false), "beforeCursor": .string(before), "index": .array([])])
}

private func page(_ ordinals: ClosedRange<Int>, hasOlder: Bool, sequence: Int = 0) -> JSONValue {
    .object(["snapshotSequence": .number(Double(sequence)), "projection": projection(ordinals),
             "history": history(hasOlder: hasOlder, before: "item-\(ordinals.lowerBound)")])
}

private func event(sequence: Int, item: JSONValue) -> JSONValue {
    .object(["kind": .string("event"), "sequence": .number(Double(sequence)),
             "event": .object(["type": .string("turn-item.updated"), "payload": item])])
}
