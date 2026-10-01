import Foundation
@testable import Pathway
import Synchronization
import Testing

@MainActor struct PathwayXcodeModelTests {
    private static let accountsJSON = """
    [{"id":"personal","email":"me@example.com","displayName":"me@example.com","scope":{"kind":"user"}},
     {"id":"shared","email":"team@example.com","displayName":"Team","scope":{"kind":"company","companyId":"org-1"}}]
    """

    private final class Calls: Sendable {
        let requests = Mutex<[(String, JSONValue)]>([])
    }

    private nonisolated static func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private nonisolated static func stream(_ values: [JSONValue]) -> AsyncThrowingStream<JSONValue, Error> {
        AsyncThrowingStream { continuation in
            values.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    private func makeModel(
        defaults: UserDefaults,
        calls: Calls = Calls(),
        live: [String: [JSONValue]] = [:],
        failure: Error? = nil
    ) throws -> PathwayXcodeModel {
        let accounts = try Self.json(Self.accountsJSON)
        return PathwayXcodeModel(
            environmentID: "env-1",
            environmentCompanyID: "env-co",
            accountsCompanyID: "org-1",
            request: { method, payload, _ in
                calls.requests.withLock { $0.append((method, payload)) }
                if let failure { throw failure }
                return .null
            },
            subscribe: { method, _ in Self.stream(live[method] ?? []) },
            cloudSubscribe: { _, _ in Self.stream([accounts]) },
            defaults: defaults
        )
    }

    private func freshDefaults() throws -> UserDefaults {
        let name = "PathwayXcodeModelTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func remembersTheChosenAccountPerEnvironment() async throws {
        let defaults = try freshDefaults()
        let model = try makeModel(defaults: defaults)
        await model.observeAccounts()
        #expect(model.account?.id == "personal")
        #expect(model.target == PathwayXcodeTarget(companyId: "env-co", accountId: "personal"))

        model.choose(accountID: "shared")
        #expect(model.target == PathwayXcodeTarget(companyId: "org-1", accountId: "shared"))

        let reopened = try makeModel(defaults: defaults)
        await reopened.observeAccounts()
        #expect(reopened.account?.id == "shared")
    }

    @Test func liveStreamsSkipTransportMarkersAndDecodeUpdates() async throws {
        let marker = try Self.json(#"{"_pathwayTransport":"connected"}"#)
        let session = try Self.json(#"{"state":"authenticated","expiresAt":42}"#)
        let job = """
        {"id":"job-1","kind":"install","account":{"companyId":"env-co","accountId":"personal"},"versionId":"17B55",
         "path":"/Applications/Xcode-26.1.app","platforms":["iOS"],"state":"needs-admin",
         "steps":[{"id":"check","state":"completed","error":null,"progress":null},
                  {"id":"move","state":"needs-admin","error":null,"progress":null}],"createdAt":0,"updatedAt":0}
        """
        let status = try Self.json("""
        {"kind":"status","status":{"host":"mac","installed":[],"available":[],"runtimes":[],
         "disk":{"freeBytes":null,"requiredBytes":0},"job":null,"error":null}}
        """)
        let tick = try Self.json(#"{"kind":"job","job":\#(job)}"#)
        let model = try makeModel(defaults: freshDefaults(), live: [
            "apple.id.subscribe": [marker, session],
            "xcode.subscribe": [marker, status, tick],
        ])
        await model.observeAccounts()
        let target = try #require(model.target)
        await model.observeLive(target)

        #expect(model.session == .authenticated(expiresAt: 42))
        #expect(model.signedIn)
        #expect(model.status?.host == "mac")
        #expect(model.job?.state == .needsAdmin)
        #expect(model.viewError == nil && model.sessionError == nil)
    }

    @Test func approvalWaitsForTheMacUntilTheStepMoves() async throws {
        let calls = Calls()
        let model = try makeModel(defaults: freshDefaults(), calls: calls)
        await model.observeAccounts()
        let waiting = xcodeJob(state: .needsAdmin, steps: [xcodeStep(.check, .completed), xcodeStep(.move, .needsAdmin)])
        model.apply(.status(xcodeStatus(job: waiting)))
        #expect(!model.awaitingAdminPrompt)

        await model.approve(job: waiting)
        #expect(model.awaitingAdminPrompt)
        let sent = calls.requests.withLock { $0 }
        #expect(sent.map(\.0) == ["xcode.approve"])
        #expect(sent.first?.1 == .object([
            "companyId": .string("env-co"), "accountId": .string("personal"), "jobId": .string("job-1"),
        ]))

        model.apply(.job(xcodeJob(state: .running)))
        #expect(!model.awaitingAdminPrompt)
        #expect(model.approvedStep == nil)
    }

    @Test func commandFailuresShowTheServerMessage() async throws {
        let model = try makeModel(defaults: freshDefaults(), failure: URLError(.notConnectedToInternet))
        await model.observeAccounts()
        await model.signOut()
        #expect(model.actionError == "The environment is not connected.")
        #expect(model.pending == nil)
        #expect(PathwayXcodeModel.describe(CocoaError(.fileNoSuchFile), fallback: "Could not sign out.") == "Could not sign out.")
    }
}
