import Foundation
@testable import Pathway
import Testing

@Suite(.serialized)
@MainActor struct PathwayLaunchNotificationTests {
    @Test(.timeLimit(.minutes(1)))
    func heldLiveActivityRegistrationDoesNotDelayTheWorkspace() async throws {
        let auth = HeldRelayAuth()
        let (model, cleanup) = try Self.signedInModel(auth: auth, liveActivities: true)
        defer { cleanup() }
        // Before the fix this never returned while the relay request was held.
        await model.restoreSession()
        #expect(model.isAccountReady)
        var relayRequests = auth.relayRequests.makeAsyncIterator()
        _ = await relayRequests.next()
        #expect(!PathwayNotifications.shared.registered)

        // Signing out while the registration is held must not land it for the old account.
        model.sessionDidEnd()
        auth.failRelayRequests()
        await PathwayNotifications.shared.stop()
        #expect(!PathwayNotifications.shared.registered)
        #expect(!model.isAccountReady)
    }

    @Test(.timeLimit(.minutes(1)))
    func disabledLiveActivitiesMakeNoRelayRequestAtLaunch() async throws {
        let auth = HeldRelayAuth()
        let (model, cleanup) = try Self.signedInModel(auth: auth, liveActivities: false)
        defer { cleanup() }
        await model.restoreSession()
        #expect(model.isAccountReady)
        #expect(auth.relayRequestCount == 0)
        model.sessionDidEnd()
        auth.failRelayRequests()
        await PathwayNotifications.shared.stop()
    }

    private static func signedInModel(auth: HeldRelayAuth, liveActivities: Bool) throws -> (PathwayAppModel, () -> Void) {
        let directory = PathwayAccountStorage.directory(for: "\(HeldRelayAuth.issuer)\n\(auth.subject)")
        let key = "pathway.notifications.\(directory.lastPathComponent)"
        var preferences = PathwayNotificationPreferences()
        preferences.liveActivitiesEnabled = liveActivities
        UserDefaults.standard.set(try JSONEncoder().encode(preferences), forKey: key)
        let model = PathwayAppModel(authProvider: auth, relayURL: URL(string: "https://relay.invalid"), relayJWTTemplate: "relay")
        return (model, {
            UserDefaults.standard.removeObject(forKey: key)
            try? FileManager.default.removeItem(at: directory)
        })
    }
}

/// Answers account token reads at once and holds relay token reads until told to fail them.
@MainActor private final class HeldRelayAuth: PathwayAuthenticating {
    static let issuer = "https://pathway-launch-tests.invalid"
    let subject = "launch-\(UUID().uuidString)"
    var hasActiveSession = true
    var onSessionChanged: ((Bool) -> Void)?
    let relayRequests: AsyncStream<Void>
    private let relayEvents: AsyncStream<Void>.Continuation
    private var held: [CheckedContinuation<String, any Error>] = []
    private var failsRelay = false
    private(set) var relayRequestCount = 0

    init() { (relayRequests, relayEvents) = AsyncStream.makeStream() }

    func startHostedSignIn() async throws { hasActiveSession = true; onSessionChanged?(true) }
    func signOut() async throws { hasActiveSession = false; onSessionChanged?(false) }

    func token(template: String?) async throws -> String {
        guard template == "relay" else { return try accountToken() }
        relayRequestCount += 1
        relayEvents.yield(())
        if failsRelay { throw URLError(.userAuthenticationRequired) }
        return try await withCheckedThrowingContinuation { held.append($0) }
    }

    func failRelayRequests() {
        failsRelay = true
        let waiting = held
        held = []
        waiting.forEach { $0.resume(throwing: URLError(.userAuthenticationRequired)) }
    }

    private func accountToken() throws -> String {
        func encode(_ value: Data) -> String {
            value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return "\(encode(Data(#"{"alg":"none"}"#.utf8))).\(encode(try JSONSerialization.data(withJSONObject: ["iss": Self.issuer, "sub": subject]))).signature"
    }
}
