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

    @Test func everyDestinationAppearsExactlyOnceInTheSidebar() {
        let sidebarDestinations = AppDestination.sidebarSections.flatMap(\.destinations)

        #expect(sidebarDestinations.count == AppDestination.allCases.count)
        #expect(Set(sidebarDestinations) == Set(AppDestination.allCases))
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
