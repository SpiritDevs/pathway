import Foundation

enum PathwayCloudConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case syncing
    case connected
    case failed(String)
}

struct PathwayCompany: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let membershipId: String
    let name: String
    let workspaceKind: String
    let issueKeyPrefix: String
    let lifecycleState: String
    let syncVersion: Int
    let isOwner: Bool
}

struct PathwayEnvironmentDescriptor: Decodable, Equatable, Sendable {
    let environmentId: String
    let label: String
    let serverVersion: String
}

struct PathwayEnvironment: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let environmentId: String
    let descriptor: PathwayEnvironmentDescriptor
    let relayLinkState: String
    let managedEndpointAvailable: Bool
    let lastSeenAt: Double?
    let state: String

    var label: String { descriptor.label }
}

struct PathwayCompanyEnvironment: Equatable, Identifiable, Sendable {
    let companyId: String
    let environment: PathwayEnvironment

    var id: String { "\(companyId):\(environment.environmentId)" }
}

struct PathwayCloudProject: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let description: String
    let archivedAt: Double?
}

struct PathwayCompanyProject: Equatable, Identifiable, Sendable {
    let companyId: String
    let project: PathwayCloudProject

    var id: String { "\(companyId):\(project.id)" }
}

struct PathwayEnvironmentBinding: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let cloudProjectId: String
    let environmentId: String
    let localProjectId: String
    let localWorkspaceRoot: String
    let status: String
    let lastSeenAt: Double?
}

struct PathwayCompanyEnvironmentBinding: Equatable, Identifiable, Sendable {
    let companyId: String
    let binding: PathwayEnvironmentBinding

    var id: String { "\(companyId):\(binding.id)" }
}

struct PathwayModelOption: Codable, Equatable, Sendable {
    let id: String
    let value: JSONValue
}

struct PathwayModelSelection: Codable, Equatable, Sendable {
    let instanceId: String
    let model: String
    let options: [PathwayModelOption]?
}

struct PathwayLatestMessageSummary: Codable, Equatable, Sendable {
    let id: String
    let role: String
    let updatedAt: String
}

struct PathwayRuntimeRequestSummary: Codable, Equatable, Sendable {
    let id: String
    let kind: String
    let createdAt: String
}

struct PathwayThreadLineage: Codable, Equatable, Sendable {
    let rootThreadId: String
    let parentThreadId: String?
    let relationshipToParent: String?
}

struct PathwayAgentThreadShell: Codable, Equatable, Sendable {
    let id: String
    let projectId: String
    let title: String
    let providerInstanceId: String
    let modelSelection: PathwayModelSelection
    let runtimeMode: String
    let interactionMode: String
    let lineage: PathwayThreadLineage?
    let locations: [String]?
    let branch: String?
    let worktreePath: String?
    let latestRunRequestedAt: String?
    let latestRunStartedAt: String?
    let latestRunCompletedAt: String?
    let activeRunId: String?
    let activityRunStatus: String?
    let status: String
    let lastError: String?
    let pendingRuntimeRequest: PathwayRuntimeRequestSummary?
    let latestVisibleMessage: PathwayLatestMessageSummary?
    let latestUserMessageAt: String?
    let hasActionableProposedPlan: Bool
    let itemCount: Int
    let visibleItemCount: Int
    let createdAt: String
    let updatedAt: String
    let archivedAt: String?
    let settledOverride: String?
    let settledAt: String?
    let snoozedUntil: String?
    let snoozedAt: String?
    let pinnedAt: String?
    let pinOrderKey: String?
    let lastVisitedAt: String?
    let deletedAt: String?
}

struct PathwayAgentThread: Equatable, Identifiable, Sendable {
    let companyId: String
    let environmentId: String
    let cloudProjectId: String
    let shell: PathwayAgentThreadShell
    let cloudUpdatedAt: Double

    var id: String { "\(companyId):\(environmentId):\(shell.id)" }
    var threadId: String { shell.id }

    var sortDate: Date {
        pathwayDate(from: shell.updatedAt) ?? Date(timeIntervalSince1970: cloudUpdatedAt / 1000)
    }

    var needsAction: Bool {
        shell.pendingRuntimeRequest != nil || shell.hasActionableProposedPlan
    }

    var isRunning: Bool {
        shell.activeRunId != nil || ["preparing", "starting", "running"].contains(shell.status)
    }
}

enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = try .object(container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

struct PathwaySyncChange: Decodable, Equatable, Sendable {
    let version: Int
    let entityKind: String
    let entityId: String
    let changeKind: String
    let payload: JSONValue?
}

struct PathwaySyncBootstrapPage: Decodable, Equatable, Sendable {
    let version: Int
    let authorizationEpoch: Int
    let entities: [PathwaySyncChange]
    let cursor: String?
    let isDone: Bool
}

struct PathwaySyncHead: Decodable, Equatable, Sendable {
    let version: Int
    let authorizationEpoch: Int
}

struct PathwaySyncChangesPage: Decodable, Equatable, Sendable {
    let tag: String
    let changes: [PathwaySyncChange]?
    let cursor: Int?
    let hasMore: Bool?
    let latestVersion: Int
    let authorizationEpoch: Int

    enum CodingKeys: String, CodingKey {
        case tag = "_tag"
        case changes
        case cursor
        case hasMore
        case latestVersion
        case authorizationEpoch
    }
}

func decodePathwayPayload<Value: Decodable>(
    _ type: Value.Type,
    from payload: JSONValue
) throws -> Value {
    let data = try JSONEncoder().encode(payload)
    return try JSONDecoder().decode(type, from: data)
}

func pathwayDate(from value: String) -> Date? {
    if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) {
        return date
    }
    return try? Date.ISO8601FormatStyle().parse(value)
}
