import ClerkKit
@preconcurrency import ConvexMobile
import Foundation

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

/// Bridges Pathway's Clerk session into Convex.
/// Clerk owns credential collection, MFA, OAuth, recovery, and persisted sessions.
@MainActor
final class PathwayAuthProvider: AuthProvider {
    private let jwtTemplate: String
    private var onIDToken: (@Sendable (String?) -> Void)?
    private var refreshTask: Task<Void, Never>?

    var onSessionEnded: (@MainActor () -> Void)?

    init(jwtTemplate: String = AppConfiguration.convexJWTTemplate) {
        self.jwtTemplate = jwtTemplate
    }

    func startHostedSignIn() async throws {
        guard Clerk.shared.isLoaded else {
            throw PathwayAuthError.clerkNotReady
        }
        try await Clerk.shared.auth.startHostedAuth()
    }

    func login(
        onIdToken: @Sendable @escaping (String?) -> Void
    ) async throws -> PathwayAuthSession {
        try await makeSession(onIdToken: onIdToken)
    }

    func loginFromCache(
        onIdToken: @Sendable @escaping (String?) -> Void
    ) async throws -> PathwayAuthSession {
        try await makeSession(onIdToken: onIdToken)
    }

    func logout() async throws {
        refreshTask?.cancel()
        refreshTask = nil
        onIDToken = nil
        try await Clerk.shared.auth.signOut()
    }

    nonisolated func extractIdToken(from authResult: PathwayAuthSession) -> String {
        authResult.idToken
    }

    private func makeSession(
        onIdToken: @Sendable @escaping (String?) -> Void
    ) async throws -> PathwayAuthSession {
        onIDToken = onIdToken
        let token = try await fetchToken()
        onIdToken(token)
        startRefreshListener()
        return PathwayAuthSession(idToken: token)
    }

    private func fetchToken() async throws -> String {
        guard Clerk.shared.isLoaded else {
            throw PathwayAuthError.clerkNotReady
        }
        guard let session = Clerk.shared.session, session.status == .active else {
            throw PathwayAuthError.missingSession
        }
        guard let token = try await session.getToken(.init(template: jwtTemplate)) else {
            throw PathwayAuthError.tokenUnavailable
        }
        return token
    }

    private func startRefreshListener() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await _ in Clerk.shared.auth.events {
                guard !Task.isCancelled else { return }
                guard let session = Clerk.shared.session, session.status == .active else {
                    endSession()
                    return
                }
                guard let token = try? await session.getToken(.init(template: jwtTemplate)) else {
                    continue
                }
                onIDToken?(token)
            }
        }
    }

    private func endSession() {
        refreshTask = nil
        onIDToken?(nil)
        onIDToken = nil
        onSessionEnded?()
    }
}
