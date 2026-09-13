#if !os(visionOS)
    import Combine
    @preconcurrency import ConvexMobile
    import Foundation

    struct PathwayConvexSession: Sendable {
        let idToken: String
    }

    enum PathwayConvexArguments {
        static func bootstrap(companyID: String, cursor: String?) -> [String: ConvexEncodable?] {
            [
                "companyId": companyID,
                "cursor": cursor,
                "pageSize": 100.0
            ]
        }

        static func changes(companyID: String, cursor: Int) -> [String: ConvexEncodable?] {
            [
                "companyId": companyID,
                "cursor": Double(cursor),
                "limit": 100.0
            ]
        }
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

        func companiesPublisher() -> AnyPublisher<[PathwayCompany], Error> {
            Self.erasingSubscriptionErrors(client.subscribe(to: "companies:listMine", yielding: [PathwayCompany].self))
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
                with: PathwayConvexArguments.bootstrap(companyID: companyId, cursor: cursor)
            )
        }

        func syncHeadPublisher(companyId: String) -> AnyPublisher<PathwaySyncHead, Error> {
            Self.erasingSubscriptionErrors(client.subscribe(
                to: "sync:latestVersion",
                with: ["companyId": companyId],
                yielding: PathwaySyncHead.self
            ))
        }

        func listChanges(
            companyId: String,
            cursor: Int
        ) async throws -> PathwaySyncChangesPage {
            try await query(
                "sync:listChanges",
                with: PathwayConvexArguments.changes(companyID: companyId, cursor: cursor)
            )
        }

        func applyIssueOperations(companyID: String, operations: JSONValue) async throws -> JSONValue {
            try await client.mutation("sync:applyOperations", with: [
                "companyId": companyID,
                "operations": PathwayConvexJSON(value: operations)
            ])
        }

        func issueRequest(kind: String, name: String, arguments: JSONValue) async throws -> JSONValue {
            do {
            switch kind {
            case "action": return try await client.action(name, with: PathwayConvexJSON.arguments(arguments))
            case "mutation": return try await client.mutation(name, with: PathwayConvexJSON.arguments(arguments))
            default: return try await query(name, with: PathwayConvexJSON.arguments(arguments))
            }
            } catch let error as ClientError {
                if name.hasPrefix("threadQueue:"), case let .ConvexError(data) = error,
                   let bytes = data.data(using: .utf8),
                   let fields = try? JSONDecoder().decode(JSONValue.self, from: bytes).objectValue {
                    throw PathwayThreadQueueRejected(code: fields["code"]?.stringValue,
                        message: fields["message"]?.stringValue ?? "The queued request was rejected.")
                }
                throw error
            }
        }

        func publisher(name: String, arguments: JSONValue) -> AnyPublisher<JSONValue, Error> {
            Self.erasingSubscriptionErrors(
                client.subscribe(to: name, with: PathwayConvexJSON.arguments(arguments), yielding: JSONValue.self)
            )
        }

        // Convex emits failures on its worker threads. Error conversion must not inherit MainActor.
        nonisolated static func erasingSubscriptionErrors<P: Publisher>(_ publisher: P) -> AnyPublisher<P.Output, Error> {
            publisher.mapError { $0 as Error }.eraseToAnyPublisher()
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

    /// The issue protocol uses JSON numbers, including its versions and sequences.
    /// Encoding the complete value preserves null fields and avoids Swift Int's Convex bigint encoding.
    private struct PathwayConvexJSON: ConvexEncodable, Sendable {
        let value: JSONValue

        func convexEncode() throws -> String {
            String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        }

        nonisolated static func arguments(_ value: JSONValue) -> [String: ConvexEncodable?] {
            (value.objectValue ?? [:]).mapValues { PathwayConvexJSON(value: $0) }
        }
    }
#endif
