import Foundation
import Observation

struct PathwayMailAccount: Decodable, Identifiable, Equatable {
  let id: String
  let email: String
  let status: String
  let credentialSource: String
  let brain: JSONValue?
  let lastSyncAt: Double?
  let lastError: String?

  func gmailMessageURL(providerMessageID: String) -> URL? {
    guard !providerMessageID.isEmpty else { return nil }
    var components = URLComponents()
    components.scheme = "https"
    components.host = "mail.google.com"
    components.path = "/mail/u/"
    components.queryItems = [URLQueryItem(name: "authuser", value: email)]
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%2B")
    components.fragment = "all/\(providerMessageID)"
    return components.url
  }
}

struct PathwayMailAddress: Codable, Equatable {
  let email: String
  let name: String?
}
struct PathwayMailAttachment: Codable, Identifiable, Equatable {
  let partId: String
  let filename: String
  let mimeType: String
  let size: Int
  let blobKey: String?
  var id: String { partId }
}
struct PathwayMailMessage: Decodable, Identifiable, Equatable {
  let id: String
  let accountId: String
  let providerThreadId: String
  let providerMessageId: String?
  let from: PathwayMailAddress
  let to: [String]
  let cc: [String]
  let subject: String
  let snippet: String
  let receivedAt: Double
  let read: Bool
  let bucket: String
  let reason: String
  let analysisStatus: String
  let briefing: String?
  let textBody: String?
  let htmlBody: String?
  let bodyBlobKey: String?
  let bodyTruncated: Bool?
  let attachments: [PathwayMailAttachment]
}
struct PathwayMailPage: Decodable {
  let messages: [PathwayMailMessage]
  let nextCursor: String?
}
struct PathwayMailDraft: Decodable, Identifiable, Equatable {
  let id: String
  let accountId: String
  let replyToMessageId: String?
  let to: [String]
  let subject: String
  let text: String
  let status: String
  let lastError: String?
  var isEditable: Bool { status == "draft" || status == "failed" }
}
struct PathwayMailSender: Decodable {
  let summary: String
  let messageCount: Int
}

@MainActor @Observable
final class PathwayConnectedMailModel {
  typealias CloudRequest = @MainActor (String, String, JSONValue) async throws -> JSONValue
  typealias Subscribe = @MainActor (String, JSONValue) -> AsyncThrowingStream<JSONValue, Error>
  typealias RelayRequest = @MainActor (String, JSONValue) async throws -> JSONValue
  typealias EnvironmentRequest = @MainActor (PathwayCompanyEnvironment) async throws -> JSONValue
  private(set) var accounts: [PathwayMailAccount] = []
  private(set) var messages: [PathwayMailMessage] = []
  private(set) var companyID = ""
  private(set) var loading = false
  private(set) var hasMore = false
  private(set) var loadingMore = false
  var errorMessage: String?
  @ObservationIgnored private let request: CloudRequest
  @ObservationIgnored private let subscribe: Subscribe
  @ObservationIgnored private let relayRequest: RelayRequest
  @ObservationIgnored private let environmentRequest: EnvironmentRequest
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var pageGeneration = 0
  @ObservationIgnored private var firstPageIDs: Set<String> = []
  @ObservationIgnored private var hasLoadedAdditionalPages = false
  @ObservationIgnored private var accountID = ""
  @ObservationIgnored private var bucket = "priority"
  @ObservationIgnored private var cursor: String?

