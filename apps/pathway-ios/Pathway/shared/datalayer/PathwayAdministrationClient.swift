import Foundation

typealias PathwayAdministrationRequest = @MainActor (PathwayCompanyEnvironment, String, JSONValue) async throws -> JSONValue
typealias PathwayAdministrationHTTP = @MainActor (PathwayCompanyEnvironment, String, String, JSONValue?) async throws -> JSONValue
typealias PathwayAdministrationCloudMutation = @MainActor (String, [String: JSONValue]) async throws -> JSONValue

@MainActor
struct PathwayAdministrationClient {
    let environment: PathwayCompanyEnvironment
    let request: PathwayAdministrationRequest
    let http: PathwayAdministrationHTTP
    var cloudMutation: PathwayAdministrationCloudMutation?
    func call<T: Decodable>(_ method: String, _ fields: [String: JSONValue] = [:]) async throws -> T {
        try decode(await request(environment, method, .object(fields)))
    }
    func run(_ method: String, _ fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await request(environment, method, .object(fields))
    }
    func projects() async throws -> [PathwayAdministrationProject] {
        let result: PathwayAdministrationProjects = try decode(await http(environment, "GET", "/api/projects", nil))
        return result.projects.filter { $0.deletedAt == nil }
    }
    private func decode<T: Decodable>(_ value: JSONValue) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }
}
struct PathwayAdministrationProjects: Decodable { let projects: [PathwayAdministrationProject] }
struct PathwayAdministrationProject: Decodable, Identifiable {
    let id: String
    let title: String
    let workspaceRoot: String?
    let defaultModelSelection: JSONValue?
    let defaultThreadEnvMode: String?
    let scripts: [PathwayAdministrationScript]
    let deletedAt: String?
}
struct PathwayAdministrationScript: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var command: String
    var icon: String
    var runOnWorktreeCreate: Bool
    var previewUrl: String?
    var autoOpenPreview: Bool?
}
struct PathwayAdministrationConfig: Decodable {
    let providers: [PathwayAdministrationProvider]
    let cwd: String
    let environment: Environment
    struct Environment: Decodable { let label: String; let serverVersion: String }
}
struct PathwayAdministrationProvider: Decodable, Identifiable {
    let instanceId: String
    let driver: String
    let displayName: String?
    let enabled: Bool
    let installed: Bool
    let version: String?
    let status: String
    let auth: Auth
    let message: String?
    let availability: String?
    let unavailableReason: String?
    let models: [Model]
    let versionAdvisory: Advisory?
    struct Advisory: Decodable { let canUpdate: Bool; let updateCommand: String?; let message: String? }
    var id: String { instanceId }
    var name: String { displayName ?? driver }
    struct Auth: Decodable { let status: String; let supportsLogin: Bool?; let email: String? }
    struct Model: Decodable, Identifiable { let slug: String; let name: String; var id: String { slug } }
}
struct PathwayAdministrationAuthFlow: Decodable {
    let flowId: String
    let authorizationUrl: String
    let completion: String?
    let userCode: String?
}

struct PathwayAdministrationScheduleList: Decodable { let tasks: [PathwayAdministrationSchedule] }
struct PathwayAdministrationSchedule: Decodable, Identifiable {
    let id: String
    let title: String
    let prompt: String
    let enabled: Bool
    let schedule: JSONValue
    let projectId: String
    let threadId: String?
    let workspaceStrategy: JSONValue
    let modelSelection: JSONValue
    let runtimeMode: String
    let interactionMode: String
    let nextRunAt: String?
    let lastRunAt: String?
    let lastRunStatus: String
    let lastRunError: String?
    let runCount: Int
}

struct PathwayAdministrationScheduleDraft {
    var id: String? = UUID().uuidString
    var title = ""
    var prompt = ""
    var enabled = true
    var projectID = ""
    var threadID = ""
    var intervalMinutes: Double = 60
    var timeOfDay = "09:00"
    var scheduleType = "interval"
    var weekdays = Set<Int>()
    var workspaceType = "worktree"
    var baseRef = "main"
    var worktreePath = ""
    var instanceID = ""
    var model = ""
    var runtimeMode = "approval-required"
    var interactionMode = "default"
    var originalSelection: JSONValue?
    var originalWorkspace: JSONValue?
    var commandID = UUID().uuidString

