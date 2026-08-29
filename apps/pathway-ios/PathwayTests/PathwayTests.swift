import Foundation
@testable import Pathway
import Testing

struct PathwayTests {
    @Test func appShellUsesCompactLayoutForNarrowIOSWindows() {
        #expect(AppShellLayout.resolve(usesRegularWidth: false, isVisionOS: false) == .compact)
    }

    @Test func appShellUsesSidebarLayoutForRegularIOSWindows() {
        #expect(AppShellLayout.resolve(usesRegularWidth: true, isVisionOS: false) == .sidebar)
    }

    @Test func appShellAlwaysUsesSpatialLayoutOnVisionOS() {
        #expect(AppShellLayout.resolve(usesRegularWidth: false, isVisionOS: true) == .spatial)
        #expect(AppShellLayout.resolve(usesRegularWidth: true, isVisionOS: true) == .spatial)
    }

    @Test func everyDestinationAppearsExactlyOnceInTheNavigationRail() {
        let railDestinations = AppDestination.sidebarSections.flatMap(\.destinations)

        #expect(railDestinations.count == AppDestination.allCases.count)
        #expect(Set(railDestinations) == Set(AppDestination.allCases))
    }

    @Test func everyDestinationHasAUniqueDefaultContextView() {
        for destination in AppDestination.allCases {
            let contextDestinations = destination.contextDestinations

            #expect(contextDestinations.isEmpty == false)
            #expect(Set(contextDestinations.map(\.id)).count == contextDestinations.count)
            #expect(contextDestinations.first == destination.defaultContextDestination)
        }
    }

    @MainActor
    @Test func activeSessionRestoresSignedInState() async {
        let authProvider = TestAuthProvider(hasActiveSession: true)
        let appModel = PathwayAppModel(authProvider: authProvider)

        await appModel.restoreSession()

        #expect(appModel.authenticationState == .signedIn)
        #expect(appModel.authenticationErrorMessage == nil)
    }

    @MainActor
    @Test func endedSessionReturnsAppToSignedOutState() async {
        let authProvider = TestAuthProvider(hasActiveSession: true)
        let appModel = PathwayAppModel(authProvider: authProvider)
        await appModel.restoreSession()

        authProvider.hasActiveSession = false
        authProvider.onSessionChanged?(false)

        #expect(appModel.authenticationState == .signedOut)
        #expect(appModel.authenticationErrorMessage != nil)
    }

    @MainActor
    @Test func failedSignOutPreservesAuthenticationState() async {
        let authProvider = TestAuthProvider(
            hasActiveSession: true,
            signOutError: SignOutTestError.failed
        )
        let appModel = PathwayAppModel(authProvider: authProvider)
        await appModel.restoreSession()

        await appModel.signOut()

        #expect(appModel.authenticationState == .signedIn)
        #expect(appModel.authenticationErrorMessage == "The test sign-out failed.")
    }

    @Test func timelineDecodesStreamingMarkdownAndAttachments() {
        let item = PathwayTimelineItem(json: .object([
            "id": .string("item-1"),
            "ordinal": .number(3),
            "type": .string("assistant_message"),
            "status": .string("running"),
            "text": .string("**Working**"),
            "streaming": .bool(true),
            "attachments": .array([
                .object([
                    "id": .string("attachment-1"),
                    "type": .string("file"),
                    "name": .string("notes.md"),
                    "mimeType": .string("text/markdown"),
                    "sizeBytes": .number(42)
                ])
            ])
        ]))

        #expect(item?.text == "**Working**")
        #expect(item?.streaming == true)
        #expect(item?.attachments.first?.name == "notes.md")
    }

    @Test func timelineDecodesApprovalAsActionable() {
        let item = PathwayTimelineItem(json: .object([
            "id": .string("approval-1"),
            "ordinal": .number(4),
            "type": .string("approval_request"),
            "status": .string("waiting"),
            "requestId": .string("request-1"),
            "requestKind": .string("command"),
            "prompt": .string("Run the release command?")
        ]))

        #expect(item?.requiresResponse == true)
        #expect(item?.requestID == "request-1")
        #expect(item?.text == "Run the release command?")
    }

    @Test func messageDispatchUsesMobileContractAndQueuesActiveThreads() {
        let command = PathwayAgentThreadCommands.dispatchMessage(
            threadID: "thread-1",
            text: "Continue",
            hasActiveRun: true,
            identifier: "command-1"
        ).objectValue

        #expect(command?["type"]?.stringValue == "message.dispatch")
        #expect(command?["creationSource"]?.stringValue == "mobile")
        #expect(command?["messageId"]?.stringValue == "command-1")
        #expect(
            command?["dispatchMode"]?.objectValue?["type"]?.stringValue
                == "queue_after_active"
        )
    }

    @Test func threadLaunchUsesBoundProjectAndSelectedControls() {
        let command = PathwayAgentThreadCommands.launchThread(
            PathwayThreadLaunchDraft(
                projectID: "local-project-1",
                prompt: "Build the dashboard",
                modelSelection: PathwayModelSelection(
                    instanceId: "codex-work",
                    model: "gpt-5.6-sol",
                    options: [PathwayModelOption(id: "reasoningEffort", value: .string("high"))]
                ),
                runtimeMode: "approval-required",
                interactionMode: "plan",
                workspaceMode: "worktree",
                baseReference: "main",
                branch: "feature/mobile",
                startFromOrigin: true
            ),
            identifier: "launch-1"
        ).objectValue

        #expect(command?["creationSource"]?.stringValue == "mobile")
        #expect(command?["projectId"]?.stringValue == "local-project-1")
        #expect(
            command?["modelSelection"]?.objectValue?["instanceId"]?.stringValue
                == "codex-work"
        )
        #expect(
            command?["workspaceStrategy"]?.objectValue?["type"]?.stringValue
                == "worktree"
        )
        #expect(
            command?["initialMessage"]?.objectValue?["text"]?.stringValue
                == "Build the dashboard"
        )
    }

    @Test func dpopProofURLDropsQueryAndDefaultPort() throws {
        let input = try #require(URL(string: "https://relay.example:443/v1/connect?token=secret#part"))
        let normalized = try #require(PathwayDPoPSigner.normalizedHTU(input))

        #expect(normalized.absoluteString == "https://relay.example/v1/connect")
    }
}

@MainActor
private final class TestAuthProvider: PathwayAuthenticating {
    var hasActiveSession: Bool
    var onSessionChanged: ((Bool) -> Void)?

    private let signInError: (any Error)?
    private let signOutError: (any Error)?

    init(
        hasActiveSession: Bool,
        signInError: (any Error)? = nil,
        signOutError: (any Error)? = nil
    ) {
        self.hasActiveSession = hasActiveSession
        self.signInError = signInError
        self.signOutError = signOutError
    }

    func startHostedSignIn() async throws {
        if let signInError {
            throw signInError
        }
        hasActiveSession = true
        onSessionChanged?(true)
    }

    func signOut() async throws {
        if let signOutError {
            throw signOutError
        }
        hasActiveSession = false
        onSessionChanged?(false)
    }

    func token(template _: String?) async throws -> String {
        "test-token"
    }
}

private enum SignOutTestError: LocalizedError {
    case failed

    var errorDescription: String? {
        "The test sign-out failed."
    }
}
