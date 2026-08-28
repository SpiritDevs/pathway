@preconcurrency import ConvexMobile
import Foundation
import Observation

enum AppAuthenticationState: Equatable {
    case restoring
    case signedOut
    case signingIn
    case signedIn
}

@MainActor
@Observable
final class PathwayAppModel {
    private(set) var authenticationState: AppAuthenticationState = .restoring
    private(set) var authenticationErrorMessage: String?

    @ObservationIgnored private let authProvider: PathwayAuthProvider
    @ObservationIgnored private let convex: ConvexClientWithAuth<PathwayAuthSession>
    @ObservationIgnored private let performSignOut: @MainActor () async throws -> Void
    @ObservationIgnored private var hasRestoredSession = false

    init(
        convexDeploymentURL: URL,
        performSignOut: (@MainActor () async throws -> Void)? = nil
    ) {
        let provider = PathwayAuthProvider()
        authProvider = provider
        convex = ConvexClientWithAuth(
            deploymentUrl: convexDeploymentURL.absoluteString,
            authProvider: provider
        )
        self.performSignOut = performSignOut ?? {
            try await provider.logout()
        }
        provider.onSessionEnded = { [weak self] in
            self?.sessionDidEnd()
        }
    }

    func restoreSession() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        authenticationState = .restoring

        switch await convex.loginFromCache() {
        case .success:
            authenticationErrorMessage = nil
            authenticationState = .signedIn
        case .failure:
            authenticationState = .signedOut
        }
    }

    func signIn() async {
        authenticationState = .signingIn
        authenticationErrorMessage = nil

        do {
            try await authProvider.startHostedSignIn()
            switch await convex.login() {
            case .success:
                authenticationState = .signedIn
            case let .failure(error):
                authenticationState = .signedOut
                authenticationErrorMessage = error.localizedDescription
            }
        } catch {
            authenticationState = .signedOut
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        do {
            try await performSignOut()
            authenticationErrorMessage = nil
            authenticationState = .signedOut
        } catch {
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func sessionDidEnd() {
        authenticationErrorMessage = "Your Pathway session ended. Sign in again to continue."
        authenticationState = .signedOut
    }
}
