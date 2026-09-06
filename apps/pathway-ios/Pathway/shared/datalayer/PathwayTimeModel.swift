import Foundation
import Observation

struct PathwayTrackedSession: Codable, Identifiable, Equatable {
    let id: String
    let description: String
    let projectKey: String
    let projectName: String
    let startedAt: String
    let stoppedAt: String?
    let durationMs: Double
    var start: Date { pathwayDate(from: startedAt) ?? .now }
}
private struct PathwayTimeSnapshot: Decodable {
    let active: PathwayTrackedSession?
    let entries: [PathwayTrackedSession]
    let cursor: String?
    let isDone: Bool?
}
struct PathwayRecentTimeTotals: Decodable {
    let todayClippedMs: Double
    let weekClippedMs: Double
    let complete: Bool
}

@MainActor @Observable
final class PathwayTimeModel {
    private(set) var active: PathwayTrackedSession?
    private(set) var entries: [PathwayTrackedSession] = []
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var hasMore = false
    private(set) var totals: PathwayRecentTimeTotals?
    private(set) var totalsError: String?
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var since: Date?
    @ObservationIgnored private var pageGeneration = 0
    private(set) var writing = false
    private(set) var hasPendingCommand = false
    var errorMessage: String?
    @ObservationIgnored private var observationGeneration = 0
    @ObservationIgnored private let request: PathwayIssuesModel.CloudRequest
    @ObservationIgnored private let subscribe: PathwayContactsModel.Subscribe
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var accountID = ""
    @ObservationIgnored private var pending: JSONValue?
    init(request: @escaping PathwayIssuesModel.CloudRequest, subscribe: @escaping PathwayContactsModel.Subscribe, defaults: UserDefaults = .standard) { self.request = request; self.subscribe = subscribe; self.defaults = defaults }
    func clear() {
        observationGeneration += 1; pageGeneration += 1; cursor = nil; since = nil; hasMore = false; loadingMore = false; totals = nil; totalsError = nil; accountID = ""; active = nil; entries = []; loading = false; writing = false; pending = nil; hasPendingCommand = false; errorMessage = nil
    }
    func observe(accountID: String, since: Date? = nil) async {
        observationGeneration += 1; let generation = observationGeneration
        self.accountID = accountID; self.since = since; active = nil; entries = []; errorMessage = nil
        pageGeneration += 1; cursor = nil; hasMore = false; loadingMore = false; totals = nil; totalsError = nil; loading = false
        guard !accountID.isEmpty else { hasPendingCommand = false; pending = nil; return }
        let stored = defaults.data(forKey: storageKey)
        pending = stored.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        hasPendingCommand = stored != nil
        if stored != nil && pending == nil { errorMessage = "The pending timer change could not be read. Its data has been preserved; discard it explicitly before starting another timer." }
        loading = true
        let totalsTask = Task { await self.observeTotals(accountID: accountID, generation: generation) }
        defer { totalsTask.cancel() }
        do {
            for try await value in subscribe("timeTracking:listMine", historyArguments()) {
                guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
                let snapshot = try decodePathwayPayload(PathwayTimeSnapshot.self, from: value)
                active = snapshot.active; entries = snapshot.entries; loading = false
                pageGeneration += 1; loadingMore = false; cursor = snapshot.cursor; hasMore = snapshot.isDone == false
            }
        } catch {
            guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
            active = nil; entries = []; loading = false; loadingMore = false; cursor = nil; hasMore = false; pageGeneration += 1; errorMessage = error.localizedDescription
        }
    }
    private func historyArguments(cursor: String? = nil) -> JSONValue {
        var args: [String: JSONValue] = [:]
        if let since { args["since"] = .string(since.ISO8601Format()) }
        if let cursor { args["cursor"] = .string(cursor) }
        return .object(args)
    }
    private func observeTotals(accountID: String, generation: Int) async {
        var calendar = Calendar.current; calendar.firstWeekday = 2
        let now = Date.now
        let today = calendar.startOfDay(for: now)
        let week = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? today
        do {
            for try await value in subscribe("timeTracking:recentTotals", .object(["todayStart": .string(today.ISO8601Format()), "weekStart": .string(week.ISO8601Format())])) {
                guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
                totals = try decodePathwayPayload(PathwayRecentTimeTotals.self, from: value)
                totalsError = nil
            }
        } catch {
            guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
            totals = nil; totalsError = error.localizedDescription
        }
    }
    func loadMore() async throws {
        guard !loadingMore, hasMore, let cursor, !accountID.isEmpty else { return }
        let generation = observationGeneration, page = pageGeneration
        loadingMore = true
        defer { if generation == observationGeneration, page == pageGeneration { loadingMore = false } }
        let value: JSONValue
        do { value = try await request("query", "timeTracking:listMine", historyArguments(cursor: cursor)) }
        catch {
            guard !Task.isCancelled, generation == observationGeneration, page == pageGeneration else { return }
            throw error
        }
        guard !Task.isCancelled, generation == observationGeneration, page == pageGeneration else { return }
        let snapshot = try decodePathwayPayload(PathwayTimeSnapshot.self, from: value)
        let existing = Set(entries.map(\.id))
        entries += snapshot.entries.filter { !existing.contains($0.id) }
        self.cursor = snapshot.cursor; hasMore = snapshot.isDone == false
    }
    func start(description: String, projectKey: String, projectName: String) async throws {
        guard active == nil else { throw PathwayIssueWriteError(message: "Stop the running timer first.") }
        try await enqueue(name: "start", fields: ["id": .string(UUID().uuidString.lowercased()), "description": .string(description), "projectKey": .string(projectKey), "projectName": .string(projectName)])
    }
    func stop(_ session: PathwayTrackedSession) async throws { try await enqueue(name: "stop", fields: ["id": .string(session.id)]) }
    func remove(_ session: PathwayTrackedSession) async throws {
        let generation = observationGeneration
        _ = try await request("mutation", "timeTracking:remove", .object(["id": .string(session.id)]))
        guard generation == observationGeneration else { return }
        entries.removeAll { $0.id == session.id }
    }
    private var storageKey: String { "pathway.time.pending.\(accountID)" }
    private func enqueue(name: String, fields: [String: JSONValue]) async throws {
        guard !accountID.isEmpty else { throw PathwayIssueWriteError(message: "Sign in to track time.") }
        guard !hasPendingCommand else { throw PathwayIssueWriteError(message: "Retry or discard the pending timer command before another change.") }
        let command = JSONValue.object(["name": .string(name), "fields": .object(fields)])
        defaults.set(try JSONEncoder().encode(command), forKey: storageKey)
        pending = command; hasPendingCommand = true
        try await retryPending()
    }
    func retryPending() async throws {
        guard hasPendingCommand else { return }
        guard let command = pending?.objectValue, let name = command["name"]?.stringValue, ["start", "stop"].contains(name), let fields = command["fields"], let id = fields.objectValue?["id"]?.stringValue, !id.isEmpty else {
            throw PathwayIssueWriteError(message: "This saved timer command is invalid. Its data has been preserved; discard it explicitly to continue.")
        }
        let account = accountID; let key = storageKey; let submitted = pending
        _ = try await request("mutation", "timeTracking:\(name)", fields)
        if defaults.data(forKey: key).flatMap({ try? JSONDecoder().decode(JSONValue.self, from: $0) }) == submitted { defaults.removeObject(forKey: key) }
        guard accountID == account, pending == submitted else { return }
        pending = nil; hasPendingCommand = false
    }
    func discardPending() { defaults.removeObject(forKey: storageKey); pending = nil; hasPendingCommand = false }
    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !writing else { return false }
        writing = true; errorMessage = nil
        defer { writing = false }
        do { try await operation(); return true } catch { errorMessage = error.localizedDescription; return false }
    }
}
