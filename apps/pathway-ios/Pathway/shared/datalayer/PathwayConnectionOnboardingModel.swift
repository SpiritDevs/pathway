import Foundation
import Observation

struct PathwayAccountEnvironment: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let providerKind: String
    let endpoint: String
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["environmentId"]?.stringValue else { return nil }
        self.id = id
        label = fields["label"]?.stringValue ?? id
        providerKind = fields["endpoint"]?.objectValue?["providerKind"]?.stringValue ?? "manual"
        endpoint = fields["endpoint"]?.objectValue?["httpBaseUrl"]?.stringValue ?? ""
    }
}

struct PathwayConnectionSource: Sendable {
    var saved: @Sendable (String) async throws -> [PathwayDirectConnectionSummary]
    var pair: @Sendable (PathwayPairingInput, String) async throws -> PathwayDirectConnectionSummary
    var forget: @Sendable (String, String) async throws -> Void
    var request: @Sendable (String, String, String, String, JSONValue?) async throws -> JSONValue
    var setUseForConnections: @Sendable (Bool, String, String) async throws -> Void
    var ensureManagedRelay: @Sendable (String, String) async throws -> Void

    init(direct: PathwayDirectConnections) {
        saved = { try await direct.saved(accountKey: $0) }
        pair = { try await direct.pair(input: $0, accountKey: $1) }
        forget = { try await direct.forget(environmentID: $0, accountKey: $1) }
        request = { try await direct.request(environmentID: $0, accountKey: $1, method: $2, path: $3, payload: $4) }
        setUseForConnections = { try await direct.setUseForConnections($0, environmentID: $1, accountKey: $2) }
        ensureManagedRelay = { try await direct.ensureManagedRelay(environmentID: $0, accountKey: $1) }
    }
}

@MainActor @Observable
final class PathwayConnectionOnboardingModel {
    typealias RelayRequest = @MainActor (String, String, JSONValue?) async throws -> JSONValue
    typealias CloudRequest = @MainActor (String, String, JSONValue) async throws -> JSONValue
    private(set) var accountKey = ""
    private(set) var environments: [PathwayAccountEnvironment] = []
    private(set) var directConnections: [PathwayDirectConnectionSummary] = []
    private(set) var selected: PathwayDirectConnectionSummary?
    private(set) var localProjects: [JSONValue] = []
    private(set) var linkState: JSONValue?
    private(set) var busy = false
    private(set) var progress: String?
    var errorMessage: String?
    var completionMessage: String?
    private let relayURL: URL
    private let relayRequest: RelayRequest
    private let cloudRequest: CloudRequest
    private let source: PathwayConnectionSource
    private var generation = UUID()

    init(relayURL: URL, relayRequest: @escaping RelayRequest, cloudRequest: @escaping CloudRequest,
         direct: PathwayDirectConnections = .shared) {
        self.relayURL = relayURL
        self.relayRequest = relayRequest
        self.cloudRequest = cloudRequest
        source = PathwayConnectionSource(direct: direct)
    }

    init(relayURL: URL, relayRequest: @escaping RelayRequest, cloudRequest: @escaping CloudRequest, source: PathwayConnectionSource) {
        self.relayURL = relayURL
        self.relayRequest = relayRequest
        self.cloudRequest = cloudRequest
        self.source = source
    }

    func clear() {
        generation = UUID()
        accountKey = ""
        environments = []
        directConnections = []
        selected = nil
        localProjects = []
        linkState = nil
        busy = false
        progress = nil
        errorMessage = nil
        completionMessage = nil
    }

    func load(accountKey: String) async {
        if self.accountKey != accountKey { clear(); self.accountKey = accountKey }
        guard !accountKey.isEmpty else { return }
        await perform("Loading connections") { token in
            let saved = try await self.source.saved(accountKey)
            try self.check(token)
            self.directConnections = saved
            try await self.refresh(token)
        }
    }

