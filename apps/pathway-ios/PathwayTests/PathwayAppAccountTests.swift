import Foundation
import Testing
@testable import Pathway

@Suite(.serialized)
@MainActor struct PathwayAppAccountTests {
    @Test func sessionEndedWhileTokenIsPendingCannotRestoreAnAccount() async throws {
        let auth = ControlledAccountAuth()
        let model = PathwayAppModel(authProvider: auth)
        var requests = auth.requests.makeAsyncIterator()
        let restore = Task { await model.restoreSession() }
        let pending = try #require(await requests.next())
        model.sessionDidEnd()
        await auth.release(pending, token: try Self.token(subject: "ended-\(UUID().uuidString)"))
        await restore.value
        #expect(model.authenticationState == .signedOut)
        #expect(!model.isAccountReady)
        #expect(model.accountID == nil)
        #expect(model.accountIdentity == nil)
        #expect(model.localStorageDirectory == nil)
    }

    @Test func newerActiveSessionEventRejectsPreviousAccountsPendingToken() async throws {
        let auth = ControlledAccountAuth()
        let model = PathwayAppModel(authProvider: auth)
        var requests = auth.requests.makeAsyncIterator()
        let restore = Task { await model.restoreSession() }
        let first = try #require(await requests.next())
        auth.emitActiveSession()
        let second = try #require(await requests.next())
        let subjectA = "account-a-\(UUID().uuidString)"
        await auth.release(first, token: try Self.token(subject: subjectA))
        await restore.value
        #expect(model.authenticationState == .signedIn)
        #expect(model.accountID == nil)
        #expect(model.localStorageDirectory == nil)
        #expect(!model.isAccountReady)
        // End B before releasing its gate so this test has no remaining asynchronous account preparation.
        model.sessionDidEnd()
        await auth.release(second, token: try Self.token(subject: "account-b-\(UUID().uuidString)"))
        #expect(model.accountID != subjectA)
        #expect(model.authenticationState == .signedOut)
    }

    @Test func activeSessionEventImmediatelyRevokesPreviouslyPreparedAccountReadiness() async throws {
        let auth = ControlledAccountAuth()
        let model = PathwayAppModel(authProvider: auth)
        var requests = auth.requests.makeAsyncIterator()
        let subject = "prepared-\(UUID().uuidString)"
        let directory = PathwayAccountStorage.directory(for: "\(Self.issuer)\n\(subject)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let restore = Task { await model.restoreSession() }
        let first = try #require(await requests.next())
        await auth.release(first, token: try Self.token(subject: subject))
        await restore.value
        #expect(model.isAccountReady)
        #expect(model.accountID == subject)
        auth.emitActiveSession()
        // The event must close the old account's UI gate before its asynchronous token read begins.
        #expect(!model.isAccountReady)
        let second = try #require(await requests.next())
        model.sessionDidEnd()
        await auth.release(second, token: try Self.token(subject: "replacement-\(UUID().uuidString)"))
        #expect(!model.isAccountReady)
        #expect(model.localStorageDirectory == nil)
    }

    private static let issuer = "https://pathway-account-tests.invalid"
    private static func token(subject: String) throws -> String {
        func encode(_ value: Data) -> String {
            value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return "\(encode(Data(#"{"alg":"none"}"#.utf8))).\(encode(try JSONSerialization.data(withJSONObject: ["iss": issuer, "sub": subject]))).signature"
    }
}

@MainActor private final class ControlledAccountAuth: PathwayAuthenticating {
    var hasActiveSession = true
    var onSessionChanged: ((Bool) -> Void)?
    let requests: AsyncStream<Int>
    private let requestEvents: AsyncStream<Int>.Continuation
    private var nextID = 0
    private var pending: [Int: CheckedContinuation<String, any Error>] = [:]
    private var returned: [Int: CheckedContinuation<Void, Never>] = [:]

    init() {
        let events = AsyncStream<Int>.makeStream()
        requests = events.stream; requestEvents = events.continuation
    }
    func startHostedSignIn() async throws { emitActiveSession() }
    func signOut() async throws { hasActiveSession = false; onSessionChanged?(false) }
    func emitActiveSession() { hasActiveSession = true; onSessionChanged?(true) }
    func token(template: String?) async throws -> String {
        nextID += 1
        let id = nextID
        let token = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            requestEvents.yield(id)
        }
        returned.removeValue(forKey: id)?.resume()
        return token
    }
    func release(_ id: Int, token: String) async {
        guard let continuation = pending.removeValue(forKey: id) else { Issue.record("No pending token request \(id)"); return }
        await withCheckedContinuation { completion in
            returned[id] = completion
            continuation.resume(returning: token)
        }
    }
}
