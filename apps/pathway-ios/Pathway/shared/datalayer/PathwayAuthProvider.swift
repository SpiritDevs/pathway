import ClerkKit
import Foundation

@MainActor
protocol PathwayAuthenticating: AnyObject {
    var hasActiveSession: Bool { get }
    var onSessionChanged: ((Bool) -> Void)? { get set }

    func startHostedSignIn() async throws
    func signOut() async throws
    func token(template: String?) async throws -> String
}

enum PathwayAuthError: LocalizedError {
    case clerkNotReady
    case missingSession
    case tokenUnavailable

    var errorDescription: String? {
        switch self {
        case .clerkNotReady:
            "Pathway authentication is still loading. Please try again."
        case .missingSession:
            "Your session has expired. Please log in again."
        case .tokenUnavailable:
            "Pathway could not authenticate this session. Please try again."
        }
    }
}

/// Owns Clerk's hosted authentication and exposes a platform-neutral session boundary.
/// Backend clients can consume Clerk tokens without making the app shell depend on their SDK.
@MainActor
final class PathwayAuthProvider: PathwayAuthenticating {
    var onSessionChanged: ((Bool) -> Void)?

    private var sessionObservationTask: Task<Void, Never>?

    var hasActiveSession: Bool {
        Clerk.shared.session?.status == .active
    }

    init() {
        sessionObservationTask = Task { @MainActor [weak self] in
            for await _ in Clerk.shared.auth.events {
                guard let self, !Task.isCancelled else { return }
                onSessionChanged?(hasActiveSession)
            }
        }
    }

    deinit {
        sessionObservationTask?.cancel()
    }

    func startHostedSignIn() async throws {
        guard Clerk.shared.isLoaded else {
            throw PathwayAuthError.clerkNotReady
        }

        try await Clerk.shared.auth.startHostedAuth()

        guard hasActiveSession else {
            throw PathwayAuthError.missingSession
        }
    }

    func signOut() async throws {
        try await Clerk.shared.auth.signOut()
    }

    func token(template: String?) async throws -> String {
        guard Clerk.shared.isLoaded else {
            throw PathwayAuthError.clerkNotReady
        }
        guard let session = Clerk.shared.session, session.status == .active else {
            throw PathwayAuthError.missingSession
        }
        guard let token = try await session.getToken(.init(template: template)) else {
            throw PathwayAuthError.tokenUnavailable
        }
        return token
    }
}