    func pair(address: String, token: String) async {
        await perform("Pairing with server") { operation in
            let input = try PathwayPairingInput(address: address, token: token)
            let paired = try await self.source.pair(input, self.accountKey)
            try self.check(operation)
            self.selected = paired
            let saved = try await self.source.saved(self.accountKey)
            try self.check(operation)
            self.directConnections = saved
            try await self.readSelected(operation)
        }
    }

    func select(_ connection: PathwayDirectConnectionSummary) async {
        selected = connection
        localProjects = []
        linkState = nil
        completionMessage = nil
        await perform("Reading server") { try await self.readSelected($0) }
    }

    func useDirect(_ enabled: Bool, connection: PathwayDirectConnectionSummary) async {
        await perform("Updating connection preference") { token in
            try await self.source.setUseForConnections(enabled, connection.id, self.accountKey)
            try self.check(token)
            let saved = try await self.source.saved(self.accountKey)
            try self.check(token)
            self.directConnections = saved
            self.selected = saved.first { $0.id == connection.id }
        }
    }

    func forget(_ connection: PathwayDirectConnectionSummary) async {
        await perform("Removing direct access from this device") { token in
            try await self.source.forget(connection.environmentID, self.accountKey)
            try self.check(token)
            self.directConnections.removeAll { $0.id == connection.id }
            if self.selected?.id == connection.id { self.selected = nil; self.localProjects = []; self.linkState = nil }
        }
    }

    /// Account-level removal is available even when the source server is offline. Source unlink is
    /// a separate explicit operation because it stops activity publishing for every client.
    func removeFromAccount(_ environment: PathwayAccountEnvironment) async {
        await perform("Removing account connection") { token in
            do {
                _ = try await self.relayRequest("DELETE", "/v1/client/environment-links/\(Self.pathID(environment.id))", nil)
            } catch {
                let original = error
                try self.check(token)
                try await self.refresh(token)
                if self.environments.contains(where: { $0.id == environment.id }) { throw original }
            }
            try self.check(token)
            try await self.refresh(token)
        }
    }

    func unlinkSelectedServer() async {
        guard let selected else { return }
        await perform("Unlinking server") { token in
            _ = try await self.source.request(selected.id, self.accountKey, "POST", "/api/connect/unlink", .object([:]))
            try self.check(token)
            self.linkState = .object(["linked": .bool(false)])
            _ = try await self.relayRequest("DELETE", "/v1/client/environment-links/\(Self.pathID(selected.id))", nil)
            try self.check(token)
            try await self.refresh(token)
        }
    }

