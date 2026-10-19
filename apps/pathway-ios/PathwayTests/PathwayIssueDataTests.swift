import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayIssueDataTests {
    private func company(_ id: String, isOwner: Bool = true) -> PathwayCompany {
        .init(id: id, membershipId: "member-\(id)", name: id, workspaceKind: "company",
              issueKeyPrefix: "PAT", lifecycleState: "active", syncVersion: 2, isOwner: isOwner)
    }

    private func change(_ kind: String, id: String, fields: [String: JSONValue], version: Int = 2) -> PathwaySyncChange {
        var payload = fields
        payload["id"] = .string(id)
        return .init(version: version, entityKind: kind, entityId: id, changeKind: "upsert", payload: .object(payload))
    }

    @Test func projectsCompanyScopedIssueDetailsAndIncomingRelations() {
        let model = PathwayIssuesModel()
        let issue = change("issue", id: "same", fields: ["title": .string("Issue"), "createdAt": .number(1_800_000_000_000)])
        model.replaceReplica([
            "one": [issue, change("issueComment", id: "comment", fields: ["issueId": .string("same"), "body": .string("Right company")]),
                    change("issueRelation", id: "relation", fields: ["issueId": .string("other"), "relatedIssueId": .string("same"), "kind": .string("blocks")])],
            "two": [issue, change("issueComment", id: "comment", fields: ["issueId": .string("same"), "body": .string("Wrong company")])]
        ])
        let first = model.records.first { $0.companyId == "one" }!
        #expect(model.records.count == 2)
        #expect(first.createdAt.timeIntervalSince1970 == 1_800_000_000)
        #expect(model.detail(for: first).comments.map { $0.string("body") } == ["Right company"])
        #expect(model.detail(for: first).relations.count == 1)
    }

    @Test func retainedDeletionSnapshotRemainsRecoverableAndLiveRestoreWins() {
        let model = PathwayIssuesModel()
        let snapshot: [String: JSONValue] = ["id": .string("issue"), "title": .string("Recover me"), "deletedAt": .number(2_000)]
        let audit = change("issueAuditEvent", id: "audit", fields: [
            "issueId": .string("issue"), "kind": .string("deleted_snapshot"),
            "payload": .object(["deletedIssue": .object(snapshot)])
        ])
        model.replaceReplica(["one": [audit]])
        #expect(model.records.first?.isDeleted == true)
        model.replaceReplica(["one": [audit, change("issue", id: "issue", fields: ["deletedAt": .null])]])
        #expect(model.records.count == 1)
        #expect(model.records.first?.isDeleted == false)
    }

    @Test func rejectedWriteRollsBackAndUsesCompanyMemberEnvelope() async throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        var sent: JSONValue?
        let model = PathwayIssuesModel(sendOperations: { _, operations in
            sent = operations.arrayValue?.first
            return .object(["receipts": .array([.object(["status": .string("rejected"), "message": .string("Denied")])])])
        }, defaults: defaults)
        model.replaceReplica(["one": [change("issue", id: "issue", fields: ["priority": .string("low")])]], companies: [company("one")], versions: ["one": 42])
        let issue = model.records[0]
        do { try await model.update(issue, patch: ["priority": .string("high")]); Issue.record("Expected rejection") }
        catch { #expect(error.localizedDescription == "Denied") }
        #expect(model.records[0].priority == "low")
        #expect(sent?.objectValue?["actor"]?.objectValue?["membershipId"] == .string("member-one"))
        #expect(sent?.objectValue?["baseVersion"] == .number(42))
        #expect(sent?.objectValue?["args"]?.objectValue?["priority"] == .string("high"))
        #expect(model.pendingChangeCount == 0)
    }

    @Test func uncertainCreateRetriesTheOriginalOperationIdentity() async throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        var attempts: [JSONValue] = []
        let model = PathwayIssuesModel(sendOperations: { _, operations in
            attempts.append(operations.arrayValue![0])
            if attempts.count == 1 { throw URLError(.networkConnectionLost) }
            return .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, defaults: defaults)
        model.replaceReplica(["one": []], companies: [company("one")])
        do { _ = try await model.create(companyID: "one", fields: ["title": .string("One issue")]) }
        catch { }
        #expect(model.pendingChangeCount == 1)
        try await model.retryPendingChanges()
        #expect(attempts.count == 2)
        #expect(attempts[0] == attempts[1])
        #expect(model.pendingChangeCount == 0)
    }

    @Test func acceptedCreateRemainsVisibleUntilItsReplicaArrives() async throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let model = PathwayIssuesModel(sendOperations: { _, _ in
            .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, defaults: defaults)
        model.replaceReplica(["one": []], companies: [company("one")])
        let id = try await model.create(companyID: "one", fields: ["title": .string("New issue")])
        #expect(model.records.count == 1)
        #expect(model.records[0].id == id)
        #expect(model.records[0].key == "Draft")
        model.replaceReplica(["one": [change("issue", id: id, fields: ["title": .string("New issue"), "key": .string("PAT-42")])]], companies: [company("one")])
        #expect(model.records.count == 1)
        #expect(model.records[0].key == "PAT-42")
    }

    @Test func corruptPendingChangesArePreservedAndNeverOverwrittenByANewIntent() async {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let corrupt = Data("not-json".utf8)
        defaults.set(corrupt, forKey: "pathway.issues.pendingOperations")
        var sent = false
        let model = PathwayIssuesModel(sendOperations: { _, _ in sent = true; return .null }, defaults: defaults)
        model.replaceReplica(["one": []], companies: [company("one")])
        do {
            _ = try await model.create(companyID: "one", fields: ["title": .string("New issue")])
            Issue.record("Expected a preserved-outbox error")
        } catch { }
        #expect(!sent)
        #expect(defaults.data(forKey: "pathway.issues.pendingOperations") == corrupt)
        #expect(model.records.isEmpty)
    }


    @Test func optionalLiveEnvironmentFailureDoesNotPoisonCloudIssueWrites() async {
        let attempted = AsyncStream<Void>.makeStream()
        let model = PathwayIssuesModel(environmentRequest: { _, _, _, _ in
            attempted.continuation.yield()
            throw URLError(.notConnectedToInternet)
        })
        let issue = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue"), "projectId": .string("project")])
        let observing = Task { await model.observe(issue) }
        var iterator = attempted.stream.makeAsyncIterator()
        _ = await iterator.next()
        observing.cancel()
        await observing.value
        #expect(model.errorMessage == nil)
        do {
            _ = try await model.request(issue, method: "issues.startEnrichment", payload: ["issueId": .string(issue.id)])
            Issue.record("Explicit environment work must surface disconnection")
        } catch { #expect(error is URLError) }
    }


    @Test func olderRejectedFieldDoesNotRemainInANewerSuccessfulOverlay() async throws {
        let writes = ControlledIssueWrites()
        let model = makeControlledModel(writes)
        let original = model.records[0]
        var started = writes.started.stream.makeAsyncIterator()
        let first = Task { try await model.update(original, patch: ["priority": .string("high")]) }
        _ = await started.next()
        let second = Task { try await model.update(original, patch: ["title": .string("New title")]) }
        _ = await started.next()
        writes.resolve(1, accepted: true)
        try await second.value
        writes.resolve(0, accepted: false)
        do { try await first.value; Issue.record("Expected the older write to fail") } catch { }
        #expect(model.records[0].priority == "low")
        #expect(model.records[0].title == "New title")
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("New title"), "priority": .string("low")
        ], version: 3)]], companies: [company("one")])
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Remote edit"), "priority": .string("medium")
        ], version: 4)]], companies: [company("one")])
        #expect(model.records[0].title == "Remote edit")
        #expect(model.records[0].priority == "medium")
    }

    @Test func latestRejectedSameFieldRestoresTheEarlierAcceptedValueUntilReplication() async throws {
        let writes = ControlledIssueWrites()
        let model = makeControlledModel(writes)
        let original = model.records[0]
        var started = writes.started.stream.makeAsyncIterator()
        let first = Task { try await model.update(original, patch: ["priority": .string("high")]) }
        _ = await started.next()
        let second = Task { try await model.update(original, patch: ["priority": .string("urgent")]) }
        _ = await started.next()
        writes.resolve(0, accepted: true)
        try await first.value
        writes.resolve(1, accepted: false)
        do { try await second.value; Issue.record("Expected the latest write to fail") } catch { }
        #expect(model.records[0].priority == "high")
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Original"), "priority": .string("high")
        ], version: 3)]], companies: [company("one")])
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Original"), "priority": .string("medium")
        ], version: 4)]], companies: [company("one")])
        #expect(model.records[0].priority == "medium")
    }

    @Test func olderResponseCannotUndoANewerSameFieldWrite() async throws {
        let writes = ControlledIssueWrites()
        let model = makeControlledModel(writes)
        let original = model.records[0]
        var started = writes.started.stream.makeAsyncIterator()
        let first = Task { try await model.update(original, patch: ["priority": .string("high")]) }
        _ = await started.next()
        let second = Task { try await model.update(original, patch: ["priority": .string("urgent")]) }
        _ = await started.next()
        writes.resolve(1, accepted: true)
        try await second.value
        writes.resolve(0, accepted: false)
        do { try await first.value; Issue.record("Expected the older write to fail") } catch { }
        #expect(model.records[0].priority == "urgent")
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Original"), "priority": .string("urgent")
        ], version: 3)]], companies: [company("one")])
        #expect(model.records[0].priority == "urgent")
    }

    @Test func intermediateReplicaRetiresOnlyTheConfirmedWritePrefix() async throws {
        let writes = ControlledIssueWrites()
        let model = makeControlledModel(writes)
        let original = model.records[0]
        var started = writes.started.stream.makeAsyncIterator()
        let first = Task { try await model.update(original, patch: ["priority": .string("high")]) }
        _ = await started.next()
        let second = Task { try await model.update(original, patch: ["title": .string("New title")]) }
        _ = await started.next()
        writes.resolve(0, accepted: true)
        try await first.value
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Original"), "priority": .string("high")
        ], version: 3)]], companies: [company("one")])
        #expect(model.records[0].title == "New title")
        writes.resolve(1, accepted: false)
        do { try await second.value; Issue.record("Expected the latest write to fail") } catch { }
        #expect(model.records[0].title == "Original")
        #expect(model.records[0].priority == "high")
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Remote"), "priority": .string("medium")
        ], version: 4)]], companies: [company("one")])
        #expect(model.records[0].priority == "medium")
    }

    @Test func commentOwnershipRequiresAnExplicitOwnUpdateGrant() {
        let model = PathwayIssuesModel()
        let issue = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue"), "teamIds": .array([])])
        let own = comment(author: .object(["kind": .string("member"), "membershipId": .string("member-one")]))
        let other = comment(author: .object(["kind": .string("member"), "membershipId": .string("someone-else")]))
        model.replaceReplica(["one": []], companies: [company("one", isOwner: false)])
        #expect(!model.canEditComment(own, issue: issue))
        model.replaceReplica(["one": commentGrant(permission: "comments.updateOwn", scope: .object(["kind": .string("company")]))],
                             companies: [company("one", isOwner: false)])
        #expect(model.canEditComment(own, issue: issue))
        #expect(!model.canEditComment(other, issue: issue))
    }

    @Test func customModeratorRolesFollowCompanyAndIssueTeamScopes() {
        let model = PathwayIssuesModel()
        let foreign = comment(author: .object(["kind": .string("agent"), "provider": .string("codex")]))
        let teamIssue = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue"), "teamIds": .array([.string("team-a"), .string("team-b")])])
        let otherTeam = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue"), "teamIds": .array([.string("team-c")])])
        let companyWide = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue"), "teamIds": .array([])])
        model.replaceReplica(["one": commentGrant(permission: "comments.moderate", scope: .object(["kind": .string("team"), "teamId": .string("team-b")]))],
                             companies: [company("one", isOwner: false)])
        #expect(model.canEditComment(foreign, issue: teamIssue))
        #expect(!model.canEditComment(foreign, issue: otherTeam))
        #expect(!model.canEditComment(foreign, issue: companyWide))
        model.replaceReplica(["one": commentGrant(permission: "comments.moderate", scope: .object(["kind": .string("company")]), version: 3)],
                             companies: [company("one", isOwner: false)])
        #expect(model.canEditComment(foreign, issue: companyWide))
        model.replaceReplica(["one": []], companies: [company("one", isOwner: false)])
        #expect(!model.canEditComment(foreign, issue: teamIssue))
    }

    @Test func moderationDoesNotReplaceOwnUpdateAndForeignAssignmentsGrantNothing() {
        let model = PathwayIssuesModel()
        let issue = PathwayIssueRecord(companyId: "one", fields: ["id": .string("issue")])
        let own = comment(author: .object(["kind": .string("member"), "membershipId": .string("member-one")]))
        let environmentAuthor = comment(author: .object(["kind": .string("environment"), "environmentId": .string("environment")]))
        model.replaceReplica(["one": commentGrant(permission: "comments.moderate", scope: .object(["kind": .string("company")]))],
                             companies: [company("one", isOwner: false)])
        #expect(!model.canEditComment(own, issue: issue))
        #expect(model.canEditComment(environmentAuthor, issue: issue))
        model.replaceReplica(["one": commentGrant(permission: "comments.moderate", scope: .object(["kind": .string("company")]), membershipID: "other", version: 3)],
                             companies: [company("one", isOwner: false)])
        #expect(!model.canEditComment(environmentAuthor, issue: issue))
        model.replaceReplica(["one": []], companies: [company("one", isOwner: true)])
        #expect(model.canEditComment(own, issue: issue))
        #expect(model.canEditComment(environmentAuthor, issue: issue))
        let foreignCompany = PathwayIssueRecord(companyId: "two", fields: ["id": .string("issue")])
        #expect(!model.canEditComment(own, issue: foreignCompany))
    }

    private func comment(author: JSONValue) -> PathwayIssueEntity {
        .init(companyId: "one", kind: "issueComment", fields: [
            "id": .string("comment"), "issueId": .string("issue"), "author": author
        ])
    }

    private func commentGrant(permission: String, scope: JSONValue, membershipID: String = "member-one", version: Int = 2) -> [PathwaySyncChange] {
        [change("role", id: "custom-role", fields: ["permissions": .array([.string(permission)])], version: version),
         change("roleAssignment", id: "grant", fields: ["membershipId": .string(membershipID), "roleId": .string("custom-role"), "scope": scope], version: version)]
    }

    private func makeControlledModel(_ writes: ControlledIssueWrites) -> PathwayIssuesModel {
        let model = PathwayIssuesModel(sendOperations: { _, _ in try await writes.send() },
                                       defaults: UserDefaults(suiteName: UUID().uuidString)!)
        model.replaceReplica(["one": [change("issue", id: "issue", fields: [
            "title": .string("Original"), "priority": .string("low")
        ])]], companies: [company("one")])
        return model
    }

    @MainActor
    private final class ControlledIssueWrites {
        let started = AsyncStream<Int>.makeStream()
        private var nextID = 0
        private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]

        func send() async throws -> JSONValue {
            let id = nextID
            nextID += 1
            return try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                started.continuation.yield(id)
            }
        }

        func resolve(_ id: Int, accepted: Bool) {
            pending.removeValue(forKey: id)?.resume(returning: .object([
                "receipts": .array([.object([
                    "status": .string(accepted ? "accepted" : "rejected"), "message": .string("Denied")
                ])])
            ]))
        }
    }

}
