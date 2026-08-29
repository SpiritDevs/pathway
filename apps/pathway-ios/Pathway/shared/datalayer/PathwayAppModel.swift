import Foundation
import Observation

enum AppAuthenticationState: Equatable {
    case restoring
    case signedOut
    case signingIn
    case signedIn
}

/// A thread the user just launched from the composer. The shell watches this to switch
/// to Agent Threads and open the thread once it arrives through cloud sync.
struct PathwayPendingThreadRoute: Equatable, Sendable {
    let companyId: String
    let environmentId: String
    let threadId: String
}

@MainActor
@Observable
final class PathwayAppModel {
    private(set) var authenticationState: AppAuthenticationState = .restoring
    private(set) var authenticationErrorMessage: String?
    var pendingThreadRoute: PathwayPendingThreadRoute?
    let cloud: PathwayCloudModel
    let connect: PathwayConnectClient?

    @ObservationIgnored private let authProvider: any PathwayAuthenticating
    @ObservationIgnored private var hasRestoredSession = false

    init(
        authProvider: (any PathwayAuthenticating)? = nil,
        convexDeploymentURL: URL? = nil,
        relayURL: URL? = nil,
        relayJWTTemplate: String? = nil
    ) {
        let provider = authProvider ?? PathwayAuthProvider()
        self.authProvider = provider
        if let relayURL, let relayJWTTemplate {
            connect = PathwayConnectClient(
                relayURL: relayURL,
                clerkTokenProvider: {
                    try await provider.token(template: relayJWTTemplate)
                }
            )
        } else {
            connect = nil
        }
        #if os(visionOS)
            cloud = PathwayCloudModel()
        #else
            if let convexDeploymentURL {
                cloud = PathwayCloudModel(
                    client: PathwayConvexClient(
                        deploymentURL: convexDeploymentURL,
                        credentials: provider
                    )
                )
            } else {
                cloud = PathwayCloudModel()
            }
        #endif
        provider.onSessionChanged = { [weak self] hasActiveSession in
            self?.sessionDidChange(hasActiveSession: hasActiveSession)
        }
    }

    func restoreSession() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        authenticationErrorMessage = nil
        authenticationState = authProvider.hasActiveSession ? .signedIn : .signedOut
        if authenticationState == .signedIn {
            await cloud.start()
        }
    }

    func signIn() async {
        authenticationState = .signingIn
        authenticationErrorMessage = nil

        do {
            try await authProvider.startHostedSignIn()
            authenticationState = .signedIn
            await cloud.start()
        } catch {
            authenticationState = .signedOut
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        do {
            try await authProvider.signOut()
            await cloud.stop()
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

    private func sessionDidChange(hasActiveSession: Bool) {
        if hasActiveSession {
            authenticationErrorMessage = nil
            authenticationState = .signedIn
            Task { @MainActor [weak self] in
                await self?.cloud.start()
            }
        } else if authenticationState == .signedIn {
            sessionDidEnd()
            Task { @MainActor [weak self] in
                await self?.cloud.stop()
            }
        }
    }
}
