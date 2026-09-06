import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayBusinessToolsTests {
    private let emptyTime = JSONValue.object(["active": .null, "entries": .array([])])
    @Test func contactsClearWhenSwitchingToAnUnavailableWorkspace() async {
        let row: JSONValue = .object(["id": .string("contact"), "name": .string("Private"), "role": .string(""), "company": .string(""), "email": .string(""), "phone": .string(""), "notes": .string(""), "favorite": .bool(false), "createdAt": .string(""), "revision": .number(1)])
        let model = PathwayContactsModel(request: { _, _, _ in .null }, subscribe: { _, args in
            AsyncThrowingStream { continuation in
                if args.objectValue?["companyId"] == .string("allowed") { continuation.yield(.array([row])); continuation.finish() }
                else { continuation.finish(throwing: URLError(.userAuthenticationRequired)) }
            }
        })
        await model.observe(companyID: "allowed")
        #expect(model.contacts.count == 1)
        await model.observe(companyID: "denied")
        #expect(model.contacts.isEmpty)
        #expect(model.errorMessage != nil)
    }
    @Test func failedStartRetainsIdentityAcrossModelRelaunch() async throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        var original: JSONValue?
        let first = PathwayTimeModel(request: { _, _, args in original = args; throw URLError(.networkConnectionLost) }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(emptyTime); $0.finish() } }, defaults: defaults)
        await first.observe(accountID: "account")
        do { try await first.start(description: "Work", projectKey: "", projectName: "No project"); Issue.record("Expected failure") } catch { }
        #expect(first.hasPendingCommand)
        var retried: JSONValue?
        let second = PathwayTimeModel(request: { _, _, args in retried = args; return .null }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(emptyTime); $0.finish() } }, defaults: defaults)
        await second.observe(accountID: "account")
        try await second.retryPending()
        #expect(original == retried)
        #expect(!second.hasPendingCommand)
    }
    @Test func pendingTimerChangesAreScopedToTheSignedInAccount() async throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let model = PathwayTimeModel(request: { _, _, _ in throw URLError(.notConnectedToInternet) }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(emptyTime); $0.finish() } }, defaults: defaults)
        await model.observe(accountID: "one")
        do { try await model.start(description: "Work", projectKey: "", projectName: ""); } catch { }
        await model.observe(accountID: "two")
        #expect(!model.hasPendingCommand)
        await model.observe(accountID: "one")
        #expect(model.hasPendingCommand)
    }
    @Test func corruptedTimerRetryIsPreservedUntilExplicitDiscard() async {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(Data("corrupt".utf8), forKey: "pathway.time.pending.account")
        let model = PathwayTimeModel(request: { _, _, _ in .null }, subscribe: { _, _ in AsyncThrowingStream { $0.yield(emptyTime); $0.finish() } }, defaults: defaults)
        await model.observe(accountID: "account")
        #expect(model.hasPendingCommand)
        #expect(defaults.data(forKey: "pathway.time.pending.account") != nil)
        model.discardPending()
        #expect(defaults.data(forKey: "pathway.time.pending.account") == nil)
    }
}
