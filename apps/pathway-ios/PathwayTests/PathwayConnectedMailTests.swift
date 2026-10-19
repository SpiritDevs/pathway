import Foundation
import Observation
import Testing

@testable import Pathway

@MainActor struct PathwayConnectedMailTests {
  private func message(_ id: String, read: Bool = false) -> JSONValue {
    .object([
      "id": .string(id), "accountId": .string("gmail"), "providerThreadId": .string("conversation"),
      "from": .object(["email": .string("sender@example.test")]),
      "to": .array([.string("reader@example.test")]), "cc": .array([]), "subject": .string("Hello"),
      "snippet": .string("Message preview"), "receivedAt": .number(1000), "read": .bool(read),
      "bucket": .string("priority"), "reason": .string("A reply is needed"),
      "analysisStatus": .string("pending"), "attachments": .array([]),
    ])
  }
  private func page(_ ids: [String], cursor: String? = nil) -> JSONValue {
    .object([
      "messages": .array(ids.map { message($0) }),
      "nextCursor": cursor.map(JSONValue.string) ?? .null,
    ])
  }
  private func model(
    request: @escaping PathwayConnectedMailModel.CloudRequest,
    subscribe: @escaping PathwayConnectedMailModel.Subscribe
  ) -> PathwayConnectedMailModel {
    .init(
      request: request, subscribe: subscribe, relayRequest: { _, _ in .null },
      environmentRequest: { _ in .null })
  }
  @Test func listsOnlyMetadataAndPreservesAccountAndBucketDuringPagination() async throws {
    var requests: [JSONValue] = []
    let model = model(
      request: { kind, name, args in
        #expect(kind == "query")
        #expect(name == "mail:listMessages")
        requests.append(args)
        return page(["first", "second"])
      },
      subscribe: { name, args in
        AsyncThrowingStream {
          if name == "mail:listAccounts" {
            $0.yield(.array([]))
          } else {
            #expect(args.objectValue?["bucket"] == .string("noise"))
            $0.yield(page(["first"], cursor: "next"))
          }
          $0.finish()
        }
      })
    await model.observeAccounts(companyID: "company")
    await model.observeMessages(companyID: "company", accountID: "gmail", bucket: "noise")
    try await model.loadMore()
    #expect(model.messages.map(\.id) == ["first", "second"])
    #expect(model.messages.first?.to == ["reader@example.test"])
    #expect(model.messages.first?.htmlBody == nil)
    #expect(requests.first?.objectValue?["companyId"] == .string("company"))
    #expect(requests.first?.objectValue?["accountId"] == .string("gmail"))
    #expect(requests.first?.objectValue?["bucket"] == .string("noise"))
    #expect(requests.first?.objectValue?["cursor"] == .string("next"))
    #expect(!model.hasMore)
  }
  @Test(arguments: [false, true]) func switchingWorkspaceFencesOutstandingPrivatePages(fails: Bool)
    async throws
  {
    let (started, signal) = AsyncStream<Void>.makeStream()
    var completion: CheckedContinuation<JSONValue, Error>?
    let model = model(
      request: { _, _, _ in
        signal.yield(())
        return try await withCheckedThrowingContinuation { completion = $0 }
      },
      subscribe: { name, args in
        AsyncThrowingStream {
          $0.yield(
            name == "mail:listAccounts"
              ? .array([])
              : page([args.objectValue?["companyId"]?.stringValue ?? ""], cursor: "next"))
          $0.finish()
        }
      })
    await model.observeAccounts(companyID: "old")
    await model.observeMessages(companyID: "old", accountID: "gmail", bucket: "all")
    let pending = Task { try await model.loadMore() }
    for await _ in started { break }
    await model.observeAccounts(companyID: "new")
    await model.observeMessages(companyID: "new", accountID: "gmail", bucket: "all")
    if fails {
      completion?.resume(throwing: URLError(.notConnectedToInternet))
    } else {
      completion?.resume(returning: page(["old private mail"]))
    }
    try await pending.value
    #expect(model.messages.map(\.id) == ["new"])
    #expect(!model.loadingMore)
    #expect(model.errorMessage == nil)
    model.clear()
    #expect(model.messages.isEmpty)
    #expect(model.accounts.isEmpty)
  }
  @Test func mailboxMutationAlwaysIncludesWorkspaceAndDoesNotSendImplicitly() async throws {
    var names: [String] = []
    let model = model(
      request: { kind, name, args in
        #expect(kind == "mutation")
        #expect(args.objectValue?["companyId"] == .string("company"))
        names.append(name)
        return .string("draft")
      }, subscribe: { _, _ in AsyncThrowingStream { $0.finish() } })
    _ = try await model.mutate(
      "mail:saveDraft", companyID: "company",
      fields: [
        "accountId": .string("gmail"), "to": .array([.string("recipient@example.test")]),
        "subject": .string("Hello"), "text": .string("Draft only"),
      ])
    #expect(names == ["mail:saveDraft"])
  }
  private func afterMessagesChange(
    _ model: PathwayConnectedMailModel, perform: () -> Void
  ) async {
    await withCheckedContinuation { continuation in
      withObservationTracking {
        _ = model.messages
      } onChange: {
        Task { @MainActor in continuation.resume() }
      }
      perform()
    }
  }

