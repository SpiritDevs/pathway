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
    var source: String? = nil
    var start: Date { pathwayDate(from: startedAt) ?? .now }
}
private struct PathwayTimeSnapshot: Decodable {
    let active: PathwayTrackedSession?
    let entries: [PathwayTrackedSession]
    let cursor: String?
    let isDone: Bool?
}
struct PathwayActiveTrackedSession: Decodable, Identifiable, Equatable {
    let id: String
    let description: String
    let projectKey: String
    let projectName: String
    let startedAt: String
    let durationMs: Double
    let source: String
    let state: String
    let runningSince: Double?
    let observedAt: Double?

    func duration(at date: Date) -> Double {
        guard state == "running" else { return durationMs }
        let start = runningSince ?? (pathwayDate(from: startedAt)?.timeIntervalSince1970 ?? 0) * 1_000
        let now = date.timeIntervalSince1970 * 1_000
        let end = source == "agent" ? min(now, (observedAt ?? start) + 90_000) : now
        return durationMs + max(0, end - start)
    }

    func status(at date: Date) -> String {
        if state == "paused" { return "Paused · waiting for input" }
        if source == "agent", let observedAt, date.timeIntervalSince1970 * 1_000 > observedAt + 90_000 { return "Waiting for connection" }
        return source == "agent" ? "Agent working" : "Manual timer"
    }
}
private struct PathwayActiveTimeSnapshot: Decodable {
    let sessions: [PathwayActiveTrackedSession]
    let complete: Bool
}
struct PathwayTimeTotals: Decodable {
    let workMs: Double
    let elapsedMs: Double
    let manualMs: Double
    let agentMs: Double
    let issueMs: Double
}
struct PathwayTimeProjectTotal: Decodable, Identifiable {
    let projectKey: String
    let projectName: String
    let workMs: Double
    let elapsedMs: Double
    var id: String { projectKey }
}
struct PathwayTimeDayTotal: Decodable, Identifiable {
    let date: String
    let workMs: Double
    let agentMs: Double
    let manualMs: Double
    let issueMs: Double
    var id: String { date }
}
struct PathwayTimeOverview: Decodable {
    let complete: Bool
    let totals: PathwayTimeTotals
    let projects: [PathwayTimeProjectTotal]
    let days: [PathwayTimeDayTotal]
}

