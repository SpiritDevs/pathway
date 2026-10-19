import Foundation
@testable import Pathway
import Testing

struct PathwayTimeAnalyticsTests {
    @Test func agentClockExcludesPausesAndExpiresWithoutAHeartbeat() throws {
        let running = PathwayActiveTrackedSession(id: "agent", description: "Work", projectKey: "project", projectName: "Pathway", startedAt: "2026-09-08T00:00:00Z", durationMs: 120_000, source: "agent", state: "running", runningSince: 1_000, observedAt: 20_000)
        #expect(running.duration(at: Date(timeIntervalSince1970: 31)) == 150_000)
        #expect(running.duration(at: Date(timeIntervalSince1970: 999)) == 229_000)
        #expect(running.status(at: Date(timeIntervalSince1970: 999)) == "Waiting for connection")
        let paused = PathwayActiveTrackedSession(id: "agent", description: "Work", projectKey: "project", projectName: "Pathway", startedAt: "2026-09-08T00:00:00Z", durationMs: 120_000, source: "agent", state: "paused", runningSince: nil, observedAt: 20_000)
        #expect(paused.duration(at: Date(timeIntervalSince1970: 999)) == 120_000)
    }

    @Test func sourceIsOptionalForHistoryFromOlderServers() throws {
        let old: JSONValue = .object(["id": .string("manual"), "description": .string("Work"), "projectKey": .string(""), "projectName": .string("No project"), "startedAt": .string("2026-09-08T00:00:00Z"), "stoppedAt": .string("2026-09-08T02:00:00Z"), "durationMs": .number(3_600_000)])
        let session = try decodePathwayPayload(PathwayTrackedSession.self, from: old)
        #expect(session.source == nil)
        #expect(session.durationMs == 3_600_000)
        var enriched = old.objectValue!
        enriched["source"] = .string("agent")
        let agent = try decodePathwayPayload(PathwayTrackedSession.self, from: .object(enriched))
        #expect(agent.source == "agent")
        #expect(agent.durationMs == 3_600_000)
    }

    @Test func concurrentWorkAndElapsedActivityRemainSeparate() throws {
        let raw: JSONValue = .object(["complete": .bool(true), "totals": .object(["workMs": .number(14_400_000), "elapsedMs": .number(1_800_000), "manualMs": .number(0), "agentMs": .number(14_400_000), "issueMs": .number(0)]), "projects": .array([]), "days": .array([])])
        let overview = try decodePathwayPayload(PathwayTimeOverview.self, from: raw)
        #expect(overview.totals.workMs == 14_400_000)
        #expect(overview.totals.elapsedMs == 1_800_000)
        #expect(overview.totals.agentMs == 14_400_000)
    }

    @MainActor @Test func manualStartUsesTheCanonicalProjectKeyWhileHistoryKeepsItsOriginalKey() async throws {
        let project = PathwayCompanyProject(companyId: "company", project: PathwayCloudProject(id: "project", name: "Pathway", description: "", archivedAt: nil))
        #expect(project.id == "company:project")
        let legacy: JSONValue = .object(["id": .string("legacy"), "description": .string("Previous work"), "projectKey": .string(project.id), "projectName": .string("Pathway"), "startedAt": .string("2026-09-08T00:00:00Z"), "stoppedAt": .string("2026-09-08T01:00:00Z"), "durationMs": .number(3_600_000)])
        var commands: [JSONValue] = []
        let model = PathwayTimeModel(request: { kind, name, args in
            #expect(kind == "mutation")
            #expect(name == "timeTracking:start")
            commands.append(args)
            return .null
        }, subscribe: { name, _ in AsyncThrowingStream {
            if name == "timeTracking:listMine" { $0.yield(.object(["active": .null, "entries": .array([legacy])])) }
            $0.finish()
        } }, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        await model.observe(accountID: "account")
        try await model.start(description: "New work", project: project)
        #expect(commands.first?.objectValue?["projectKey"] == .string("project"))
        #expect(commands.first?.objectValue?["projectName"] == .string("Pathway"))
        #expect(model.entries.first?.projectKey == "company:project")
    }

    @MainActor @Test func minuteRefreshUsesNewCutoffsAndKeepsTheCurrentLocalWeek() async throws {
        var now = Date(timeIntervalSince1970: 1_791_075_615)
        var calls: [JSONValue] = []
        let (overviewSubscriptions, signal) = AsyncStream<JSONValue>.makeStream()
        var history: AsyncThrowingStream<JSONValue, Error>.Continuation?
        let totals: JSONValue = .object(["complete": .bool(true), "totals": .object(["workMs": .number(0), "elapsedMs": .number(0), "manualMs": .number(0), "agentMs": .number(0), "issueMs": .number(0)]), "projects": .array([]), "days": .array([])])
        let model = PathwayTimeModel(request: { kind, name, args in
            #expect(kind == "query")
            #expect(name == "timeTracking:overview")
            calls.append(args)
            return totals
        }, subscribe: { name, args in AsyncThrowingStream { continuation in
            switch name {
            case "timeTracking:listMine":
                history = continuation
                continuation.yield(.object(["active": .null, "entries": .array([])]))
            case "timeTracking:overview":
                signal.yield(args)
                continuation.yield(totals)
                continuation.finish()
            default:
                continuation.finish()
            }
        } }, defaults: UserDefaults(suiteName: UUID().uuidString)!, currentDate: { now })
        let observation = Task { await model.observe(accountID: "account") }
        var subscribed: JSONValue?
        for await args in overviewSubscriptions { subscribed = args; break }
        await model.refreshAnalytics()
        let firstNow = now
        now = now.addingTimeInterval(65)
        await model.refreshAnalytics()
        history?.finish()
        await observation.value

        let first = try #require(calls.first?.objectValue)
        let second = try #require(calls.last?.objectValue)
        #expect(calls.count == 2)
        #expect(first["until"] == .string(firstNow.ISO8601Format()))
        #expect(second["until"] == .string(now.ISO8601Format()))
        #expect(first["until"] != second["until"])
        #expect(first["until"] != subscribed?.objectValue?["until"])
        #expect(first["since"] == second["since"])

        let start = try #require(first["since"]?.stringValue.flatMap(pathwayDate))
        var calendar = Calendar.current; calendar.firstWeekday = 2
        #expect(calendar.component(.weekday, from: start) == 2)
        #expect(start == calendar.startOfDay(for: start))
        #expect(start <= firstNow && firstNow.timeIntervalSince(start) < 7 * 86_400)
        let days = try #require(second["dayBoundaries"]?.arrayValue)
        #expect(!days.isEmpty)
        for day in days {
            let fields = try #require(day.objectValue)
            guard case let .number(startMs) = fields["start"], case let .number(endMs) = fields["end"] else { Issue.record("Missing local day boundaries"); continue }
            let dayStart = Date(timeIntervalSince1970: startMs / 1_000)
            let dayEnd = Date(timeIntervalSince1970: endMs / 1_000)
            #expect(dayStart == calendar.startOfDay(for: dayStart))
            #expect(dayEnd == calendar.date(byAdding: .day, value: 1, to: dayStart))
        }
    }

}
