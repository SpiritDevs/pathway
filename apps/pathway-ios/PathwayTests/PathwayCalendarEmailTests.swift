import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayCalendarEmailTests {
    private let company = PathwayCompany(id: "company", membershipId: "owner", name: "Company", workspaceKind: "company", issueKeyPrefix: "P", lifecycleState: "active", syncVersion: 1, isOwner: true)
    private func change(_ kind: String, _ id: String, _ fields: [String: JSONValue], version: Int = 1) -> PathwaySyncChange {
        .init(version: version, entityKind: kind, entityId: id, changeKind: "upsert", payload: .object(fields.merging(["id": .string(id)]) { _, new in new }))
    }
    private var calendar: PathwaySyncChange { change("calendar", "calendar", ["name": .string("Work"), "kind": .string("pathway"), "ownerMembershipId": .string("owner")]) }
    private var event: PathwaySyncChange { change("calendarEvent", "event", ["calendarId": .string("calendar"), "title": .string("Meeting"), "startAt": .number(1_800_000_000_000), "endAt": .number(1_800_003_600_000), "timeZone": .string("Australia/Sydney")]) }
    private func email(environment: String) -> PathwaySyncChange {
        change("capturedEmail", "\(environment):same", ["environmentId": .string(environment), "message": .object(["id": .string("same"), "isRead": .bool(false), "parsedHeaders": .object(["subject": .string("Mail")])]), "tagIds": .array([])])
    }

    @Test func revocationRemovesEventsEvenIfTheirRowsRemainInReplica() {
        let model = PathwayCalendarModel()
        model.replaceReplica(["company": [calendar, event]], companies: [company])
        #expect(model.events.count == 1)
        #expect(model.canEditEvent(model.events[0]))
        model.replaceReplica(["company": [event]], companies: [company])
        #expect(model.events.isEmpty)
    }
    @Test func mirroredAndOtherOwnedCalendarsStayReadOnly() {
        let model = PathwayCalendarModel()
        model.replaceReplica(["company": [change("calendar", "calendar", ["kind": .string("google"), "ownerMembershipId": .string("owner")]), event]], companies: [company])
        #expect(!model.canEditEvent(model.events[0]))
        model.replaceReplica(["company": [change("calendar", "calendar", ["kind": .string("pathway"), "ownerMembershipId": .string("other")], version: 2), event]], companies: [company])
        #expect(!model.canEditEvent(model.events[0]))
    }
    @Test func calendarValidationEmitsIntegerMillisecondsAndKeepsInviteeResponses() throws {
        var draft = PathwayCalendarDraft()
        draft.title = "  Review  "
        draft.start = Date(timeIntervalSince1970: 1_800_000_000.123456)
        draft.end = draft.start.addingTimeInterval(3600)
        draft.invitees = "person@example.com"
        draft.existingInvitees = [.object(["email": .string("person@example.com"), "name": .string("Person"), "response": .string("accepted")])]
        let payload = try draft.payload()
        #expect(payload["startAt"]?.intValue == 1_800_000_000_123)
        #expect(payload["title"] == .string("Review"))
        #expect(payload["invitees"]?.arrayValue?.first?.objectValue?["response"] == .string("accepted"))
        draft.end = draft.start
        #expect(throws: PathwayIssueWriteError.self) { try draft.payload() }
    }
    @Test func deniedCalendarWritePreservesReplicaAndUsesRealMutation() async throws {
        var function = ""
        let model = PathwayCalendarModel(cloudRequest: { _, name, _ in function = name; throw URLError(.notConnectedToInternet) })
        model.replaceReplica(["company": [calendar, event]], companies: [company])
        var draft = PathwayCalendarDraft(event: model.events[0]); draft.title = "Changed"
        do { try await model.save(draft, companyID: "company", existing: model.events[0]); Issue.record("Expected failure") } catch { }
        #expect(function == "calendars:updateEvent")
        #expect(model.events[0].string("title") == "Meeting")
    }
    @Test func emailWritesRouteByExactSourceAndFailedWritesDoNotLie() async throws {
        var source = ""
        var payload: JSONValue?
        let model = PathwayEmailModel(environmentRequest: { _, environment, _, args in
            source = environment; payload = args
            if environment == "offline" { throw URLError(.notConnectedToInternet) }
            return .null
        })
        model.replaceReplica(["company": [email(environment: "online"), email(environment: "offline")]])
        let online = model.messages.first { $0.environmentID == "online" }!
        let offline = model.messages.first { $0.environmentID == "offline" }!
        try await model.mark([online], read: true)
        #expect(source == "online")
        #expect(payload?.objectValue?["target"]?.objectValue?["messageId"] == .string("same"))
        do { try await model.mark([offline], read: true); Issue.record("Expected failure") } catch { }
        #expect(model.messages.first { $0.environmentID == "online" }?.isRead == true)
        #expect(model.messages.first { $0.environmentID == "offline" }?.isRead == false)
        model.replaceReplica([:])
        #expect(model.messages.isEmpty)
    }
    @Test func workDatesUseDateOnlyContracts() async throws {
        var received: [String: JSONValue] = [:]
        var kind = ""
        let model = PathwayCalendarModel(mutateWorkItem: { _, operation, _, fields in received = fields; kind = operation; return .null })
        let item = PathwayCalendarRecord(companyID: "company", kind: "issueMilestone", fields: ["id": .string("milestone")])
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        try await model.updateWork(item, start: date, end: date)
        #expect(kind == "issueMilestone.update")
        #expect(received["startDate"]?.stringValue?.count == 10)
        #expect(received["targetDate"] == received["startDate"])
        #expect(received["endDate"] == nil)
    }
}
