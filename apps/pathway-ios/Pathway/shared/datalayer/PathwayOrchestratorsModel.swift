import Foundation
import Observation

struct PathwayOrchestratorRecord: Identifiable, Equatable {
  let id: String
  var fields: [String: JSONValue]
  func string(_ key: String) -> String { fields[key]?.stringValue ?? "" }
  func flag(_ key: String) -> Bool { fields[key]?.boolValue ?? false }
  func number(_ key: String) -> Int { fields[key]?.intValue ?? 0 }
  func strings(_ key: String) -> [String] {
    (fields[key]?.arrayValue ?? []).compactMap(\.stringValue)
  }
  static func records(_ value: JSONValue) -> [Self] {
    (value.arrayValue ?? []).compactMap { value in
      guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
      return .init(id: id, fields: fields)
    }
  }
  var configuration: [String: JSONValue] {
    fields.filter { Self.configurationKeys.contains($0.key) }
  }
  static let configurationKeys: Set<String> = [
    "name", "color", "persona", "instructions", "responsibilities", "reviewIntervalMinutes", "kind",
    "companyId", "projectId", "shared", "models", "environmentIds", "allEnvironments",
    "capabilities", "directorSubjects", "managerSubjects", "maxAssignments", "proactive",
    "rememberAutomatically", "notifyUrgent", "batchCompletions",
  ]
}

@MainActor @Observable
final class PathwayOrchestratorsModel {
  typealias Subscribe = @MainActor (String, JSONValue) -> AsyncThrowingStream<JSONValue, Error>
  private(set) var contacts: [PathwayOrchestratorRecord] = []
  private(set) var chats: [PathwayOrchestratorRecord] = []
  private(set) var messages: [String: [PathwayOrchestratorRecord]] = [:]
  private(set) var work: [String: [PathwayOrchestratorRecord]] = [:]
  private(set) var nextBefore: [String: Int] = [:]
  var selectedID: String?
  var drafts: [String: String] = [:]
  var errorMessage: String?
  private(set) var loading = true
  @ObservationIgnored private var accountID: String?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var observers: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var contactScopes: [String: [PathwayOrchestratorRecord]] = [:]
  @ObservationIgnored private var loadedHistory: Set<String> = []
  @ObservationIgnored private var notificationSequences: [String: Int] = [:]
  @ObservationIgnored private var startedAt = Date().timeIntervalSince1970 * 1000
  @ObservationIgnored private(set) var visibleConversationID: String?
  @ObservationIgnored private let request: PathwayIssuesModel.CloudRequest
  @ObservationIgnored private let subscribe: Subscribe