    func finish(companyID: String, projectIDs: Set<String>, roles: [JSONValue], registrations: [JSONValue], managed: Bool) async {
        guard let selected, !companyID.isEmpty else { return }
        await perform("Linking server to your account") { token in
            let key = self.accountKey
            let active = registrations.first {
                $0.objectValue?["environmentId"]?.stringValue == selected.id && $0.objectValue?["state"]?.stringValue == "active"
            }
            let roleIDs = active?.objectValue?["serviceRoleIds"]?.arrayValue ?? Self.serviceRole(roles).map { [.string($0)] }
            guard let roleIDs, !roleIDs.isEmpty else {
                throw PathwayConnectError.invalidConfiguration("This workspace needs an environment service role before this server can be registered.")
            }
            let state = try await self.source.request(selected.id, key, "GET", "/api/connect/link-state", nil)
            try self.check(token)
            self.linkState = state
            try await self.refresh(token)
            let alreadyLinked = self.linkState?.objectValue?["linked"]?.boolValue == true
            let subject = key.split(separator: "\n").last.map(String.init)
            if alreadyLinked && (
                !self.environments.contains(where: { $0.id == selected.id }) ||
                self.linkState?.objectValue?["cloudUserId"]?.stringValue != subject
            ) {
                throw PathwayConnectError.invalidConfiguration("This server is linked to another account or its account link was removed. Unlink the server before linking it to this account.")
            }
            // Preserve an existing server link. Reconfiguring its tunnel requires explicit unlink.
            if !alreadyLinked {
                guard selected.canManageLink else {
                    throw PathwayConnectError.invalidConfiguration("Use an administrator pairing link with relay:write permission to link this server.")
                }
                if managed {
                    self.progress = "Installing the server's Pathway Connect tunnel"
                    try await self.source.ensureManagedRelay(selected.id, key)
                    try self.check(token)
                }
                try await self.link(selected, accountKey: key, managed: managed, token: token)
            }
            try self.check(token)
            self.progress = "Registering server with workspace"
            let info = try await self.source.request(selected.id, key, "GET", "/api/connect/registration-info", nil)
            try self.check(token)
            guard let fields = info.objectValue, let descriptor = fields["descriptor"],
                  descriptor.objectValue?["environmentId"]?.stringValue == selected.id,
                  let thumbprint = fields["publicKeyThumbprint"], fields["relayLinkState"]?.stringValue == "linked" else {
                throw PathwayConnectError.invalidResponse
            }
            _ = try await self.cloudRequest("mutation", "environments:register", .object([
                "companyId": .string(companyID), "environmentId": .string(selected.id), "descriptor": descriptor,
                "publicKeyThumbprint": thumbprint, "relayLinkState": .string("linked"),
                "managedEndpointAvailable": fields["managedEndpointAvailable"] ?? .bool(false),
                "serviceRoleIds": .array(roleIDs), "teamIds": active?.objectValue?["teamIds"] ?? .array([])
            ]))
            try self.check(token)
            self.progress = "Adding selected projects to workspace"
            var added = 0
            for project in self.localProjects where projectIDs.contains(project.objectValue?["id"]?.stringValue ?? "") {
                guard let value = project.objectValue, let id = value["id"], let name = value["title"] else { continue }
                _ = try await self.cloudRequest("mutation", "cloudProjects:ensureEnvironmentProject", .object([
                    "companyId": .string(companyID), "environmentId": .string(selected.id), "localProjectId": id,
                    "localWorkspaceRoot": value["workspaceRoot"] ?? .null, "repositoryIdentity": value["repositoryIdentity"] ?? .null,
                    "name": name, "matchRepository": .bool(true)
                ]))
                try self.check(token)
                added += 1
            }
            if fields["managedEndpointAvailable"]?.boolValue == true {
                try await self.source.setUseForConnections(false, selected.id, key)
                try self.check(token)
                let saved = try await self.source.saved(key)
                try self.check(token)
                self.directConnections = saved
                self.selected = self.directConnections.first { $0.id == selected.id }
            }
            self.completionMessage = "Server registered. \(added) selected project\(added == 1 ? "" : "s") added. Threads appear as the server syncs."
            try await self.readSelected(token)
            try await self.refresh(token)
        }
    }

    static func serviceRole(_ values: [JSONValue]) -> String? {
        let required: Set<String> = ["company.read", "projects.read", "issues.read", "workflow.manage", "environments.read"]
        return values.compactMap { value -> (String, Int)? in
            guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
            let permissions = Set(fields["permissions"]?.arrayValue?.compactMap(\.stringValue) ?? [])
            return required.isSubset(of: permissions) ? (id, permissions.count) : nil
        }.sorted { $0.1 == $1.1 ? $0.0 < $1.0 : $0.1 < $1.1 }.first?.0
    }

