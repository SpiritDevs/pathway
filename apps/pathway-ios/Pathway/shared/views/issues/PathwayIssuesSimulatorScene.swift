#if DEBUG && !os(visionOS)
import SwiftUI
import Observation

/// Deterministic simulator workspace. It has no authenticated client or environment transport.
/// Launch with --uitest-issues; this entire entry point is absent from Release builds.
struct PathwayIssuesSimulatorScene: View {
    @State private var workspace = PathwayIssueSimulatorWorkspace()

    var body: some View {
        MainTabView(initialDestination: .issues)
            .environment(workspace.appModel)
            .preferredColorScheme(.light)
    }
}

@MainActor
@Observable
private final class PathwayIssueSimulatorWorkspace {
    let appModel = PathwayAppModel(authProvider: IssueSimulatorAuth())
    private var version = 1
    private var changes: [PathwaySyncChange] = []
    private let company = PathwayCompany(id: "sim-company", membershipId: "sim-member", name: "Pathway",
        workspaceKind: "company", issueKeyPrefix: "PW", lifecycleState: "active", syncVersion: 1, isOwner: true)

    init() {
        let suite = UserDefaults(suiteName: "pathway.issue-simulator.\(UUID().uuidString)")!
        appModel.cloud.issues = PathwayIssuesModel(sendOperations: { [weak self] _, value in
            guard let self else { throw CancellationError() }
            let operations = value.arrayValue ?? []
            for operation in operations { apply(operation) }
            publish()
            return .object(["receipts": .array(operations.map { _ in .object(["status": .string("accepted")]) })])
        }, defaults: suite)
        seed()
        publish()
    }

    private func seed() {
        append("cloudProject", "sim-project", ["name": .string("Pathway"), "description": .string(""), "archivedAt": .null])
        append("membership", "sim-member", ["displayNameSnapshot": .string("Corey"), "state": .string("active")])
        for (index, status) in [("review", "In review", "#34C759"), ("started", "In progress", "#FFCC00"), ("unstarted", "Todo", "#8E8E93")].enumerated() {
            append("issueStatus", status.0, ["name": .string(status.1), "category": .string(status.0),
                "scope": .string("company"), "color": .string(status.2), "position": .number(Double(index))])
        }
        append("issueLabel", "sim-bug", ["name": .string("Bug"), "color": .string("#FF3B30")])
        append("issueLabel", "sim-ai", ["name": .string("AI"), "color": .string("#AF52DE")])
        append("issueLabel", "sim-backend", ["name": .string("Backend"), "color": .string("#008080")])
        append("issueMilestone", "sim-milestone", ["name": .string("M5 · Desktop and mobile sync"), "cloudProjectId": .string("sim-project")])
        let titles = ["Calendar changes jump back", "Reconnect remote sessions", "Preview issue attachments",
            "Keep project selection after reconnect", "Open linked agent threads", "Improve issue search",
            "Sync status across devices", "Add images to comments", "Restore saved views", "Fix milestone date picker",
            "Show pull request updates", "Preserve unsent replies", "Keyboard focus in issue editor"]
        for (index, title) in titles.enumerated() {
            append("issue", "sim-issue-\(index)", ["key": .string("PW-\(248 + index)"), "title": .string(title),
                "description": .string(index == 0 ? "## Goal\n\nKeep the latest calendar change visible while the server catches up. Users should be able to move between desktop and mobile without losing their work.\n\n## Source decision\n\nPreserve the local update until the workspace confirms it. A slow connection should never make a successful change jump back.\n\n## Done in repo\n\n- [x] Keep the most recent change visible.\n- [x] Restore the previous value only when saving fails.\n- [ ] Verify the reconnect flow on mobile." : "Keep the latest change visible while the server catches up."),
                "statusId": .string(index < 7 ? "review" : index < 10 ? "started" : "unstarted"),
                "priority": .string(index == 0 ? "high" : "none"), "projectId": .string("sim-project"),
                "cloudProjectId": .string("sim-project"), "triage": .bool(false), "labelIds": .array(index == 0 ? [.string("sim-ai"), .string("sim-backend"), .string("sim-bug")] : []),
                "milestoneId": index == 0 ? .string("sim-milestone") : .null,
                "dueDate": index == 0 ? .string("2026-09-20") : .null,
                "assignee": .object(["kind": .string("member"), "membershipId": .string("sim-member")]),
                "sortOrder": .string(String(UnicodeScalar(98 + index)!)),
                "parentId": index == 1 ? .string("sim-issue-0") : .null,
                "createdAt": .number(1_788_537_600_000), "updatedAt": .number(1_788_537_600_000), "deletedAt": .null])
        }
        append("issueTodo", "sim-todo", ["issueId": .string("sim-issue-0"), "text": .string("Reproduce on slow network"), "done": .bool(false), "sortOrder": .string("n")])
        append("issueComment", "sim-comment", ["issueId": .string("sim-issue-0"), "body": .string("Keep the new position visible while syncing."),
            "author": .object(["kind": .string("member"), "membershipId": .string("sim-member")]),
            "createdAt": .number(1_788_537_600_000)])
    }

    private func append(_ kind: String, _ id: String, _ fields: [String: JSONValue]) {
        var payload = fields; payload["id"] = .string(id)
        changes.append(PathwaySyncChange(version: version, entityKind: kind, entityId: id, changeKind: "upsert", payload: .object(payload)))
    }

    private func apply(_ operation: JSONValue) {
        guard let fields = operation.objectValue, let kind = fields["kind"]?.stringValue,
              let id = fields["entityId"]?.stringValue, let args = fields["args"]?.objectValue else { return }
        version += 1
        let parts = kind.split(separator: ".").map(String.init)
        guard parts.count == 2 else { return }
        let index = changes.firstIndex { $0.entityKind == parts[0] && $0.entityId == id }
        var payload = index.flatMap { changes[$0].payload?.objectValue } ?? [:]
        payload.merge(args) { _, value in value }
        payload["updatedAt"] = .number(Date().timeIntervalSince1970 * 1000)
        if parts[1] == "create", parts[0] == "issue" {
            payload["key"] = .string("PW-\(300 + version)")
            payload["triage"] = args["triage"] ?? .bool(false)
        }
        if parts[1] == "delete" { payload["deletedAt"] = .number(Date().timeIntervalSince1970 * 1000) }
        if parts[1] == "restore" { payload["deletedAt"] = .null }
        if let index { changes.remove(at: index) }
        append(parts[0], id, payload)
    }

    private func publish() {
        appModel.cloud.installIssueSimulatorSnapshot(company: company, changes: changes, version: version)
    }
}
@MainActor
private final class IssueSimulatorAuth: PathwayAuthenticating {
    var hasActiveSession: Bool { false }
    var onSessionChanged: ((Bool) -> Void)?
    func startHostedSignIn() async throws { throw PathwayAuthError.missingSession }
    func signOut() async throws {}
    func token(template: String?) async throws -> String { throw PathwayAuthError.missingSession }
}
#endif