  init(request: @escaping PathwayIssuesModel.CloudRequest, subscribe: @escaping Subscribe) {
    self.request = request
    self.subscribe = subscribe
  }
  func start(accountID: String, companyIDs: [String]) {
    if self.accountID != accountID {
      stop(clear: true)
      self.accountID = accountID
    }
    let current = generation
    let scopes = Set([""] + companyIDs)
    for scope in contactScopes.keys.filter({ !scopes.contains($0) }) {
      observers.removeValue(forKey: "contacts:\(scope)")?.cancel()
      contactScopes.removeValue(forKey: scope)
    }
    updateContacts()
    for scope in scopes {
      let key = "contacts:\(scope)"
      guard observers[key] == nil else { continue }
      contactScopes[scope] = []
      observers[key] = Task { [weak self] in
        guard let self else { return }
        do {
          for try await value in subscribe(
            "aiOrchestrators:list", .object(scope.isEmpty ? [:] : ["companyId": .string(scope)]))
          {
            guard !Task.isCancelled, generation == current else { return }
            contactScopes[scope] = PathwayOrchestratorRecord.records(value)
            updateContacts()
            loading = false
          }
        } catch {
          if generation == current && !Task.isCancelled {
            contactScopes[scope] = []
            updateContacts()
            errorMessage = error.localizedDescription
            loading = false
          }
        }
        if generation == current && !Task.isCancelled { observers[key] = nil }
      }
    }
    guard observers["chats"] == nil else { return }
    observers["chats"] = Task { [weak self] in
      guard let self else { return }
      do {
        _ = try await request("mutation", "aiOrchestrators:ensurePersonal", .object([:]))
        for try await value in subscribe("aiOrchestrators:listChats", .object([:])) {
          guard !Task.isCancelled, generation == current else { return }
          chats = PathwayOrchestratorRecord.records(value)
          for chat in chats {
            guard let update = chat.fields["notification"]?.objectValue,
              let sequence = update["sequence"]?.intValue,
              sequence > (notificationSequences[chat.id] ?? 0)
            else { continue }
            notificationSequences[chat.id] = sequence
            guard !chat.flag("archived"), sequence > chat.number("readSequence"),
              visibleConversationID != chat.id, update["enabled"]?.boolValue == true,
              Double(update["createdAt"]?.intValue ?? 0) >= startedAt
            else { continue }
            await PathwayNotifications.shared.orchestratorUpdate(
              accountID: accountID, chatID: chat.id, update: update)
            guard generation == current, !Task.isCancelled else { return }
          }
          if !chats.contains(where: { $0.id == selectedID }) { selectedID = nil }
          let allowed = Set(chats.map(\.id))
          messages = messages.filter { allowed.contains($0.key) }
          work = work.filter { allowed.contains($0.key) }
          drafts = drafts.filter { allowed.contains($0.key) }
          nextBefore = nextBefore.filter { allowed.contains($0.key) }
          loadedHistory.formIntersection(allowed)
        }
      } catch {
        if generation == current && !Task.isCancelled {
          chats = []
          messages = [:]
          work = [:]
          selectedID = nil
          errorMessage = error.localizedDescription
        }
      }
      if generation == current && !Task.isCancelled { observers["chats"] = nil }
    }
  }
  private func updateContacts() {
    contacts = Array(
      Dictionary(
        contactScopes.values.flatMap { $0 }.map { ($0.id, $0) },
        uniquingKeysWith: { _, next in next }
      ).values
    ).sorted { $0.string("name") < $1.string("name") }
  }
  func stop(clear: Bool) {
    generation += 1
    observers.values.forEach { $0.cancel() }
    observers = [:]
    visibleConversationID = nil
    if clear {
      accountID = nil
      contacts = []
      contactScopes = [:]
      chats = []
      messages = [:]
      work = [:]
      nextBefore = [:]
      loadedHistory = []
      notificationSequences = [:]
      startedAt = Date().timeIntervalSince1970 * 1000
      drafts = [:]
      selectedID = nil
      errorMessage = nil
      loading = true
    }
  }
  func observeConversation(_ chatID: String) async {
    let current = generation
    visibleConversationID = chatID
    defer {
      if generation == current && visibleConversationID == chatID { visibleConversationID = nil }
    }
    await withTaskGroup(of: Void.self) { group in
      for (key, name) in [
        ("messages", "aiOrchestrators:messages"), ("work", "aiOrchestrators:work"),
      ] {
        group.addTask { @MainActor [weak self] in
          guard let self else { return }
          do {
            for try await value in subscribe(name, .object(["chatId": .string(chatID)])) {
              guard !Task.isCancelled, generation == current else { return }
              if key == "work" {
                work[chatID] = PathwayOrchestratorRecord.records(value)
              } else {
                let page = PathwayOrchestratorRecord.records(
                  value.objectValue?["messages"] ?? .array([]))
                let first = page.first?.number("sequence") ?? Int.max
                let older = (messages[chatID] ?? []).filter { $0.number("sequence") < first }
                messages[chatID] = page.isEmpty ? [] : older + page
                if loadedHistory.insert(chatID).inserted {
                  nextBefore[chatID] = value.objectValue?["nextBefore"]?.intValue
                }
                if let last = page.last {
                  _ = try await request(
                    "mutation", "aiOrchestrators:markRead",
                    .object([
                      "chatId": .string(chatID),
                      "sequence": .number(Double(last.number("sequence"))),
                    ]))
                }
              }
            }
          } catch {
            if generation == current && !Task.isCancelled {
              errorMessage = error.localizedDescription
              if key == "messages" {
                messages[chatID] = []
                nextBefore[chatID] = nil
                loadedHistory.remove(chatID)
              } else {
                work[chatID] = []
              }
            }
          }
        }
      }
    }
  }
  func loadEarlier(_ chatID: String) async throws {
    guard let before = nextBefore[chatID] else { return }
    let current = generation
    let value = try await request(
      "query", "aiOrchestrators:messages",
      .object(["chatId": .string(chatID), "before": .number(Double(before))]))
    guard generation == current, !Task.isCancelled else { return }
    let page = PathwayOrchestratorRecord.records(value.objectValue?["messages"] ?? .array([]))
    let existing = messages[chatID] ?? []
    let known = Set(existing.map(\.id))
    messages[chatID] = page.filter { !known.contains($0.id) } + existing
    nextBefore[chatID] = value.objectValue?["nextBefore"]?.intValue
  }
  func send(chatID: String, targetID: String?) async throws {
    let text = (drafts[chatID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    var fields: [String: JSONValue] = [
      "chatId": .string(chatID), "id": .string(UUID().uuidString.lowercased()),
      "text": .string(text),
    ]
    if let targetID { fields["targetId"] = .string(targetID) }
    _ = try await mutate("send", fields)
    if drafts[chatID]?.trimmingCharacters(in: .whitespacesAndNewlines) == text {
      drafts[chatID] = ""
    }
  }
  func conversation(title: String, orchestratorIDs: [String], companyIDs: [String]) async throws
    -> String
  {
    guard let lead = orchestratorIDs.first else { throw URLError(.badURL) }
    let value = try await mutate(
      "createChat",
      [
        "title": .string(title), "orchestratorIds": .array(orchestratorIDs.map(JSONValue.string)),
        "leadId": .string(lead), "companyIds": .array(companyIDs.map(JSONValue.string)),
      ])
    guard let id = value.stringValue else { throw URLError(.cannotParseResponse) }
    selectedID = id
    return id
  }
  @discardableResult func mutate(_ name: String, _ fields: [String: JSONValue]) async throws
    -> JSONValue
  {
    let current = generation
    let value = try await request("mutation", "aiOrchestrators:\(name)", .object(fields))
    guard generation == current, !Task.isCancelled else { throw CancellationError() }
    return value
  }
  func query(_ name: String, _ fields: [String: JSONValue]) async throws -> JSONValue {
    let current = generation
    let value = try await request("query", "aiOrchestrators:\(name)", .object(fields))
    guard generation == current, !Task.isCancelled else { throw CancellationError() }
    return value
  }
  func allowanceUpdates(companyID: String) -> AsyncThrowingStream<JSONValue, Error> {
    subscribe("providerAllowanceBudgets:list", .object(["companyId": .string(companyID)]))
  }
  @discardableResult func changeAllowance(_ operation: String, _ fields: [String: JSONValue])
    async throws -> JSONValue
  {
    let current = generation
    let value = try await request(
      "mutation", "providerAllowanceBudgets:\(operation)", .object(fields))
    guard generation == current, !Task.isCancelled else { throw CancellationError() }
    return value
  }
}