    init(task: PathwayAdministrationSchedule? = nil) {
        guard let task else { return }
        id = task.id; title = task.title; prompt = task.prompt; enabled = task.enabled
        projectID = task.projectId; threadID = task.threadId ?? ""
        scheduleType = task.schedule.objectValue?["type"]?.stringValue ?? "interval"
        intervalMinutes = max(1, Double(task.schedule.objectValue?["everyMs"]?.intValue ?? 3_600_000) / 60_000)
        timeOfDay = task.schedule.objectValue?["timeOfDay"]?.stringValue ?? "09:00"
        weekdays = Set(task.schedule.objectValue?["weekdays"]?.arrayValue?.compactMap(\.intValue) ?? [])
        originalWorkspace = task.workspaceStrategy
        workspaceType = task.workspaceStrategy.objectValue?["type"]?.stringValue ?? "worktree"
        baseRef = task.workspaceStrategy.objectValue?["baseRef"]?.stringValue ?? "main"
        worktreePath = task.workspaceStrategy.objectValue?["worktreePath"]?.stringValue ?? ""
        originalSelection = task.modelSelection
        instanceID = task.modelSelection.objectValue?["instanceId"]?.stringValue ?? ""
        model = task.modelSelection.objectValue?["model"]?.stringValue ?? ""
        runtimeMode = task.runtimeMode; interactionMode = task.interactionMode
    }
    var isValid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !projectID.isEmpty && !instanceID.isEmpty && !model.isEmpty &&
        (scheduleType != "fixed_time" || timeOfDay.range(of: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil) &&
        (workspaceType != "existing_worktree" || !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
        (workspaceType != "worktree" || !baseRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    func payload() throws -> [String: JSONValue] {
        guard isValid, intervalMinutes >= 1, intervalMinutes <= 525_600 else { throw PathwayRPCError.remote("Complete the task, model, workspace and schedule fields.") }
        let schedule: JSONValue
        if scheduleType == "interval" { schedule = .object(["type": .string("interval"), "everyMs": .number(Double(intervalMinutes) * 60_000)]) }
        else {
            var value: [String: JSONValue] = ["type": .string("fixed_time"), "timeOfDay": .string(timeOfDay)]
            if !weekdays.isEmpty { value["weekdays"] = .array(weekdays.sorted().map { .number(Double($0)) }) }
            schedule = .object(value)
        }
        var workspace: [String: JSONValue] = ["type": .string(workspaceType)]
        if workspaceType == "worktree" { workspace["baseRef"] = .string(baseRef); workspace["startFromOrigin"] = originalWorkspace?.objectValue?["startFromOrigin"] ?? .bool(true) }
        if workspaceType == "existing_worktree" { workspace["worktreePath"] = .string(worktreePath) }
        if let branch = originalWorkspace?.objectValue?["branch"], originalWorkspace?.objectValue?["type"]?.stringValue == workspaceType { workspace["branch"] = branch }
        let selection: JSONValue = originalSelection?.objectValue?["instanceId"]?.stringValue == instanceID && originalSelection?.objectValue?["model"]?.stringValue == model ? originalSelection! : .object(["instanceId": .string(instanceID), "model": .string(model)])
        var payload: [String: JSONValue] = ["commandId": .string(commandID), "title": .string(title), "prompt": .string(prompt), "enabled": .bool(enabled), "schedule": schedule, "projectId": .string(projectID), "threadId": threadID.isEmpty ? .null : .string(threadID), "workspaceStrategy": .object(workspace), "modelSelection": selection, "runtimeMode": .string(runtimeMode), "interactionMode": .string(interactionMode), "creationSource": .string("mobile")]
        if let id { payload["id"] = .string(id) }
        return payload
    }
}
