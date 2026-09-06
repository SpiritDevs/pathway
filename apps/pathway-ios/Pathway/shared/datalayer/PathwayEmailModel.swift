import Foundation
import Observation

struct PathwayEmailRecord: Identifiable, Equatable {
    let companyID: String
    var fields: [String: JSONValue]
    var id: String { "\(companyID):\(fields["id"]?.stringValue ?? "")" }
    var environmentID: String { fields["environmentId"]?.stringValue ?? "" }
    var message: [String: JSONValue] { fields["message"]?.objectValue ?? [:] }
    var messageID: String { message["id"]?.stringValue ?? "" }
    var headers: [String: JSONValue] { message["parsedHeaders"]?.objectValue ?? [:] }
    var subject: String { headers["subject"]?.stringValue ?? "(No subject)" }
    var sender: String { addresses("from") }
    var isRead: Bool { message["isRead"]?.boolValue ?? false }
    var tagIDs: [String] { fields["tagIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    var receivedAt: String { message["timings"]?.objectValue?["messageReceivedAt"]?.stringValue ?? "" }
    var inbox: String { message["attribution"]?.objectValue?["mailSlug"]?.stringValue ?? "Unassigned" }
    func addresses(_ key: String) -> String {
        (headers[key]?.arrayValue ?? []).compactMap { $0.objectValue?["address"]?.stringValue }.joined(separator: ", ")
    }
}

@MainActor @Observable
final class PathwayEmailModel {
    typealias EnvironmentRequest = @MainActor (String, String, String, JSONValue) async throws -> JSONValue
    private(set) var messages: [PathwayEmailRecord] = []
    private(set) var tags: [PathwayCalendarRecord] = []
    private(set) var trustedSenders: [PathwayCalendarRecord] = []
    private(set) var isWriting = false
    var errorMessage: String?
    @ObservationIgnored private let cloudRequest: PathwayIssuesModel.CloudRequest?
    @ObservationIgnored private let environmentRequest: EnvironmentRequest?
    @ObservationIgnored private var readOverrides: [String: Bool] = [:]
    @ObservationIgnored private var tagOverrides: [String: [String: Bool]] = [:]
    @ObservationIgnored private var deleted: Set<String> = []
    @ObservationIgnored private var replicaVersions: [String: Int] = [:]

    init(cloudRequest: PathwayIssuesModel.CloudRequest? = nil, environmentRequest: EnvironmentRequest? = nil) {
        self.cloudRequest = cloudRequest; self.environmentRequest = environmentRequest
    }
    func replaceReplica(_ changes: [String: [PathwaySyncChange]], companies: [PathwayCompany] = []) {
        let included: Set<String> = ["capturedEmail", "emailTag", "trustedEmailSender"]
        var nextVersions: [String: Int] = [:]
        for (companyID, entries) in changes {
            for change in entries where included.contains(change.entityKind) { nextVersions["\(companyID):\(change.entityKind):\(change.entityId)"] = change.version }
        }
        guard nextVersions != replicaVersions else { return }
        replicaVersions = nextVersions
        let rows = changes.flatMap { companyID, entries in entries.compactMap { change -> PathwayCalendarRecord? in
            guard included.contains(change.entityKind), change.changeKind != "tombstone", var fields = change.payload?.objectValue else { return nil }
            fields["id"] = fields["id"] ?? .string(change.entityId)
            return .init(companyID: companyID, kind: change.entityKind, fields: fields)
        } }
        let incoming = rows.filter { $0.kind == "capturedEmail" }.map { PathwayEmailRecord(companyID: $0.companyID, fields: $0.fields) }
        let identities = Set(incoming.map(\.id))
        readOverrides = readOverrides.filter { identities.contains($0.key) }
        tagOverrides = tagOverrides.filter { identities.contains($0.key) }
        deleted.formIntersection(identities)
        messages = incoming.compactMap { record in
            guard !deleted.contains(record.id) else { return nil }
            var next = record
            if let read = readOverrides[record.id] {
                if record.isRead == read { readOverrides[record.id] = nil }
                else { var message = next.message; message["isRead"] = .bool(read); next.fields["message"] = .object(message) }
            }
            if let pending = tagOverrides[record.id] {
                var ids = Set(record.tagIDs)
                for (id, present) in pending {
                    if ids.contains(id) == present { tagOverrides[record.id]?[id] = nil }
                    if present { ids.insert(id) } else { ids.remove(id) }
                }
                next.fields["tagIds"] = .array(ids.sorted().map(JSONValue.string))
            }
            return next
        }.sorted { $0.receivedAt > $1.receivedAt }
        tags = rows.filter { $0.kind == "emailTag" }.sorted { $0.string("name") < $1.string("name") }
        trustedSenders = rows.filter { $0.kind == "trustedEmailSender" }
    }
    func cloud(_ name: String, companyID: String, fields: [String: JSONValue]) async throws -> JSONValue {
        guard let cloudRequest else { throw PathwayIssueWriteError(message: "Connect to your workspace to change email.") }
        var args = fields; args["companyId"] = .string(companyID)
        return try await cloudRequest("mutation", name, .object(args))
    }
    func environment(companyID: String, environmentID: String, method: String, fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard let environmentRequest else { throw PathwayIssueWriteError(message: "Connect to the source environment to change captured email.") }
        return try await environmentRequest(companyID, environmentID, method, .object(fields))
    }
    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !isWriting else { return false }
        isWriting = true; errorMessage = nil
        defer { isWriting = false }
        do { try await operation(); return true } catch { errorMessage = error.localizedDescription; return false }
    }
    func mark(_ records: [PathwayEmailRecord], read: Bool) async throws {
        for record in records {
            _ = try await environment(companyID: record.companyID, environmentID: record.environmentID, method: read ? "email.markRead" : "email.markUnread", fields: ["target": .object(["type": .string("message"), "messageId": .string(record.messageID)])])
            readOverrides[record.id] = read
            if let index = messages.firstIndex(where: { $0.id == record.id }) {
                var message = messages[index].message; message["isRead"] = .bool(read); messages[index].fields["message"] = .object(message)
            }
        }
    }
    func setTag(_ records: [PathwayEmailRecord], tagID: String, present: Bool) async throws {
        for record in records {
            _ = try await cloud("capturedEmails:setTag", companyID: record.companyID, fields: ["environmentId": .string(record.environmentID), "messageId": .string(record.messageID), "tagId": .string(tagID), "present": .bool(present)])
            tagOverrides[record.id, default: [:]][tagID] = present
            if let index = messages.firstIndex(where: { $0.id == record.id }) {
                var ids = Set(messages[index].tagIDs)
                if present { ids.insert(tagID) } else { ids.remove(tagID) }
                messages[index].fields["tagIds"] = .array(ids.sorted().map(JSONValue.string))
            }
        }
    }
    func remove(_ records: [PathwayEmailRecord]) async throws {
        for (companyID, records) in Dictionary(grouping: records, by: \.companyID) {
            _ = try await cloud("capturedEmails:remove", companyID: companyID, fields: ["messages": .array(records.map { .object(["environmentId": .string($0.environmentID), "messageId": .string($0.messageID)]) })])
            let ids = Set(records.map(\.id)); deleted.formUnion(ids); messages.removeAll { ids.contains($0.id) }
        }
    }
}
