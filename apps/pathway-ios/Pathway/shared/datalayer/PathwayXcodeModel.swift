import Foundation
import Observation

/// Xcode setup on one environment's Mac: the Apple IDs that may authorize it, the environment's
/// Apple ID session and its Xcode inventory and job. Streams run only inside `observeAccounts` and
/// `observeLive`, which the screen ties to its visible lifetime.
@MainActor
@Observable
final class PathwayXcodeModel {
    typealias Request = @Sendable (_ method: String, _ payload: JSONValue, _ timeout: Duration) async throws -> JSONValue
    typealias Subscribe = @Sendable (_ method: String, _ payload: JSONValue) async -> AsyncThrowingStream<JSONValue, Error>
    typealias CloudSubscribe = @MainActor (_ name: String, _ arguments: JSONValue) -> AsyncThrowingStream<JSONValue, Error>

    let environmentID: String
    let environmentCompanyID: String
    private let accountsCompanyID: String?
    private let request: Request
    private let subscribe: Subscribe
    private let cloudSubscribe: CloudSubscribe
    private let defaults: UserDefaults

    private(set) var accounts: [PathwayAppleAccount]?
    private(set) var accountsError: String?
    private var chosenAccountID: String?

    private(set) var session: PathwayAppleIdSession?
    private(set) var sessionError: String?
    private(set) var view = PathwayXcodeView()
    private(set) var viewError: String?
    /// Bumped by "Try again" so the screen restarts a failed stream.
    private(set) var liveGeneration = 0

    /// The command in flight, keyed so its button can say what it is doing.
    private(set) var pending: String?
    private(set) var actionError: String?
    /// The host stays in needs-admin while its prompt is open; this remembers which step was approved.
    private(set) var approvedStep: String?
    /// The session expiry the user asked to replace, for a session Apple has already rejected.
    var replacingSession: Double?

    init(
        environmentID: String,
        environmentCompanyID: String,
        accountsCompanyID: String?,
        request: @escaping Request,
        subscribe: @escaping Subscribe,
        cloudSubscribe: @escaping CloudSubscribe,
        defaults: UserDefaults = .standard
    ) {
        self.environmentID = environmentID
        self.environmentCompanyID = environmentCompanyID
        self.accountsCompanyID = accountsCompanyID
        self.request = request
        self.subscribe = subscribe
        self.cloudSubscribe = cloudSubscribe
        self.defaults = defaults
        chosenAccountID = defaults.string(forKey: Self.rememberedAccountKey + environmentID)
    }

    static let rememberedAccountKey = "pathway:xcode:account:"

    var account: PathwayAppleAccount? {
        guard let accounts, let id = PathwayXcodeRules.pickAccountID(accounts, remembered: chosenAccountID) else { return nil }
        return accounts.first { $0.id == id }
    }

    var target: PathwayXcodeTarget? {
        account.map {
            PathwayXcodeTarget(
                companyId: PathwayXcodeRules.rpcCompanyID($0.scope, environmentCompanyID: environmentCompanyID),
                accountId: $0.id
            )
        }
    }

    var status: PathwayXcodeStatus? { view.status }
    var job: PathwayXcodeJob? { view.job }

    var signInAgain: Bool {
        if case let .authenticated(expiresAt) = session { return replacingSession == expiresAt }
        return false
    }

    /// A retained session snapshot is stale once its stream fails; the sign-in shows the error.
    var signedIn: Bool { session?.isAuthenticated == true && sessionError == nil && !signInAgain }

    var ready: Bool {
        guard let status else { return false }
        return PathwayXcodeRules.usable(status) != nil && !PathwayXcodeRules.isActive(job)
    }

    var awaitingAdminPrompt: Bool {
        let key = PathwayXcodeRules.adminStepKey(job)
        return key != nil && PathwayXcodeRules.nextAdminApproval(approvedStep, job: job) == key
    }

    func choose(accountID: String) {
        guard accountID != account?.id else { return }
        chosenAccountID = accountID
        defaults.set(accountID, forKey: Self.rememberedAccountKey + environmentID)
        resetLive()
    }

    func tryAgain() {
        resetLive()
        liveGeneration += 1
    }

    // MARK: Streams

    /// Apple IDs from Cloud. An organization workspace also lists the company's shared accounts.
    func observeAccounts() async {
        let arguments: JSONValue = accountsCompanyID.map { .object(["companyId": .string($0)]) } ?? .object([:])
        do {
            for try await value in cloudSubscribe("appleIntegrations:listAccounts", arguments) {
                accounts = try Self.decode([PathwayAppleAccount].self, from: value)
                accountsError = nil
            }
        } catch is CancellationError {
        } catch {
            accountsError = "Could not load Apple accounts."
        }
    }

    /// Both environment streams for one account; they close when the caller's task is cancelled.
    func observeLive(_ target: PathwayXcodeTarget) async {
        let payload = JSONValue.object(target.payload)
        async let session: Void = observeSession(payload, target: target)
        async let xcode: Void = observeXcode(payload, target: target)
        _ = await (session, xcode)
    }

    private func observeSession(_ payload: JSONValue, target: PathwayXcodeTarget) async {
        do {
            for try await value in await subscribe("apple.id.subscribe", payload) {
                guard self.target == target else { return }
                if value.objectValue?["_pathwayTransport"] != nil { continue }
                session = try Self.decode(PathwayAppleIdSession.self, from: value)
                sessionError = nil
                if case .authenticated = session, !signInAgain { replacingSession = nil }
            }
        } catch is CancellationError {
        } catch {
            guard self.target == target, !Task.isCancelled else { return }
            sessionError = error.localizedDescription
        }
    }

