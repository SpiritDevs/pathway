import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayTimePaginationTests {
    private func session(_ id: String) -> JSONValue {
        .object(["id": .string(id), "description": .string(id), "projectKey": .string(""), "projectName": .string("No project"), "startedAt": .string("2026-09-06T10:00:00Z"), "stoppedAt": .string("2026-09-06T11:00:00Z"), "durationMs": .number(3_600_000)])
    }
    private func page(_ ids: [String], cursor: String? = nil) -> JSONValue {
        .object(["active": .null, "entries": .array(ids.map(session)), "cursor": cursor.map(JSONValue.string) ?? .null, "isDone": .bool(cursor == nil)])
    }
    @Test func historyLoadsEveryPageWithTheSameSelectedPeriod() async throws {
        var pageArguments: JSONValue?
        let model = PathwayTimeModel(request: { kind, name, args in
            #expect(kind == "query")
            #expect(name == "timeTracking:listMine")
            pageArguments = args
            return page(["first", "second"])
        }, subscribe: { name, _ in AsyncThrowingStream {
            if name == "timeTracking:listMine" { $0.yield(page(["first"], cursor: "next")) }
            $0.finish()
        } })
        let boundary = Date(timeIntervalSince1970: 1_000)
        await model.observe(accountID: "account", since: boundary)
        #expect(model.hasMore)
        try await model.loadMore()
        #expect(model.entries.map(\.id) == ["first", "second"])
        #expect(!model.hasMore)
        #expect(pageArguments?.objectValue?["cursor"] == .string("next"))
        #expect(pageArguments?.objectValue?["since"] == .string(boundary.ISO8601Format()))
    }
    @Test(arguments: [false, true]) func clearingTheAccountRejectsAnOutstandingHistoryPage(fails: Bool) async throws {
        let (started, signal) = AsyncStream<Void>.makeStream()
        var completion: CheckedContinuation<JSONValue, Error>?
        let model = PathwayTimeModel(request: { _, _, _ in
            signal.yield(())
            return try await withCheckedThrowingContinuation { completion = $0 }
        }, subscribe: { name, _ in AsyncThrowingStream {
            if name == "timeTracking:listMine" { $0.yield(page(["private"], cursor: "next")) }
            $0.finish()
        } })
        await model.observe(accountID: "one")
        let load = Task { try await model.loadMore() }
        for await _ in started { break }
        model.clear()
        if fails { completion?.resume(throwing: URLError(.notConnectedToInternet)) }
        else { completion?.resume(returning: page(["older private"])) }
        try await load.value
        #expect(model.entries.isEmpty)
        #expect(!model.hasMore)
        #expect(!model.loadingMore)
        #expect(model.totals == nil)
    }
    @Test func refreshingHistoryRejectsAnOlderPageFromTheSameAccount() async throws {
        let (started, signal) = AsyncStream<Void>.makeStream()
        var completion: CheckedContinuation<JSONValue, Error>?
        var firstPage = page(["before"], cursor: "next")
        let model = PathwayTimeModel(request: { _, _, _ in
            signal.yield(())
            return try await withCheckedThrowingContinuation { completion = $0 }
        }, subscribe: { name, _ in AsyncThrowingStream {
            if name == "timeTracking:listMine" { $0.yield(firstPage) }
            $0.finish()
        } })
        await model.observe(accountID: "account")
        let load = Task { try await model.loadMore() }
        for await _ in started { break }
        firstPage = page(["after"])
        await model.observe(accountID: "account")
        completion?.resume(returning: page(["stale"]))
        try await load.value
        #expect(model.entries.map(\.id) == ["after"])
        #expect(!model.hasMore)
    }
}