    private func link(_ selected: PathwayDirectConnectionSummary, accountKey key: String, managed: Bool, token: UUID) async throws {
        let flags: [String: JSONValue] = ["notificationsEnabled": .bool(true), "liveActivitiesEnabled": .bool(true), "managedTunnelsEnabled": .bool(managed)]
        let challenge = try await relayRequest("POST", "/v1/client/environment-link-challenges", .object(flags))
        try check(token)
        guard let challengeValue = challenge.objectValue?["challenge"] else { throw PathwayConnectError.invalidResponse }
        guard var ws = URLComponents(url: selected.baseURL, resolvingAgainstBaseURL: false) else { throw PathwayConnectError.invalidURL }
        ws.scheme = selected.baseURL.scheme == "https" ? "wss" : "ws"
        ws.path = "/ws"
        guard let socketURL = ws.url else { throw PathwayConnectError.invalidURL }
        let provider = managed ? "cloudflare_tunnel" : "manual"
        let localPort = linkState?.objectValue?["currentLocalHttpPort"]?.intValue
            ?? selected.baseURL.port ?? (selected.baseURL.scheme == "https" ? 443 : 80)
        let proof = try await source.request(selected.id, key, "POST", "/api/connect/link-proof", .object([
            "challenge": challengeValue, "relayIssuer": .string(relayURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
            "endpoint": .object(["httpBaseUrl": .string(selected.baseURL.absoluteString), "wsBaseUrl": .string(socketURL.absoluteString), "providerKind": .string(provider)]),
            "origin": .object(["localHttpHost": .string("127.0.0.1"), "localHttpPort": .number(Double(localPort))])
        ]))
        try check(token)
        guard proof.stringValue != nil else { throw PathwayConnectError.invalidResponse }
        var linkArgs = flags
        linkArgs["deviceId"] = .string(selected.id)
        linkArgs["proof"] = proof
        let result = try await relayRequest("POST", "/v1/client/environment-links", .object(linkArgs))
        try check(token)
        guard let link = result.objectValue, link["environmentId"]?.stringValue == selected.id,
              link["endpoint"]?.objectValue?["providerKind"]?.stringValue == provider,
              let issuer = link["relayIssuer"], let user = link["cloudUserId"], let credential = link["environmentCredential"],
              let mint = link["cloudMintPublicKey"], let runtime = link["endpointRuntime"] else { throw PathwayConnectError.environmentMismatch }
        do {
            let applied = try await source.request(selected.id, key, "POST", "/api/connect/relay-config", .object([
                "relayUrl": .string(relayURL.absoluteString), "relayIssuer": issuer, "cloudUserId": user,
                "environmentCredential": credential, "cloudMintPublicKey": mint, "endpointRuntime": runtime
            ]))
            try check(token)
            guard applied.objectValue?["ok"]?.boolValue == true else { throw PathwayConnectError.invalidResponse }
            linkState = .object(["linked": .bool(true), "managedTunnelActive": .bool(managed)])
        } catch {
            if case PathwayConnectError.response(status: 409, message: _, traceID: _) = error {
                try check(token)
                _ = try? await relayRequest("DELETE", "/v1/client/environment-links/\(Self.pathID(selected.id))", nil)
            }
            throw error
        }
    }

    private func readSelected(_ token: UUID) async throws {
        guard let selected else { return }
        let state = try await source.request(selected.id, accountKey, "GET", "/api/connect/link-state", nil)
        try check(token)
        linkState = state
        let shell = try await source.request(selected.id, accountKey, "GET", "/api/orchestration/shell", nil)
        try check(token)
        guard let projects = shell.objectValue?["projects"]?.arrayValue else { throw PathwayConnectError.invalidResponse }
        localProjects = projects
    }

    private func refresh(_ token: UUID) async throws {
        let result = try await relayRequest("GET", "/v1/environments", nil)
        try check(token)
        guard let values = result.objectValue?["environments"]?.arrayValue else { throw PathwayConnectError.invalidResponse }
        environments = values.compactMap(PathwayAccountEnvironment.init)
    }

    private func perform(_ message: String, operation: (UUID) async throws -> Void) async {
        guard !busy, !accountKey.isEmpty else { return }
        let token = generation
        busy = true
        progress = message
        errorMessage = nil
        completionMessage = nil
        defer { if generation == token { busy = false; progress = nil } }
        do { try await operation(token) }
        catch { if generation == token, !(error is CancellationError) { errorMessage = error.localizedDescription } }
    }

    private func check(_ token: UUID) throws {
        guard token == generation, !Task.isCancelled else { throw CancellationError() }
    }

    private static func pathID(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}