  init(
    request: @escaping CloudRequest, subscribe: @escaping Subscribe,
    relayRequest: @escaping RelayRequest, environmentRequest: @escaping EnvironmentRequest
  ) {
    self.request = request
    self.subscribe = subscribe
    self.relayRequest = relayRequest
    self.environmentRequest = environmentRequest
  }
  func clear() {
    generation += 1
    pageGeneration += 1
    accounts = []
    messages = []
    firstPageIDs = []
    hasLoadedAdditionalPages = false
    companyID = ""
    cursor = nil
    hasMore = false
    loading = false
    loadingMore = false
    errorMessage = nil
  }
  func observeAccounts(companyID: String) async {
    clear()
    self.companyID = companyID
    let current = generation
    guard !companyID.isEmpty else { return }
    do {
      for try await value in subscribe(
        "mail:listAccounts", .object(["companyId": .string(companyID)]))
      {
        guard !Task.isCancelled, current == generation else { return }
        accounts = try decodePathwayPayload([PathwayMailAccount].self, from: value)
      }
    } catch {
      guard !Task.isCancelled, current == generation else { return }
      accounts = []
      errorMessage = error.localizedDescription
    }
  }
  func observeMessages(companyID: String, accountID: String, bucket: String) async {
    pageGeneration += 1
    let pageVersion = pageGeneration
    self.accountID = accountID
    self.bucket = bucket
    messages = []
    firstPageIDs = []
    hasLoadedAdditionalPages = false
    cursor = nil
    hasMore = false
    loadingMore = false
    guard !companyID.isEmpty else {
      loading = false
      return
    }
    loading = true
    errorMessage = nil
    do {
      for try await value in subscribe("mail:listMessages", listArguments(companyID: companyID)) {
        guard !Task.isCancelled, pageVersion == pageGeneration, self.companyID == companyID else {
          return
        }
        let page = try decodePathwayPayload(PathwayMailPage.self, from: value)
        applyFirstPage(page)
        loading = false
      }
    } catch {
      guard !Task.isCancelled, pageVersion == pageGeneration, self.companyID == companyID else {
        return
      }
      messages = []
      errorMessage = error.localizedDescription
      loading = false
    }
  }
  private func applyFirstPage(_ page: PathwayMailPage) {
    let refreshedIDs = Set(page.messages.map(\.id))
    if page.nextCursor == nil {
      messages = page.messages
      hasLoadedAdditionalPages = false
      cursor = nil
    } else {
      let preserveBoundary = hasLoadedAdditionalPages || loadingMore
      let boundary = page.messages.last
      let retained = messages.filter { message in
        guard !refreshedIDs.contains(message.id) else { return false }
        if !firstPageIDs.contains(message.id) { return true }
        guard preserveBoundary, let boundary else { return false }
        return message.receivedAt < boundary.receivedAt
          || (message.receivedAt == boundary.receivedAt && message.id < boundary.id)
      }
      messages = page.messages + retained
      if !hasLoadedAdditionalPages { cursor = page.nextCursor }
    }
    firstPageIDs = refreshedIDs
    hasMore = cursor != nil
  }
  private func listArguments(companyID: String, cursor: String? = nil) -> JSONValue {
    var fields: [String: JSONValue] = ["companyId": .string(companyID), "limit": .number(50)]
    if !accountID.isEmpty { fields["accountId"] = .string(accountID) }
    if bucket != "all" { fields["bucket"] = .string(bucket) }
    if let cursor { fields["cursor"] = .string(cursor) }
    return .object(fields)
  }
  func loadMore() async throws {
    guard !loadingMore, hasMore, let cursor, !companyID.isEmpty else { return }
    let current = generation
    let pageVersion = pageGeneration
    loadingMore = true
    defer { if current == generation, pageVersion == pageGeneration { loadingMore = false } }
    let value: JSONValue
    do {
      value = try await request(
        "query", "mail:listMessages", listArguments(companyID: companyID, cursor: cursor))
    } catch {
      guard !Task.isCancelled, current == generation, pageVersion == pageGeneration else { return }
      throw error
    }
    guard !Task.isCancelled, current == generation, pageVersion == pageGeneration else { return }
    let page = try decodePathwayPayload(PathwayMailPage.self, from: value)
    var existingIDs = Set(messages.map(\.id))
    messages += page.messages.filter { existingIDs.insert($0.id).inserted }
    hasLoadedAdditionalPages = true
    self.cursor = page.nextCursor
    hasMore = page.nextCursor != nil
  }
  func observe<Result: Decodable>(
    _ type: Result.Type, name: String, companyID: String, fields: [String: JSONValue],
    receive: @MainActor (Result) -> Void
  ) async throws {
    var args = fields
    args["companyId"] = .string(companyID)
    let current = generation
    for try await value in subscribe(name, .object(args)) {
      guard !Task.isCancelled, current == generation, self.companyID == companyID else { return }
      receive(try decodePathwayPayload(type, from: value))
    }
  }
  func query(_ name: String, companyID: String, fields: [String: JSONValue]) async throws
    -> JSONValue
  {
    var args = fields
    args["companyId"] = .string(companyID)
    return try await request("query", name, .object(args))
  }
  func mutate(_ name: String, companyID: String, fields: [String: JSONValue]) async throws
    -> JSONValue
  {
    var args = fields
    args["companyId"] = .string(companyID)
    return try await request("mutation", name, .object(args))
  }
  func discardDraft(companyID: String, draftID: String) async throws {
    _ = try await mutate(
      "mail:discardDraft", companyID: companyID, fields: ["draftId": .string(draftID)])
  }
  func relay(_ path: String, companyID: String, fields: [String: JSONValue]) async throws
    -> JSONValue
  {
    var args = fields
    args["companyId"] = .string(companyID)
    return try await relayRequest(path, .object(args))
  }
  func downloadURL(companyID: String, messageID: String, blobKey: String) async throws -> URL {
    let response = try await relay(
      "download", companyID: companyID,
      fields: ["messageId": .string(messageID), "blobKey": .string(blobKey)])
    guard let raw = response.objectValue?["url"]?.stringValue, let url = URL(string: raw),
      url.scheme == "https"
    else { throw URLError(.badServerResponse) }
    return url
  }
  func configuration(environment: PathwayCompanyEnvironment) async throws -> JSONValue {
    try await environmentRequest(environment)
  }
}