  @Test func refreshedFirstPagePreservesLoadedTailAndPaginationCursor() async throws {
    let (updates, input) = AsyncThrowingStream<JSONValue, Error>.makeStream()
    let (subscribed, ready) = AsyncStream<Void>.makeStream()
    var requestedCursors: [String] = []
    let model = model(
      request: { _, _, arguments in
        requestedCursors.append(arguments.objectValue?["cursor"]?.stringValue ?? "")
        return requestedCursors.count == 1
          ? page(["x", "w"], cursor: "older") : page(["v"])
      },
      subscribe: { name, _ in
        if name == "mail:listAccounts" {
          return AsyncThrowingStream {
            $0.yield(.array([]))
            $0.finish()
          }
        }
        ready.yield(())
        return updates
      })
    await model.observeAccounts(companyID: "company")
    let observing = Task {
      await model.observeMessages(companyID: "company", accountID: "gmail", bucket: "priority")
    }
    for await _ in subscribed { break }
    await afterMessagesChange(model) { input.yield(page(["z", "y"], cursor: "head")) }
    try await model.loadMore()
    await afterMessagesChange(model) {
      input.yield(page(["zz", "z"], cursor: "refreshed-head"))
    }
    #expect(model.messages.map(\.id) == ["zz", "z", "y", "x", "w"])
    #expect(model.hasMore)
    await afterMessagesChange(model) {
      input.yield(
        .object([
          "messages": .array([message("zz"), message("z"), message("y"), message("x", read: true)]),
          "nextCursor": .string("another-head"),
        ]))
    }
    #expect(model.messages.map(\.id) == ["zz", "z", "y", "x", "w"])
    try await model.loadMore()
    #expect(requestedCursors == ["head", "older"])
    #expect(model.messages.first(where: { $0.id == "x" })?.read == true)
    #expect(model.messages.map(\.id) == ["zz", "z", "y", "x", "w", "v"])
    #expect(!model.hasMore)
    input.finish()
    await observing.value
  }

  @Test func firstPageUpdateDoesNotLoseAnInFlightOlderPageOrDuplicateRows() async throws {
    let (updates, input) = AsyncThrowingStream<JSONValue, Error>.makeStream()
    let (subscribed, ready) = AsyncStream<Void>.makeStream()
    let (requested, started) = AsyncStream<Void>.makeStream()
    var completion: CheckedContinuation<JSONValue, Error>?
    let model = model(
      request: { _, _, _ in
        started.yield(())
        return try await withCheckedThrowingContinuation { completion = $0 }
      },
      subscribe: { name, _ in
        if name == "mail:listAccounts" {
          return AsyncThrowingStream {
            $0.yield(.array([]))
            $0.finish()
          }
        }
        ready.yield(())
        return updates
      })
    await model.observeAccounts(companyID: "company")
    let observing = Task {
      await model.observeMessages(companyID: "company", accountID: "gmail", bucket: "priority")
    }
    for await _ in subscribed { break }
    await afterMessagesChange(model) { input.yield(page(["z", "y"], cursor: "head")) }
    let loading = Task { try await model.loadMore() }
    for await _ in requested { break }
    await afterMessagesChange(model) { input.yield(page(["zz", "z"], cursor: "new-head")) }
    completion?.resume(returning: page(["y", "x", "x"], cursor: "older"))
    try await loading.value
    #expect(model.messages.map(\.id) == ["zz", "z", "y", "x"])
    #expect(model.hasMore)
    #expect(!model.loadingMore)
    input.finish()
    await observing.value
  }

  @Test func gmailLinkSelectsTheConnectedMailboxIncludingAnEmailAlias() throws {
    let account = try decodePathwayPayload(
      PathwayMailAccount.self,
      from: .object([
        "id": .string("gmail"), "email": .string("work+triage@example.test"),
        "status": .string("active"), "credentialSource": .string("byo"),
      ]))
    let url = try #require(account.gmailMessageURL(providerMessageID: "message-id"))
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.host == "mail.google.com")
    #expect(components.path == "/mail/u/")
    #expect(components.queryItems == [URLQueryItem(name: "authuser", value: account.email)])
    #expect(components.fragment == "all/message-id")
    #expect(url.absoluteString.contains("work%2Btriage"))
    #expect(account.gmailMessageURL(providerMessageID: "") == nil)
  }

  @Test(arguments: ["draft", "failed", "queued", "sending", "unknown", "sent"])
  func onlyEditableDraftsOfferDiscard(status: String) throws {
    let draft = try decodePathwayPayload(
      PathwayMailDraft.self,
      from: .object([
        "id": .string("draft"), "accountId": .string("gmail"), "to": .array([]),
        "subject": .string("Subject"), "text": .string("Body"), "status": .string(status),
      ]))
    #expect(draft.isEditable == ["draft", "failed"].contains(status))
  }

  @Test(arguments: [false, true]) func discardUsesOwnerMutationAndPropagatesFailures(fails: Bool)
    async throws
  {
    var names: [String] = []
    let model = model(
      request: { kind, name, args in
        #expect(kind == "mutation")
        #expect(args == .object(["companyId": .string("company"), "draftId": .string("draft")]))
        names.append(name)
        if fails { throw URLError(.notConnectedToInternet) }
        return .null
      }, subscribe: { _, _ in AsyncThrowingStream { $0.finish() } })
    do {
      try await model.discardDraft(companyID: "company", draftID: "draft")
      #expect(!fails)
    } catch {
      #expect(fails)
      #expect((error as? URLError)?.code == .notConnectedToInternet)
    }
    #expect(names == ["mail:discardDraft"])
  }

}
