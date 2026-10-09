#if DEBUG && !os(visionOS)
import SwiftUI
/// Exercises the production thread shell without an account, network or live data.
struct PathwayParitySimulatorScene: View {
    @State private var workspace = PathwayParitySimulatorWorkspace()

    var body: some View {
        Group {
            if ProcessInfo.processInfo.arguments.contains("--parity-threads") {
                AgentThreadRowsSimulatorView()
            } else {
                MainTabView()
            }
        }
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
    init() {
        seed()
        publish()
    }

    private func seed() {
        put("membership", "parity-member", ["displayNameSnapshot": .string("Parity owner"), "state": .string("active")])
        put("cloudProject", "parity-project", ["name": .string("Parity project"), "description": .string("Thread navigation validation"), "archivedAt": .null])
        let threadPreview = ProcessInfo.processInfo.arguments.contains("--parity-threads")
        for (id, label) in [("online", threadPreview ? "Corey's Mac Studio" : "Parity server"), ("offline", threadPreview ? "macOS-C02DN08X0KPF" : "Offline server")] {
            put("environmentRegistration", id, ["environmentId": .string(id),
                "descriptor": .object(["environmentId": .string(id), "label": .string(label), "serverVersion": .string("fixture")]),
                "relayLinkState": .string("linked"), "managedEndpointAvailable": .bool(id == "online"),
                "state": .string("active"), "lastSeenAt": .number(Date().timeIntervalSince1970 * 1000)])
        }
        put("environmentBinding", "parity-binding", ["cloudProjectId": .string("parity-project"), "environmentId": .string("online"),
            "localProjectId": .string("local-project"), "localWorkspaceRoot": .string("/fixture/parity"), "status": .string("active"), "lastSeenAt": .null])
        if ProcessInfo.processInfo.arguments.contains("--parity-thread-menu") {
            for (title, branch, environment) in AgentThreadRowsSimulatorView.samples {
                let thread = AgentThreadRowsSimulatorView.thread(title: title, branch: branch, environment: environment)
                let shell = try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(thread.shell))
                put("agentThread", thread.threadId, ["environmentId": .string(environment),
                    "cloudProjectId": .string("parity-project"), "shell": shell, "updatedAt": .number(0)])
            }
        }
    }

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
