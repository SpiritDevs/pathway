import Foundation

/// Company identity stays beside each payload because entity IDs alone do not route a write.
struct PathwayIssueRecord: Equatable, Identifiable, Sendable {
    let companyId: String
    let fields: [String: JSONValue]
    var id: String { string("id") ?? "" }
    var identity: String { "\(companyId):\(id)" }
    var key: String { string("key") ?? "Draft" }
    var title: String { string("title") ?? "Untitled task" }
    var description: String { string("description") ?? "" }
    var statusId: String { string("statusId") ?? "" }
    var priority: String { string("priority") ?? "none" }
    var assignee: JSONValue? { fields["assignee"] == .null ? nil : fields["assignee"] }
    var projectId: String? { string("projectId") }
    var milestoneId: String? { string("milestoneId") }
    var cycleId: String? { string("cycleId") }
    var parentId: String? { string("parentId") }
    var labelIds: [String] { fields["labelIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    var dueDate: String? { string("dueDate") }
    var triage: Bool { fields["triage"]?.boolValue ?? false }
    var deletedAt: Date? { pathwayIssueDate(fields["deletedAt"]) }
    var isDeleted: Bool { deletedAt != nil }
    var createdAt: Date { pathwayIssueDate(fields["createdAt"]) ?? .distantPast }
    var updatedAt: Date { pathwayIssueDate(fields["updatedAt"]) ?? .distantPast }
    var sortOrder: String { string("sortOrder") ?? "" }
    func string(_ key: String) -> String? { fields[key]?.stringValue }
}

/// Small, forward-compatible wrappers preserve the complete synced detail payload.
struct PathwayIssueEntity: Equatable, Identifiable, Sendable {
    let companyId: String
    let kind: String
    let fields: [String: JSONValue]
    var id: String { string("id") ?? "" }
    var identity: String { "\(companyId):\(kind):\(id)" }
    var name: String { string("name") ?? string("displayNameSnapshot") ?? string("emailSnapshot") ?? "" }
    var color: String { string("color") ?? "#8E8E93" }
    var category: String { string("category") ?? "backlog" }
    var position: Double {
        guard case let .number(value) = fields["position"] else { return 0 }
        return value
    }
    var createdAt: Date { pathwayIssueDate(fields["createdAt"]) ?? .distantPast }
    var updatedAt: Date { pathwayIssueDate(fields["updatedAt"]) ?? createdAt }
    subscript(key: String) -> JSONValue? { fields[key] }
    func string(_ key: String) -> String? { fields[key]?.stringValue }
}

struct PathwayIssueDetail: Equatable, Sendable {
    var todos: [PathwayIssueEntity] = []
    var comments: [PathwayIssueEntity] = []
    var relations: [PathwayIssueEntity] = []
    var attachments: [PathwayIssueEntity] = []
    var events: [PathwayIssueEntity] = []
    var threadLinks: [PathwayIssueEntity] = []
}

func pathwayIssueDate(_ value: JSONValue?) -> Date? {
    switch value {
    case let .number(milliseconds): Date(timeIntervalSince1970: milliseconds / 1_000)
    case let .string(text): ISO8601DateFormatter().date(from: text)
    default: nil
    }
}

struct PathwayIssueWriteError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Wire envelopes use persisted installation ordering and the replica's company version.
enum PathwayIssueOperations {
    static func envelope(
        companyID: String, membershipID: String, clientID: String, sequence: Int,
        baseVersion: Int, kind: String, entityID: String, args: [String: JSONValue],
        operationID: String = UUID().uuidString.lowercased()
    ) -> JSONValue {
        .object([
            "protocolVersion": .number(1), "operationId": .string(operationID),
            "companyId": .string(companyID), "clientId": .string(clientID),
            "environmentId": .null,
            "actor": .object(["kind": .string("member"), "membershipId": .string(membershipID)]),
            "localSequence": .number(Double(sequence)), "baseVersion": .number(Double(baseVersion)),
            "entityId": .string(entityID), "dependsOn": .array([]),
            "kind": .string(kind), "args": .object(args)
        ])
    }

    static func validateReceipts(_ response: JSONValue, expectedCount: Int) throws {
        guard let receipts = response.objectValue?["receipts"]?.arrayValue,
              receipts.count == expectedCount else {
            throw PathwayIssueWriteError(message: "Pathway did not confirm this task change. Refresh before retrying.")
        }
        for receipt in receipts {
            guard receipt.objectValue?["status"]?.stringValue == "accepted" else {
                throw PathwayIssueWriteError(
                    message: receipt.objectValue?["message"]?.stringValue ?? "This task change was rejected."
                )
            }
        }
    }
}
