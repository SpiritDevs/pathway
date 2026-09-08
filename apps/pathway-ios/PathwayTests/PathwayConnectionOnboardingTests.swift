import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayConnectionOnboardingTests {
    @Test func pairingLinksDiscardCredentialsFromSavedOrigin() throws {
        let input = try PathwayPairingInput(address: "https://app.pathwayos.dev/pair?host=http%3A%2F%2F192.168.1.10%3A4000&label=Work#token=one%2Btime")
        #expect(input.baseURL.absoluteString == "http://192.168.1.10:4000")
        #expect(input.token == "one+time")
        #expect(try PathwayPairingInput(address: "https://server.test/?token=old", token: "manual").token == "manual")
        #expect(throws: (any Error).self) { try PathwayPairingInput(address: "file:///tmp/server#token=x") }
        #expect(throws: (any Error).self) { try PathwayPairingInput(address: "https://user:password@server.test#token=x") }
        #expect(throws: (any Error).self) { try PathwayPairingInput(address: "https://server.test") }
    }

    @Test func registrationChoosesLeastPrivilegeAndRequiresAllPermissions() {
        #expect(PathwayConnectionOnboardingModel.serviceRole([role("owner", extra: ["company.manage"]), role("service")]) == "service")
        #expect(PathwayConnectionOnboardingModel.serviceRole([.object(["id": .string("reader"), "permissions": .array([.string("company.read")])])]) == nil)
    }

    @Test func finishUsesRealSourceProofAccountLinkRegistrationAndSelectedBindings() async {
        let spy = OnboardingSourceSpy()
        var calls: [(String, JSONValue?)] = []
        var linked = false
        let model = makeModel(spy: spy, relay: { method, path, payload in
            calls.append((path, payload))
            if path == "/v1/environments" { return listing(linked) }
            if path.hasSuffix("challenges") { return .object(["challenge": .string("challenge")]) }
            if method == "POST" { linked = true; return linkResult() }
            return .null
        }, cloud: { _, name, args in calls.append((name, args)); return .string("created") })
        await model.load(accountKey: "issuer\nuser")
        await model.pair(address: "http://server.local:4000#token=pair", token: "")
        await model.finish(companyID: "company", projectIDs: ["project-a"], roles: [role("service")], registrations: [], managed: true)
        #expect(model.errorMessage == nil)
        #expect(model.completionMessage?.contains("1 selected project") == true)
        #expect(await spy.installed)
        let writes = calls.filter { $0.0 == "cloudProjects:ensureEnvironmentProject" }
        #expect(writes.count == 1)
        #expect(writes.first?.1?.objectValue?["localProjectId"] == .string("project-a"))
        #expect(calls.first { $0.0 == "environments:register" }?.1?.objectValue?["companyId"] == .string("company"))
        #expect(await spy.paths.contains("/api/connect/link-proof"))
        #expect(await spy.paths.contains("/api/connect/relay-config"))
        #expect(await spy.preferred == false)
        #expect(await spy.linkProofPayload?.objectValue?["origin"]?.objectValue?["localHttpPort"] == .number(3800))
    }

    @Test func sourceFailureNeverClaimsRegisteredAndConflictRollsBackAccountLink() async {
        let spy = OnboardingSourceSpy()
        await spy.setConflict()
        var calls: [String] = []
        let model = makeModel(spy: spy, relay: { method, path, _ in
            calls.append(method + " " + path)
            if path == "/v1/environments" { return listing(false) }
            if path.hasSuffix("challenges") { return .object(["challenge": .string("challenge")]) }
            var result = linkResult().objectValue!
            result["endpoint"] = .object(["providerKind": .string("manual")])
            return .object(result)
        }, cloud: { _, _, _ in Issue.record("Registration must not happen after source refusal"); return .null })
        await model.load(accountKey: "issuer\nuser")
        await model.pair(address: "http://server.local#token=pair", token: "")
        await model.finish(companyID: "company", projectIDs: [], roles: [role("service")], registrations: [], managed: false)
        #expect(model.errorMessage != nil)
        #expect(model.completionMessage == nil)
        #expect(calls.contains("DELETE /v1/client/environment-links/server"))
    }

    @Test func alreadyLinkedServerOutsideAccountIsNotRegistered() async {
        let spy = OnboardingSourceSpy()
        await spy.setLinked()
        let model = makeModel(spy: spy, relay: { _, _, _ in listing(false) }, cloud: { _, _, _ in
            Issue.record("Do not register a server linked outside this account"); return .null
        })
        await model.load(accountKey: "issuer\nuser")
        await model.pair(address: "http://server.local#token=pair", token: "")
        await model.finish(companyID: "company", projectIDs: [], roles: [role("service")], registrations: [], managed: false)
        #expect(model.errorMessage?.contains("another account") == true)
    }

    @Test func sourceSessionScopeIsRequiredOnlyWhenLinkingAndUnselectedProjectsStayLocal() async {
        let spy = OnboardingSourceSpy(admin: false)
        var mutations = 0
        let model = makeModel(spy: spy, relay: { _, _, _ in listing(false) }, cloud: { _, _, _ in mutations += 1; return .null })
        await model.load(accountKey: "issuer\nuser")
        await model.pair(address: "http://server.local#token=pair", token: "")
        await model.finish(companyID: "company", projectIDs: [], roles: [role("service")], registrations: [], managed: false)
        #expect(model.errorMessage?.contains("relay:write") == true)
        #expect(mutations == 0)
    }

    @Test func failedUnlinkIsConfirmedAgainstAccountAuthority() async {
        let spy = OnboardingSourceSpy()
        var removed = false
        let model = makeModel(spy: spy, relay: { method, _, _ in
            if method == "DELETE" { removed = true; throw URLError(.networkConnectionLost) }
            return listing(!removed)
        }, cloud: { _, _, _ in .null })
        await model.load(accountKey: "issuer\nuser")
        #expect(model.environments.count == 1)
        await model.removeFromAccount(model.environments[0])
        #expect(model.environments.isEmpty)
        #expect(model.errorMessage == nil)
        model.clear()
        #expect(model.accountKey.isEmpty && model.directConnections.isEmpty && model.selected == nil)
    }

    @Test func accountSwitchDropsALatePrivateConnectionRead() async {
        let gate = OnboardingReadGate()
        var source = PathwayConnectionSource(direct: PathwayDirectConnections())
        source.saved = { _ in await gate.read() }
        let model = PathwayConnectionOnboardingModel(relayURL: URL(string: "https://relay.test")!, relayRequest: { _, _, _ in
            Issue.record("A cleared account must not continue to relay discovery")
            return .null
        }, cloudRequest: { _, _, _ in .null }, source: source)
        let pending = Task { await model.load(accountKey: "issuer-a\nprivate-user") }
        await gate.waitUntilStarted()
        model.clear()
        await gate.release()
        await pending.value
        #expect(model.directConnections.isEmpty)
        #expect(model.environments.isEmpty)
        #expect(model.selected == nil && model.accountKey.isEmpty && !model.busy)
    }

    private func role(_ id: String, extra: [String] = []) -> JSONValue {
        .object(["id": .string(id), "permissions": .array((["company.read", "projects.read", "issues.read", "workflow.manage", "environments.read"] + extra).map(JSONValue.string))])
    }
    private func listing(_ linked: Bool) -> JSONValue {
        .object(["environments": .array(linked ? [.object(["environmentId": .string("server"), "label": .string("Server"), "endpoint": .object(["providerKind": .string("manual")])])] : [])])
    }
    private func linkResult() -> JSONValue {
        .object(["environmentId": .string("server"), "endpoint": .object(["providerKind": .string("cloudflare_tunnel")]),
            "relayIssuer": .string("https://relay.test"), "cloudUserId": .string("user"), "environmentCredential": .string("credential"),
            "cloudMintPublicKey": .string("public"), "endpointRuntime": .null])
    }
    private func makeModel(spy: OnboardingSourceSpy, relay: @escaping PathwayConnectionOnboardingModel.RelayRequest,
                           cloud: @escaping PathwayConnectionOnboardingModel.CloudRequest) -> PathwayConnectionOnboardingModel {
        var source = PathwayConnectionSource(direct: PathwayDirectConnections())
        source.saved = { _ in [await spy.summary()] }
        source.pair = { _, _ in await spy.summary() }
        source.forget = { _, _ in }
        source.request = { _, _, _, path, payload in try await spy.request(path, payload: payload) }
        source.ensureManagedRelay = { _, _ in await spy.install() }
        source.setUseForConnections = { enabled, _, _ in await spy.setPreferred(enabled) }
        return PathwayConnectionOnboardingModel(relayURL: URL(string: "https://relay.test")!, relayRequest: relay, cloudRequest: cloud, source: source)
    }
}

