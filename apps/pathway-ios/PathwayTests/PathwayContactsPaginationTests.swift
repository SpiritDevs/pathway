import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayContactsPaginationTests {
    private func row(_ id: String, name: String? = nil) -> JSONValue {
        .object(["id": .string(id), "name": .string(name ?? id), "role": .string("Engineer"), "company": .string("Example"), "email": .string("person@example.test"), "phone": .string(""), "notes": .string(""), "favorite": .bool(true), "createdAt": .string("2026-09-06T00:00:00Z"), "revision": .number(1)])
    }
    private func page(_ ids: [String], cursor: String? = nil) -> JSONValue {
        .object(["contacts": .array(ids.map { row($0) }), "cursor": cursor.map(JSONValue.string) ?? .null, "isDone": .bool(cursor == nil)])
    }
    @Test func subsequentPagesKeepTheFullDirectorySearchAndFavoriteFilter() async throws {
        var arguments: JSONValue?
        let model = PathwayContactsModel(request: { kind, name, args in
            #expect(kind == "query")
            #expect(name == "contacts:list")
            arguments = args
            return page(["first", "second"])
        }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(page(["first"], cursor: "next")); $0.finish() } })
        await model.observe(companyID: "company", search: "Example", searchField: "company", favoritesOnly: true)
        try await model.loadMore()
        #expect(model.contacts.map(\.id) == ["first", "second"])
        #expect(!model.hasMore)
        #expect(arguments?.objectValue?["companyId"] == .string("company"))
        #expect(arguments?.objectValue?["search"] == .string("Example"))
        #expect(arguments?.objectValue?["searchField"] == .string("company"))
        #expect(arguments?.objectValue?["favoritesOnly"] == .bool(true))
        #expect(arguments?.objectValue?["cursor"] == .string("next"))
    }
    @Test(arguments: [false, true]) func switchingSearchDiscardsAnOutstandingPage(fails: Bool) async throws {
        let (started, signal) = AsyncStream<Void>.makeStream()
        var completion: CheckedContinuation<JSONValue, Error>?
        let model = PathwayContactsModel(request: { _, _, _ in
            signal.yield(())
            return try await withCheckedThrowingContinuation { completion = $0 }
        }, subscribe: { _, args in AsyncThrowingStream {
            $0.yield(page([args.objectValue?["search"]?.stringValue ?? ""], cursor: "next")); $0.finish()
        } })
        await model.observe(companyID: "one", search: "old")
        let load = Task { try await model.loadMore() }
        for await _ in started { break }
        await model.observe(companyID: "two", search: "new")
        if fails { completion?.resume(throwing: URLError(.notConnectedToInternet)) }
        else { completion?.resume(returning: page(["private old result"])) }
        try await load.value
        #expect(model.companyID == "two")
        #expect(model.contacts.map(\.id) == ["new"])
        #expect(!model.loadingMore)
        #expect(model.errorMessage == nil)
        model.clear()
        #expect(model.contacts.isEmpty)
        #expect(!model.hasMore)
    }
    @Test(arguments: [false, true]) func upsertInvalidatesAppendedFavoritesOnlyAfterSuccess(fails: Bool) async throws {
        var pageCalls = 0
        let model = PathwayContactsModel(request: { kind, _, args in
            if kind == "mutation" {
                if fails { throw URLError(.notConnectedToInternet) }
                return .null
            }
            pageCalls += 1
            #expect(args.objectValue?["cursor"] == .string("second"))
            return page(pageCalls == 1 ? ["older favorite"] : [], cursor: nil)
        }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(page(["first"], cursor: "second")); $0.finish() } })
        await model.observe(companyID: "company", search: "Example", searchField: "company", favoritesOnly: true)
        try await model.loadMore()
        var edited = try #require(model.contacts.last)
        edited.favorite = false; edited.company = "No longer matches"
        do { try await model.save(edited, companyID: "company", requestID: "edit") }
        catch { #expect(fails) }
        #expect(model.contacts.map(\.id) == (fails ? ["first", "older favorite"] : ["first"]))
        #expect(model.hasMore == !fails)
        if !fails {
            try await model.loadMore()
            #expect(pageCalls == 2)
            #expect(model.contacts.map(\.id) == ["first"])
        }
    }
    @Test func anAcceptedEditPreventsAnInFlightPageFromRestoringOldMatches() async throws {
        let (started, signal) = AsyncStream<Void>.makeStream()
        var completion: CheckedContinuation<JSONValue, Error>?
        let model = PathwayContactsModel(request: { kind, _, _ in
            if kind == "mutation" { return .null }
            signal.yield(())
            return try await withCheckedThrowingContinuation { completion = $0 }
        }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(page(["first"], cursor: "next")); $0.finish() } })
        await model.observe(companyID: "company", favoritesOnly: true)
        let load = Task { try await model.loadMore() }
        for await _ in started { break }
        let edited = try #require(model.contacts.first)
        try await model.save(edited, companyID: "company", requestID: "edit")
        completion?.resume(returning: page(["stale match"]))
        try await load.value
        #expect(model.contacts.map(\.id) == ["first"])
        #expect(model.hasMore)
        #expect(!model.loadingMore)
    }
    @Test func savingDoesNotRestoreADeletedFirstPageContactBeforeTheSubscriptionRefreshes() async throws {
        let model = PathwayContactsModel(request: { _, _, _ in .null }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(page(["deleted", "remaining"])); $0.finish() } })
        await model.observe(companyID: "company")
        let deleted = try #require(model.contacts.first)
        try await model.remove(deleted, companyID: "company")
        let edited = try #require(model.contacts.first)
        try await model.save(edited, companyID: "company", requestID: "edit")
        #expect(model.contacts.map(\.id) == ["remaining"])
    }
    @Test func contactDetailKeepsItsOwnSubscriptionOutsideTheLoadedDirectoryPage() async throws {
        var received: [String?] = []
        let model = PathwayContactsModel(request: { _, _, _ in .null }, subscribe: { name, args in
            #expect(name == "contacts:get")
            #expect(args.objectValue?["companyId"] == .string("company"))
            #expect(args.objectValue?["id"] == .string("older"))
            return AsyncThrowingStream { $0.yield(row("older", name: "Updated")); $0.yield(.null); $0.finish() }
        })
        try await model.observeContact(companyID: "company", contactID: "older") { received.append($0?.name) }
        #expect(received == ["Updated", nil])
        #expect(model.contacts.isEmpty)
    }
}
