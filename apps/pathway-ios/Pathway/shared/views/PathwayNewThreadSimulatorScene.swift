#if DEBUG && !os(visionOS)
import SwiftUI

/// Exercises the production composer with an isolated draft and attachment transport.
struct PathwayNewThreadSimulatorScene: View {
    @State private var workspace = NewThreadSimulatorWorkspace()
    @State private var showsComposer = true
    @State private var bindingID = "sim-company:sim-binding"

    var body: some View {
        Color.clear
            .sheet(isPresented: $showsComposer) {
                NavigationStack {
                    NewAgentThreadComposer(project: workspace.project, model: workspace.model,
                        selectedBindingID: $bindingID, automaticPlacementEnabled: false,
                        isResolvingPlacement: false, placementMessage: nil, placementUnavailable: false,
                        chooseAutomaticPlacement: {}, chooseEnvironment: { _ in }, chooseProject: {}, didLaunch: { _ in })
                        .navigationTitle("New Agent Thread")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showsComposer = false } } }
                }
                .environment(workspace.appModel)
                .task { await workspace.addAttachment() }
            }
            .preferredColorScheme(.light)
    }
}

@MainActor
private final class NewThreadSimulatorWorkspace {
    let appModel = PathwayAppModel(authProvider: NewThreadSimulatorAuth())
    let model: PathwayAgentThreadCreationModel
    let project: PathwayNewThreadProjectOption

    init() {
        let environment = PathwayCompanyEnvironment(companyId: "sim-company", environment: .init(
            id: "sim-env", environmentId: "sim-env", descriptor: .init(environmentId: "sim-env", label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let binding = PathwayCompanyEnvironmentBinding(companyId: "sim-company", binding: .init(
            id: "sim-binding", cloudProjectId: "sim-project", environmentId: "sim-env", localProjectId: "sim-project",
            localWorkspaceRoot: "/sim-project", status: "active", lastSeenAt: nil))
        project = .init(id: "sim-project", name: "pathway", companyName: "Simulator", bindings: [
            .init(binding: binding, environment: environment, projectID: "sim-project", projectName: "pathway", companyName: "Simulator")
        ])
        model = PathwayAgentThreadCreationModel(binding: binding, environment: environment, request: { _, _ in .object([:]) })
        model.applySubscriptionValue(.object(["type": .string("snapshot"), "config": .object([
            "environment": .object(["capabilities": .object(["storageManagement": .bool(false)])]),
            "settings": .object(["defaultThreadEnvMode": .string("local"), "newWorktreesStartFromOrigin": .bool(false)]),
            "providers": .array([.object(["instanceId": .string("codex"), "driver": .string("codex"), "enabled": .bool(true), "installed": .bool(true),
                "models": .array([.object(["slug": .string("model"), "name": .string("Model"), "isDefault": .bool(true)])])])])
        ])]))
        model.prompt = (1...30).map { "Requirement \($0): Keep the primary controls visible while editing a long draft with attached context." }.joined(separator: "\n")
        model.attachments.supportsUploads = true
        model.attachments.isConnected = true
        model.attachments.request = { _, _ in .object(["attachmentId": .string("sim-image"), "relativeUrl": .string("/api/attachments/sim-image")]) }
        model.attachments.uploadRequest = { _ in URLRequest(url: URL(string: "https://example.invalid/fixture")!) }
        model.attachments.upload = { _, _ in }
    }

    func addAttachment() async {
        guard model.attachments.drafts.isEmpty else { return }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 100)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 160, height: 100))
        }
        await model.attachments.add(data: image.pngData()!, name: "context.png", mimeType: "image/png")
    }
}

@MainActor private final class NewThreadSimulatorAuth: PathwayAuthenticating {
    var hasActiveSession: Bool { false }
    var onSessionChanged: ((Bool) -> Void)?
    func startHostedSignIn() async throws { throw PathwayAuthError.missingSession }
    func token(template: String?) async throws -> String { throw PathwayAuthError.missingSession }
    func signOut() async throws {}
}
#endif
