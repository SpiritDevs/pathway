#if DEBUG && !os(visionOS)
import SwiftUI
/// Exercises the production shell and domain models without an account, network or live data.
/// Unsupported requests fail explicitly. Mutations update the same replica rendered by the app.
struct PathwayParitySimulatorScene: View {
    @State private var workspace = PathwayParitySimulatorWorkspace()

    var body: some View {
        MainTabView(initialDestination: ProcessInfo.processInfo.arguments.contains("--parity-email") ? .email : .calendar)
            .environment(workspace.appModel)
            .preferredColorScheme(.light)
    }
}

@MainActor private final class PathwayParitySimulatorWorkspace {
    let appModel = PathwayAppModel(authProvider: PathwayParitySimulatorAuth())
    private let company = PathwayCompany(id: "parity-company", membershipId: "parity-member", name: "Parity workspace",
        workspaceKind: "company", issueKeyPrefix: "PW", lifecycleState: "active", syncVersion: 1, isOwner: true)
    private var changes: [PathwaySyncChange] = []
    private var version = 1
    private var settings: [String: JSONValue] = [
        "listener": .object(["enabled": .bool(true), "bindAddress": .string("127.0.0.1"), "port": .number(1025)]),
        "retention": .object(["maxMessages": .number(500), "maxAgeDays": .number(7)]),
        "toastsEnabled": .bool(true),
        "projects": .array([.object(["projectId": .string("local-project"), "mailSlug": .string("parity-project"),
            "toastMuted": .bool(false), "capturePassword": .null, "twoFactorCodeRegex": .null,
            "retention": .object(["maxMessages": .null, "maxAgeDays": .null])])])
    ]