@MainActor @Observable
final class PathwayTimeModel {
    private(set) var active: PathwayTrackedSession?
    private(set) var entries: [PathwayTrackedSession] = []
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var hasMore = false
    private(set) var totals: PathwayTimeOverview?
    private(set) var activeSessions: [PathwayActiveTrackedSession] = []
    private(set) var activeSessionsComplete = true
    private(set) var activeSessionsError: String?
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
    @ObservationIgnored private let currentDate: () -> Date
    @ObservationIgnored private var accountID = ""
    @ObservationIgnored private var pending: JSONValue?
    init(request: @escaping PathwayIssuesModel.CloudRequest, subscribe: @escaping PathwayContactsModel.Subscribe, defaults: UserDefaults = .standard, currentDate: @escaping () -> Date = { .now }) { self.request = request; self.subscribe = subscribe; self.defaults = defaults; self.currentDate = currentDate }
    func clear() {
        observationGeneration += 1; pageGeneration += 1; cursor = nil; since = nil; hasMore = false; loadingMore = false; totals = nil; totalsError = nil; activeSessions = []; activeSessionsComplete = true; activeSessionsError = nil; accountID = ""; active = nil; entries = []; loading = false; writing = false; pending = nil; hasPendingCommand = false; errorMessage = nil
    }
    func observe(accountID: String, since: Date? = nil) async {
        observationGeneration += 1; let generation = observationGeneration
        self.accountID = accountID; self.since = since; active = nil; entries = []; errorMessage = nil
        pageGeneration += 1; cursor = nil; hasMore = false; loadingMore = false; totals = nil; totalsError = nil; activeSessions = []; activeSessionsComplete = true; activeSessionsError = nil; loading = false
        guard !accountID.isEmpty else { hasPendingCommand = false; pending = nil; return }
        let stored = defaults.data(forKey: storageKey)
        pending = stored.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        hasPendingCommand = stored != nil
        if stored != nil && pending == nil { errorMessage = "The pending timer change could not be read. Its data has been preserved; discard it explicitly before starting another timer." }
        loading = true
        let totalsTask = Task { await self.observeTotals(accountID: accountID, generation: generation) }
        let activeTask = Task { await self.observeActive(accountID: accountID, generation: generation) }
        defer { totalsTask.cancel(); activeTask.cancel() }
        do {
            for try await value in subscribe("timeTracking:listMine", historyArguments()) {
                guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
                let snapshot = try decodePathwayPayload(PathwayTimeSnapshot.self, from: value)
                active = snapshot.active; entries = snapshot.entries; loading = false
                pageGeneration += 1; loadingMore = false; cursor = snapshot.cursor; hasMore = snapshot.isDone == false
            }
        } catch {
            guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
            active = nil; activeSessions = []; totals = nil; entries = []; loading = false; loadingMore = false; cursor = nil; hasMore = false; pageGeneration += 1; errorMessage = error.localizedDescription
        }
    }
    private func historyArguments(cursor: String? = nil) -> JSONValue {
        var args: [String: JSONValue] = [:]
        if let since { args["since"] = .string(since.ISO8601Format()) }
        if let cursor { args["cursor"] = .string(cursor) }
        return .object(args)
    }
    private func overviewArguments(refresh: Bool = false) -> JSONValue {
        var calendar = Calendar.current; calendar.firstWeekday = 2
        let now = currentDate()
        let today = calendar.startOfDay(for: now)
        let start = since ?? calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? today
        // The live subscription covers the day. Refreshes use a new cutoff so Convex
        // cannot return the cached day query while only a manual timer is changing.
        let requestedEnd = refresh ? now : calendar.date(byAdding: .day, value: 1, to: today) ?? now
        let end = max(requestedEnd, start.addingTimeInterval(1))
        var days: [JSONValue] = []
        var day = calendar.startOfDay(for: start)
        while day < end {
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            let parts = calendar.dateComponents([.year, .month, .day], from: day)
            let label = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
            days.append(.object(["date": .string(label), "start": .number(day.timeIntervalSince1970 * 1_000), "end": .number(next.timeIntervalSince1970 * 1_000)]))
            day = next
        }
        return .object(["since": .string(start.ISO8601Format()), "until": .string(end.ISO8601Format()), "timezoneOffsetMinutes": .number(Double(-TimeZone.current.secondsFromGMT(for: now)) / 60), "dayBoundaries": .array(days)])
    }
    private func observeTotals(accountID: String, generation: Int) async {
        do {
            for try await value in subscribe("timeTracking:overview", overviewArguments()) {
                guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
                totals = try decodePathwayPayload(PathwayTimeOverview.self, from: value)
                totalsError = nil
            }
        } catch {
            guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
            totals = nil; totalsError = error.localizedDescription
        }
    }
    private func observeActive(accountID: String, generation: Int) async {
        do {
            for try await value in subscribe("timeTracking:listActive", .object([:])) {
                guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
                let snapshot = try decodePathwayPayload(PathwayActiveTimeSnapshot.self, from: value)
                activeSessions = snapshot.sessions; activeSessionsComplete = snapshot.complete; activeSessionsError = nil
            }
        } catch {
            guard !Task.isCancelled, self.accountID == accountID, generation == observationGeneration else { return }
            activeSessions = []; activeSessionsError = error.localizedDescription
        }
    }
    func refreshAnalytics() async {
        guard !accountID.isEmpty else { return }
        let generation = observationGeneration
        do {
            let value = try await request("query", "timeTracking:overview", overviewArguments(refresh: true))
            guard !Task.isCancelled, generation == observationGeneration else { return }
            totals = try decodePathwayPayload(PathwayTimeOverview.self, from: value); totalsError = nil
        } catch {
            guard !Task.isCancelled, generation == observationGeneration else { return }
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
    func start(description: String, project: PathwayCompanyProject?) async throws {
        try await start(description: description, projectKey: project?.project.id ?? "", projectName: project?.project.name ?? "No project")
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