private actor OnboardingSourceSpy {
    var paths: [String] = []
    var installed = false
    var linkProofPayload: JSONValue?
    var preferred = true
    var linked = false
    var conflict = false
    let admin: Bool
    init(admin: Bool = true) { self.admin = admin }
    func install() { installed = true }
    func setPreferred(_ value: Bool) { preferred = value }
    func setLinked() { linked = true }
    func setConflict() { conflict = true }
    func summary() -> PathwayDirectConnectionSummary {
        .init(environmentID: "server", label: "Server", baseURL: URL(string: "http://server.local:4000")!,
            expiresAt: .distantFuture, scopes: admin ? ["relay:read", "relay:write", "orchestration:read"] : ["relay:read", "orchestration:read"], useForConnections: preferred)
    }
    func request(_ path: String, payload: JSONValue?) throws -> JSONValue {
        paths.append(path)
        switch path {
        case "/api/connect/link-state": return .object(["linked": .bool(linked), "cloudUserId": .string("user"), "currentLocalHttpPort": .number(3800)])
        case "/api/orchestration/shell": return .object(["projects": .array(["project-a", "project-b"].map {
            .object(["id": .string($0), "title": .string($0), "workspaceRoot": .string("/workspace/" + $0)])
        })])
        case "/api/connect/link-proof":
            linkProofPayload = payload
            return .string("proof")
        case "/api/connect/relay-config":
            if conflict { throw PathwayConnectError.response(status: 409, message: "Account conflict", traceID: nil) }
            linked = true
            return .object(["ok": .bool(true)])
        case "/api/connect/registration-info": return .object([
            "descriptor": .object(["environmentId": .string("server")]), "publicKeyThumbprint": .string("thumb"),
            "relayLinkState": .string("linked"), "managedEndpointAvailable": .bool(installed)
        ])
        default: throw URLError(.badURL)
        }
    }
}

private actor OnboardingReadGate {
    private var pending: CheckedContinuation<[PathwayDirectConnectionSummary], Never>?
    private var started: CheckedContinuation<Void, Never>?
    func read() async -> [PathwayDirectConnectionSummary] {
        await withCheckedContinuation { continuation in
            pending = continuation
            started?.resume()
            started = nil
        }
    }
    func waitUntilStarted() async {
        if pending != nil { return }
        await withCheckedContinuation { started = $0 }
    }
    func release() {
        pending?.resume(returning: [.init(environmentID: "private", label: "Private server", baseURL: URL(string: "https://private.test")!,
            expiresAt: .distantFuture, scopes: [], useForConnections: true)])
        pending = nil
    }
}
