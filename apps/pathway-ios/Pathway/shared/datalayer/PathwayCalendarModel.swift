import Foundation
import Observation

/// A company-scoped row from the same permission-filtered replica used by desktop.
struct PathwayCalendarRecord: Identifiable, Equatable {
    let companyID: String
    let kind: String
    var fields: [String: JSONValue]
    var entityID: String { string("id") }
    var id: String { "\(companyID):\(kind):\(entityID)" }
    func string(_ key: String) -> String { fields[key]?.stringValue ?? "" }
    func date(_ key: String) -> Date? {
        if case let .number(value) = fields[key] { return Date(timeIntervalSince1970: value / 1_000) }
        let value = string(key)
        guard !value.isEmpty else { return nil }
        return ISO8601DateFormatter().date(from: value) ?? Self.dateOnly.date(from: value)
    }
    private static let dateOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

struct PathwayCalendarDraft {
    var id = UUID().uuidString.lowercased()
    var calendarID = ""
    var title = ""
    var start = Date()
    var end = Date().addingTimeInterval(3_600)
    var timeZone = TimeZone.current.identifier
    var allDay = false
    var notes = ""
    var location = ""
    var urls = ""
    var invitees = ""
    var reminders: Set<Int> = []
    var existingInvitees: [JSONValue] = []

    init(event: PathwayCalendarRecord? = nil) {
        guard let event else { return }
        id = event.entityID
        calendarID = event.string("calendarId")
        title = event.string("title")
        start = event.date("startAt") ?? start
        end = event.date("endAt") ?? end
        timeZone = event.string("timeZone")
        allDay = event.fields["allDay"]?.boolValue == true
        notes = event.string("notes")
        location = event.string("location")
        urls = (event.fields["urls"]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: "\n")
        existingInvitees = event.fields["invitees"]?.arrayValue ?? []
        invitees = existingInvitees.compactMap { $0.objectValue?["email"]?.stringValue }.joined(separator: ", ")
        reminders = Set((event.fields["reminderMinutes"]?.arrayValue ?? []).compactMap(\.intValue))
    }

