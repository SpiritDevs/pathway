#if !os(visionOS)
    import Combine
    @preconcurrency import ConvexMobile
    import Foundation

    struct PathwayConvexSession: Sendable {
        let idToken: String
    }

    @MainActor
    private final class PathwayConvexAuthProvider: AuthProvider {
        private let credentials: any PathwayAuthenticating
        private let jwtTemplate: String

        init(
            credentials: any PathwayAuthenticating,
            jwtTemplate: String = AppConfiguration.convexJWTTemplate
        ) {
            self.credentials = credentials
            self.jwtTemplate = jwtTemplate
        }

        func login(
            onIdToken: @Sendable @escaping (String?) -> Void
        ) async throws -> PathwayConvexSession {
            try await session(onIdToken: onIdToken)
        }

        func loginFromCache(
            onIdToken: @Sendable @escaping (String?) -> Void
        ) async throws -> PathwayConvexSession {
            try await session(onIdToken: onIdToken)
        }

        func logout() async throws {
            // Clerk remains owned by PathwayAuthProvider. This only clears Convex's auth callback.
        }

        nonisolated func extractIdToken(from authResult: PathwayConvexSession) -> String {
            authResult.idToken
        }

        private func session(
            onIdToken: @Sendable @escaping (String?) -> Void
        ) async throws -> PathwayConvexSession {
            let token = try await credentials.token(template: jwtTemplate)
            onIdToken(token)
            return PathwayConvexSession(idToken: token)
        }
    }

    @MainActor
    final class PathwayConvexClient {
        private let client: ConvexClientWithAuth<PathwayConvexSession>

        init(deploymentURL: URL, credentials: any PathwayAuthenticating) {
            client = ConvexClientWithAuth(
                deploymentUrl: deploymentURL.absoluteString,
                authProvider: PathwayConvexAuthProvider(credentials: credentials)
            )
        }

        func authenticate() async throws {
            switch await client.loginFromCache() {
            case .success:
                return
            case let .failure(error):
                throw error
            }
        }

        func disconnect() async {
            await client.logout()
        }

        func companiesPublisher() -> AnyPublisher<[PathwayCompany], ClientError> {
            client.subscribe(to: "companies:listMine", yielding: [PathwayCompany].self)
        }

        func provisionCurrentUser() async throws -> PathwayCompany {
            try await client.mutation("companies:provisionCurrentUser")
        }

        func bootstrapCompany(
            companyId: String,
            cursor: String?
        ) async throws -> PathwaySyncBootstrapPage {
            try await query(
                "sync:bootstrap",
                with: [
                    "companyId": companyId,
                    "cursor": cursor,
                    "pageSize": 100
                ]
            )
        }

        func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, ClientError> {
            client.subscribe(
                to: "sync:latestVersion",
                with: ["companyId": companyId],
                yielding: PathwaySyncHead.self
            )
        }

        func listChanges(
            companyId: String,
            cursor: Int
        ) async throws -> PathwaySyncChangesPage {
            try await query(
                "sync:listChanges",
                with: [
                    "companyId": companyId,
                    "cursor": cursor,
                    "limit": 100
                ]
            )
        }

        private func query<Value: Decodable>(
            _ name: String,
            with args: [String: ConvexEncodable?]
        ) async throws -> Value {
            let publisher = client.subscribe(to: name, with: args, yielding: Value.self)
            for try await value in publisher.values {
                return value
            }
            throw CancellationError()
        }
    }
#endif