    private func observeXcode(_ payload: JSONValue, target: PathwayXcodeTarget) async {
        do {
            for try await value in await subscribe("xcode.subscribe", payload) {
                guard self.target == target else { return }
                if value.objectValue?["_pathwayTransport"] != nil { continue }
                apply(try Self.decode(PathwayXcodeUpdate.self, from: value))
            }
        } catch is CancellationError {
        } catch {
            guard self.target == target, !Task.isCancelled else { return }
            viewError = error.localizedDescription
        }
    }

    func apply(_ update: PathwayXcodeUpdate) {
        view = view.applying(update)
        viewError = nil
        let kept = PathwayXcodeRules.nextAdminApproval(approvedStep, job: view.job)
        if kept != approvedStep { approvedStep = kept }
    }

    private func resetLive() {
        session = nil
        sessionError = nil
        view = PathwayXcodeView()
        viewError = nil
        approvedStep = nil
        replacingSession = nil
        actionError = nil
    }

    // MARK: Apple ID

    func signIn(password: String) async {
        guard let target else { return }
        var payload = target.payload
        payload["password"] = .string(password)
        // SRP and Apple's challenge lookup can outlast the default request timeout.
        await run("start", fallback: "Apple sign-in failed.", method: "apple.id.start", payload: payload, timeout: .seconds(120))
    }

    @discardableResult
    func complete(flowID: String, code: String) async -> Bool {
        guard let target else { return false }
        var payload = target.payload
        payload["flowId"] = .string(flowID)
        payload["code"] = .string(code)
        return await run("complete", fallback: "That code did not work. Check it and try again.",
                         method: "apple.id.complete", payload: payload, timeout: .seconds(120))
    }

    func requestCode(flowID: String, phoneNumberID: Int) async {
        guard let target else { return }
        var payload = target.payload
        payload["flowId"] = .string(flowID)
        payload["phoneNumberId"] = .number(Double(phoneNumberID))
        await run("send", fallback: "Could not send a code.", method: "apple.id.requestCode", payload: payload)
    }

    func cancelSignIn(flowID: String) async {
        guard let target else { return }
        var payload = target.payload
        payload["flowId"] = .string(flowID)
        await run("cancel-sign-in", fallback: "Could not cancel sign-in.", method: "apple.id.cancel", payload: payload)
    }

    func signOut() async {
        guard let target else { return }
        await run("sign-out", fallback: "Could not sign out.", method: "apple.id.signOut", payload: target.payload)
    }

    // MARK: Xcode

    func install(versionID: String, platforms: [PathwayXcodePlatform]) async {
        guard let target else { return }
        var payload = target.payload
        payload["versionId"] = .string(versionID)
        payload["platforms"] = .array(platforms.map { .string($0.rawValue) })
        await run("install", fallback: "Could not start the install.", method: "xcode.install", payload: payload)
    }

    func cancel(job: PathwayXcodeJob) async {
        await jobCommand("cancel", fallback: "Could not cancel.", method: "xcode.cancel", job: job)
    }

    func retry(job: PathwayXcodeJob) async {
        approvedStep = nil
        await jobCommand("retry", fallback: "Could not retry.", method: "xcode.retry", job: job)
    }

    func approve(job: PathwayXcodeJob) async {
        let key = PathwayXcodeRules.adminStepKey(job)
        if await jobCommand("approve", fallback: "Could not ask the Mac for approval.", method: "xcode.approve", job: job) {
            approvedStep = PathwayXcodeRules.nextAdminApproval(key, job: self.job)
        }
    }

    func select(path: String) async {
        guard let target else { return }
        var payload = target.payload
        payload["path"] = .string(path)
        await run(path, fallback: "Could not select this Xcode.", method: "xcode.select", payload: payload)
    }

    @discardableResult
    func installRuntimes(path: String, platforms: [PathwayXcodePlatform]) async -> Bool {
        guard let target else { return false }
        var payload = target.payload
        payload["path"] = .string(path)
        payload["platforms"] = .array(platforms.map { .string($0.rawValue) })
        return await run("runtimes", fallback: "Could not add platforms.", method: "xcode.installRuntimes", payload: payload)
    }

    @discardableResult
    private func jobCommand(_ key: String, fallback: String, method: String, job: PathwayXcodeJob) async -> Bool {
        guard let target else { return false }
        var payload = target.payload
        payload["jobId"] = .string(job.id)
        return await run(key, fallback: fallback, method: method, payload: payload)
    }

    /// One command at a time, keeping its pending key and a safe error message.
    @discardableResult
    private func run(
        _ key: String, fallback: String, method: String, payload: [String: JSONValue], timeout: Duration = .seconds(30)
    ) async -> Bool {
        guard pending == nil else { return false }
        pending = key
        actionError = nil
        defer { pending = nil }
        do {
            _ = try await request(method, .object(payload), timeout)
            return true
        } catch is CancellationError {
            return false
        } catch {
            actionError = Self.describe(error, fallback: fallback)
            return false
        }
    }

    /// Xcode, Apple and environment-authorization errors carry a message that is safe to show.
    static func describe(_ error: Error, fallback: String) -> String {
        switch error {
        case let error as PathwayRPCError: error.errorDescription ?? fallback
        case is URLError: "The environment is not connected."
        default: fallback
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
}