    func payload() throws -> [String: JSONValue] {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty, end > start, TimeZone(identifier: timeZone) != nil else {
            throw PathwayIssueWriteError(message: "Enter a title, a valid time zone, and an end after the start.")
        }
        let links = urls.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard links.allSatisfy({ URL(string: $0).map { ["https", "http"].contains($0.scheme ?? "") } ?? false }) else {
            throw PathwayIssueWriteError(message: "Event links must start with https:// or http://.")
        }
        let addresses = invitees.lowercased().split(whereSeparator: { $0 == "," || $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard addresses.allSatisfy({ $0.contains("@") && !$0.contains(" ") }) else {
            throw PathwayIssueWriteError(message: "Enter valid invitee email addresses separated by commas.")
        }
        let people = Array(Set(addresses)).sorted().map { address -> JSONValue in
            existingInvitees.first { $0.objectValue?["email"]?.stringValue?.lowercased() == address }
                ?? .object(["email": .string(address), "name": .null, "response": .string("needs-action")])
        }
        var zoneCalendar = Calendar(identifier: .gregorian)
        zoneCalendar.timeZone = TimeZone(identifier: timeZone) ?? .current
        let actualStart = allDay ? zoneCalendar.startOfDay(for: start) : start
        var actualEnd = allDay ? zoneCalendar.startOfDay(for: end) : end
        if allDay && actualEnd <= actualStart { actualEnd = zoneCalendar.date(byAdding: .day, value: 1, to: actualStart) ?? end }
        return ["title": .string(cleanTitle), "startAt": .number((actualStart.timeIntervalSince1970 * 1_000).rounded()),
                "endAt": .number((actualEnd.timeIntervalSince1970 * 1_000).rounded()), "timeZone": .string(timeZone),
                "allDay": .bool(allDay), "notes": .string(notes),
                "location": location.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string(location.trimmingCharacters(in: .whitespacesAndNewlines)),
                "urls": .array(links.map(JSONValue.string)), "invitees": .array(people),
                "reminderMinutes": .array(reminders.sorted().map { .number(Double($0)) })]
    }
}

@MainActor @Observable
final class PathwayCalendarModel {
    typealias MutateWorkItem = @MainActor (String, String, String, [String: JSONValue]) async throws -> JSONValue
    private(set) var calendars: [PathwayCalendarRecord] = []
    private(set) var events: [PathwayCalendarRecord] = []
    private(set) var work: [PathwayCalendarRecord] = []
    private(set) var members: [PathwayCalendarRecord] = []
    private(set) var teams: [PathwayCalendarRecord] = []
    private(set) var companies: [PathwayCompany] = []
    private(set) var isWriting = false
    var errorMessage: String?
    @ObservationIgnored private let cloudRequest: PathwayIssuesModel.CloudRequest?
    @ObservationIgnored private let mutateWorkItem: MutateWorkItem?
    @ObservationIgnored private var overlays: [String: [String: JSONValue]] = [:]
    @ObservationIgnored private var deleted: Set<String> = []
    @ObservationIgnored private var replicaVersions: [String: Int] = [:]

    init(cloudRequest: PathwayIssuesModel.CloudRequest? = nil, mutateWorkItem: MutateWorkItem? = nil) { self.cloudRequest = cloudRequest; self.mutateWorkItem = mutateWorkItem }

    func replaceReplica(_ changes: [String: [PathwaySyncChange]], companies: [PathwayCompany] = []) {
        let included: Set<String> = ["calendar", "calendarEvent", "issue", "issueMilestone", "issueCycle", "membership", "team"]
        var nextVersions: [String: Int] = [:]
        for (companyID, entries) in changes {
            for change in entries where included.contains(change.entityKind) { nextVersions["\(companyID):\(change.entityKind):\(change.entityId)"] = change.version }
        }
        guard nextVersions != replicaVersions || companies != self.companies else { return }
        replicaVersions = nextVersions
        self.companies = companies
        let rows = changes.flatMap { companyID, entries in
            entries.compactMap { change -> PathwayCalendarRecord? in
                guard included.contains(change.entityKind), change.changeKind != "tombstone", var fields = change.payload?.objectValue else { return nil }
                fields["id"] = fields["id"] ?? .string(change.entityId)
                return .init(companyID: companyID, kind: change.entityKind, fields: fields)
            }
        }
        calendars = rows.filter { $0.kind == "calendar" }.sorted { $0.string("name") < $1.string("name") }
        let readable = Set(calendars.map { "\($0.companyID):\($0.entityID)" })
        let incoming = rows.filter { $0.kind == "calendarEvent" && readable.contains("\($0.companyID):\($0.string("calendarId"))") }
        let identities = Set(incoming.map(\.id))
        overlays = overlays.filter { identities.contains($0.key) }
        deleted.formIntersection(identities)
        events = incoming.compactMap { event in
            guard !deleted.contains(event.id) else { return nil }
            guard let patch = overlays[event.id] else { return event }
            if patch.filter({ !["urls", "invitees"].contains($0.key) }).allSatisfy({ event.fields[$0.key] == $0.value }) { overlays[event.id] = nil; return event }
            var next = event
            next.fields.merge(patch) { _, newer in newer }
            return next
        }.sorted { ($0.date("startAt") ?? .distantPast) < ($1.date("startAt") ?? .distantPast) }
        work = rows.filter { ["issue", "issueMilestone", "issueCycle"].contains($0.kind) && ($0.fields["deletedAt"] == nil || $0.fields["deletedAt"] == .null) }
        members = rows.filter { $0.kind == "membership" }
        teams = rows.filter { $0.kind == "team" }
    }

    func updateWork(_ item: PathwayCalendarRecord, start: Date, end: Date) async throws {
        guard let mutateWorkItem, ["issue", "issueMilestone", "issueCycle"].contains(item.kind) else {
            throw PathwayIssueWriteError(message: "Connect to your workspace to update dated work.")
        }
        guard end >= start else { throw PathwayIssueWriteError(message: "The end date must not precede the start date.") }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        let patch: [String: JSONValue] = item.kind == "issue" ? ["dueDate": .string(formatter.string(from: end))] : ["startDate": .string(formatter.string(from: start)), item.kind == "issueMilestone" ? "targetDate" : "endDate": .string(formatter.string(from: end))]
        _ = try await mutateWorkItem(item.companyID, item.kind + ".update", item.entityID, patch)
    }

    func canEdit(_ calendar: PathwayCalendarRecord) -> Bool {
        calendar.string("kind") == "pathway" && companies.first { $0.id == calendar.companyID }?.membershipId == calendar.string("ownerMembershipId")
    }
    func canEditEvent(_ event: PathwayCalendarRecord) -> Bool {
        calendars.first { $0.companyID == event.companyID && $0.entityID == event.string("calendarId") }.map(canEdit) ?? false
    }
    func request(_ name: String, companyID: String, fields: [String: JSONValue] = [:], kind: String = "mutation") async throws -> JSONValue {
        guard let cloudRequest else { throw PathwayIssueWriteError(message: "Connect to your workspace to use Calendar.") }
        var args = fields; args["companyId"] = .string(companyID)
        return try await cloudRequest(kind, "calendars:\(name)", .object(args))
    }
    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !isWriting else { return false }
        isWriting = true; errorMessage = nil
        defer { isWriting = false }
        do { try await operation(); return true } catch { errorMessage = error.localizedDescription; return false }
    }
    func save(_ draft: PathwayCalendarDraft, companyID: String, existing: PathwayCalendarRecord?) async throws {
        guard calendars.contains(where: { $0.companyID == companyID && $0.entityID == draft.calendarID && canEdit($0) }) else {
            throw PathwayIssueWriteError(message: "Choose a calendar you own to save this event.")
        }
        var fields = try draft.payload()
        if let existing {
            fields["eventId"] = .string(existing.entityID)
            _ = try await request("updateEvent", companyID: companyID, fields: fields)
            fields["eventId"] = nil
            overlays[existing.id] = fields
            if let index = events.firstIndex(where: { $0.id == existing.id }) { events[index].fields.merge(fields) { _, new in new } }
        } else {
            fields["id"] = .string(draft.id); fields["calendarId"] = .string(draft.calendarID)
            _ = try await request("createEvent", companyID: companyID, fields: fields)
        }
    }
    func delete(_ event: PathwayCalendarRecord) async throws {
        _ = try await request("deleteEvent", companyID: event.companyID, fields: ["eventId": .string(event.entityID)])
        deleted.insert(event.id); events.removeAll { $0.id == event.id }
    }
    func attachmentURL(_ event: PathwayCalendarRecord, id: String) async throws -> URL {
        let result = try await request("eventAttachmentUrl", companyID: event.companyID, fields: ["eventId": .string(event.entityID), "attachmentId": .string(id)], kind: "query")
        guard let value = result.stringValue, let url = URL(string: value), url.scheme == "https" else {
            throw PathwayIssueWriteError(message: "This attachment is unavailable.")
        }
        return url
    }
    func upload(_ event: PathwayCalendarRecord, url: URL, mimeType: String) async throws {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes <= 25 * 1024 * 1024 else { throw PathwayIssueWriteError(message: "Attachments must be no larger than 25 MB.") }
        guard (event.fields["attachments"]?.arrayValue?.count ?? 0) < 8 else { throw PathwayIssueWriteError(message: "An event can have up to eight attachments.") }
        let id = UUID().uuidString.lowercased()
        let base: [String: JSONValue] = ["eventId": .string(event.entityID), "id": .string(id)]
        let prepared = try await request("prepareEventAttachmentUpload", companyID: event.companyID, fields: base)
        var storageID: String?
        do {
            guard let value = prepared.stringValue, let target = URL(string: value), target.scheme == "https" else {
                throw PathwayIssueWriteError(message: "The attachment upload could not be prepared.")
            }
            var upload = URLRequest(url: target)
            upload.httpMethod = "POST"; upload.setValue(mimeType, forHTTPHeaderField: "Content-Type")
            let (data, response) = try await URLSession.shared.upload(for: upload, fromFile: url)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                  let decoded = try JSONDecoder().decode(JSONValue.self, from: data).objectValue,
                  let uploaded = decoded["storageId"]?.stringValue else {
                throw PathwayIssueWriteError(message: "The attachment upload failed.")
            }
            storageID = uploaded
            var fields = base
            fields["storageId"] = .string(uploaded); fields["fileName"] = .string(url.lastPathComponent)
            fields["mimeType"] = .string(mimeType); fields["byteSize"] = .number(Double(bytes))
            _ = try await request("attachEventFile", companyID: event.companyID, fields: fields)
        } catch {
            var cleanup: [String: JSONValue] = ["eventId": .string(event.entityID), "attachmentId": .string(id)]
            if let storageID { cleanup["storageId"] = .string(storageID) }
            _ = try? await request("discardEventAttachmentUpload", companyID: event.companyID, fields: cleanup)
            throw error
        }
    }
}
