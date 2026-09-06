import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayEmailDeletionTests {
    private func rows(_ count: Int) -> [PathwaySyncChange] {
        (0..<count).map { index in
            .init(version: 1, entityKind: "capturedEmail", entityId: "row-\(index)", changeKind: "upsert", payload: .object(["id": .string("row-\(index)"), "environmentId": .string("environment-\(index % 2)"), "message": .object(["id": .string("mail-\(index)")])]))
        }
    }
    @Test func deletionBatchesStayWithinTheCompanyAndBackendLimit() async throws {
        var calls: [JSONValue] = []
        let model = PathwayEmailModel(cloudRequest: { kind, name, args in
            #expect(kind == "mutation")
            #expect(name == "capturedEmails:remove")
            calls.append(args)
            return .null
        })
        model.replaceReplica(["one": rows(205), "two": rows(101)])
        try await model.remove(model.messages)
        #expect(calls.count == 5)
        #expect(calls.allSatisfy { ($0.objectValue?["messages"]?.arrayValue?.count ?? 0) <= 100 })
        for (company, count) in [("one", 205), ("two", 101)] {
            let batches = calls.filter { $0.objectValue?["companyId"] == .string(company) }
            let messages = batches.flatMap { $0.objectValue?["messages"]?.arrayValue ?? [] }
            #expect(messages.count == count)
            #expect(Set(messages.compactMap { $0.objectValue?["messageId"]?.stringValue }).count == count)
            #expect(messages.allSatisfy { $0.objectValue?["environmentId"]?.stringValue?.hasPrefix("environment-") == true })
        }
        #expect(model.messages.isEmpty)
    }
    @Test func aFailedBatchPreservesUndeletedMessagesAndStopsTheRemainingRequests() async throws {
        var calls = 0
        let model = PathwayEmailModel(cloudRequest: { _, _, _ in
            calls += 1
            if calls == 2 { throw URLError(.notConnectedToInternet) }
            return .null
        })
        model.replaceReplica(["one": rows(205)])
        do { try await model.remove(model.messages); Issue.record("Expected batch failure") } catch { }
        #expect(calls == 2)
        #expect(model.messages.count == 105)
    }
}