    init() {
        UserDefaults.standard.removeObject(forKey: "pathway.calendar.layers.parity-company.parity-member")
        appModel.cloud.calendar = PathwayCalendarModel(cloudRequest: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try cloud(kind: kind, name: name, arguments: arguments)
        }, mutateWorkItem: { [weak self] companyID, kind, id, fields in
            guard let self else { throw CancellationError() }
            guard companyID == company.id, ["issue.update", "issueMilestone.update", "issueCycle.update"].contains(kind),
                  let entityKind = kind.split(separator: ".").first else { throw unsupported(kind) }
            try update(String(entityKind), id, fields)
            publish()
            return .null
        })
        appModel.cloud.email = PathwayEmailModel(cloudRequest: { [weak self] kind, name, arguments in
            guard let self else { throw CancellationError() }
            return try cloud(kind: kind, name: name, arguments: arguments)
        }, environmentRequest: { [weak self] companyID, environmentID, method, payload in
            guard let self else { throw CancellationError() }
            guard companyID == company.id else { throw unsupported("workspace \(companyID)") }
            return try environment(environmentID, method: method, payload: payload)
        })
        seed()
        publish()
    }

    private func seed() {
        let day = Calendar.current.startOfDay(for: Date())
        let start = Calendar.current.date(byAdding: .hour, value: 10, to: day) ?? day
        put("membership", "parity-member", ["displayNameSnapshot": .string("Parity owner"), "state": .string("active")])
        put("cloudProject", "parity-project", ["name": .string("Parity project"), "description": .string("Calendar and email validation"), "archivedAt": .null])
        for (id, label) in [("online", "Parity server"), ("offline", "Offline server")] {
            put("environmentRegistration", id, ["environmentId": .string(id),
                "descriptor": .object(["environmentId": .string(id), "label": .string(label), "serverVersion": .string("fixture")]),
                "relayLinkState": .string("linked"), "managedEndpointAvailable": .bool(id == "online"),
                "state": .string("active"), "lastSeenAt": .number(Date().timeIntervalSince1970 * 1000)])
        }
        put("environmentBinding", "parity-binding", ["cloudProjectId": .string("parity-project"), "environmentId": .string("online"),
            "localProjectId": .string("local-project"), "localWorkspaceRoot": .string("/fixture/parity"), "status": .string("active"), "lastSeenAt": .null])
        for (id, name, kind, owner) in [("owned", "My calendar", "pathway", "parity-member"), ("mirrored", "Mirrored calendar", "google", "parity-member")] {
            put("calendar", id, ["name": .string(name), "kind": .string(kind), "ownerMembershipId": .string(owner), "sharing": .string("private")])
        }
        for (id, title, calendarID, offset) in [("planning", "Planning review", "owned", 0.0), ("mirror", "Mirrored appointment", "mirrored", 7200.0)] {
            put("calendarEvent", id, ["calendarId": .string(calendarID), "title": .string(title),
                "startAt": .number(start.addingTimeInterval(offset).timeIntervalSince1970 * 1000),
                "endAt": .number(start.addingTimeInterval(offset + 3600).timeIntervalSince1970 * 1000),
                "timeZone": .string(TimeZone.current.identifier), "allDay": .bool(false), "location": .string("Meeting room"),
                "notes": .string("Fixture event"), "urls": .array([]), "invitees": .array([]), "reminders": .array([]), "attachments": .array([])])
        }
        put("emailTag", "important", ["name": .string("Important"), "color": .string("#3b82f6")])
        for source in ["online", "offline"] {
            put("capturedEmail", "\(source):same", ["environmentId": .string(source), "tagIds": .array([]), "message": .object([
                "id": .string("same"), "isRead": .bool(false),
                "parsedHeaders": .object(["subject": .string(source == "online" ? "Release checklist" : "Offline delivery"),
                    "from": .array([.object(["address": .string("sender@example.test")])]),
                    "to": .array([.object(["address": .string("parity-project@example.test")])])]),
                "textBody": .string("Review the release checklist before the planning meeting."),
                "attachments": .array([]), "attribution": .object(["mailSlug": .string("parity-project"), "projectId": .string("local-project")]),
                "timings": .object(["messageReceivedAt": .string(start.addingTimeInterval(source == "online" ? 60 : 0).ISO8601Format())])
            ])])
        }
    }

    private func cloud(kind: String, name: String, arguments: JSONValue) throws -> JSONValue {
        guard var fields = arguments.objectValue, fields.removeValue(forKey: "companyId") == .string(company.id), kind == "mutation" else { throw unsupported(name) }
        switch name {
        case "calendars:createEvent":
            guard let id = fields["id"]?.stringValue, fields["calendarId"] == .string("owned") else { throw unsupported(name) }
            try checkCalendarFailure()
            put("calendarEvent", id, fields)
        case "calendars:updateEvent":
            guard let id = fields.removeValue(forKey: "eventId")?.stringValue else { throw unsupported(name) }
            try checkCalendarFailure()
            try update("calendarEvent", id, fields)
        case "calendars:deleteEvent":
            guard let id = fields["eventId"]?.stringValue else { throw unsupported(name) }
            remove("calendarEvent", id)
        case "emailTags:create":
            guard let id = fields["id"]?.stringValue else { throw unsupported(name) }
            put("emailTag", id, fields)
        case "emailTags:update":
            guard let id = fields.removeValue(forKey: "tagId")?.stringValue else { throw unsupported(name) }
            try update("emailTag", id, fields)
        case "emailTags:remove":
            guard let id = fields["tagId"]?.stringValue else { throw unsupported(name) }
            remove("emailTag", id)
        case "capturedEmails:setTag":
            guard let source = fields["environmentId"]?.stringValue, let message = fields["messageId"]?.stringValue,
                  let tag = fields["tagId"]?.stringValue, let present = fields["present"]?.boolValue else { throw unsupported(name) }
            let id = "\(source):\(message)"
            var tags = Set(try row("capturedEmail", id)["tagIds"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            if present { tags.insert(tag) } else { tags.remove(tag) }
            try update("capturedEmail", id, ["tagIds": .array(tags.sorted().map(JSONValue.string))])
        case "capturedEmails:remove":
            guard let messages = fields["messages"]?.arrayValue else { throw unsupported(name) }
            for message in messages {
                guard let source = message.objectValue?["environmentId"]?.stringValue, let id = message.objectValue?["messageId"]?.stringValue else { throw unsupported(name) }
                remove("capturedEmail", "\(source):\(id)")
            }
        default: throw unsupported(name)
        }
        publish()
        return .null
    }

    private func environment(_ source: String, method: String, payload: JSONValue) throws -> JSONValue {
        guard source == "online" else { throw PathwayIssueWriteError(message: "The source environment is offline. Reconnect and try again.") }
        switch method {
        case "email.markRead", "email.markUnread":
            guard let target = payload.objectValue?["target"]?.objectValue, target["type"] == .string("message"),
                  let id = target["messageId"]?.stringValue, var message = try row("capturedEmail", "\(source):\(id)")["message"]?.objectValue else { throw unsupported(method) }
            message["isRead"] = .bool(method == "email.markRead")
            try update("capturedEmail", "\(source):\(id)", ["message": .object(message)])
            publish()
            return .null
        case "email.getSettings": return settingsSnapshot
        case "email.updateSettings":
            guard let next = payload.objectValue?["settings"]?.objectValue else { throw unsupported(method) }
            settings = next
            return settingsSnapshot
        case "email.analytics":
            return .object(["volumeOverTime": .array([.object(["bucketStart": .string(Calendar.current.startOfDay(for: Date()).ISO8601Format()), "messageCount": .number(2)])]),
                "captureLatency": .object(["messageCount": .number(2), "averageMs": .number(42), "p50Ms": .number(40), "p95Ms": .number(44), "maxMs": .number(44)]),
                "perProjectCounts": .array([.object(["projectId": .string("local-project"), "mailSlug": .string("parity-project"), "messageCount": .number(2)])]),
                "topSenders": .array([.object(["address": .string("sender@example.test"), "messageCount": .number(2)])]), "topRecipients": .array([])])
        default: throw unsupported(method)
        }
    }

    private var settingsSnapshot: JSONValue { .object(["settings": .object(settings), "listenerStatus": .object(["state": .string("listening")])]) }
    private func checkCalendarFailure() throws {
        if ProcessInfo.processInfo.arguments.contains("--parity-deny-calendar") { throw PathwayIssueWriteError(message: "Calendar save denied by fixture.") }
    }
    private func unsupported(_ name: String) -> PathwayIssueWriteError { .init(message: "Unsupported parity fixture request: \(name)") }
    private func row(_ kind: String, _ id: String) throws -> [String: JSONValue] {
        guard let fields = changes.first(where: { $0.entityKind == kind && $0.entityId == id })?.payload?.objectValue else { throw unsupported("missing \(kind)/\(id)") }
        return fields
    }
    private func update(_ kind: String, _ id: String, _ fields: [String: JSONValue]) throws { put(kind, id, try row(kind, id).merging(fields) { _, new in new }) }
    private func put(_ kind: String, _ id: String, _ fields: [String: JSONValue]) {
        remove(kind, id)
        version += 1
        changes.append(.init(version: version, entityKind: kind, entityId: id, changeKind: "upsert", payload: .object(fields.merging(["id": .string(id)]) { _, new in new })))
    }
    private func remove(_ kind: String, _ id: String) { changes.removeAll { $0.entityKind == kind && $0.entityId == id } }
    private func publish() { appModel.cloud.installIssueSimulatorSnapshot(company: company, changes: changes, version: version) }
}

@MainActor private final class PathwayParitySimulatorAuth: PathwayAuthenticating {
    var hasActiveSession: Bool { false }
    var onSessionChanged: ((Bool) -> Void)?
    func startHostedSignIn() async throws { throw PathwayAuthError.missingSession }
    func token(template: String?) async throws -> String { throw PathwayAuthError.missingSession }
    func signOut() async throws {}
}
#endif
