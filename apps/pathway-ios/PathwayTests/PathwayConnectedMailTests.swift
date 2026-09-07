import Foundation
import Testing

@testable import Pathway

@MainActor struct PathwayConnectedMailTests {
  private func message(_ id: String) -> JSONValue {
    .object([
      "id": .string(id), "accountId": .string("gmail"), "providerThreadId": .string("conversation"),
      "from": .object(["email": .string("sender@example.test")]),
      "to": .array([.string("reader@example.test")]), "cc": .array([]), "subject": .string("Hello"),
      "snippet": .string("Message preview"), "receivedAt": .number(1000), "read": .bool(false),
      "bucket": .string("priority"), "reason": .string("A reply is needed"),
      "analysisStatus": .string("pending"), "attachments": .array([]),
    ])
  }
  private func page(_ ids: [String], cursor: String? = nil) -> JSONValue {
    .object([
      "messages": .array(ids.map(message)), "nextCursor": cursor.map(JSONValue.string) ?? .null,
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
}
