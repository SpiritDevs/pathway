import Foundation
@testable import Pathway
import Testing

struct PathwayReplicaEntitiesTests {
    private func change(_ kind: String, _ id: String, version: Int = 1, tombstone: Bool = false) -> PathwaySyncChange {
        .init(version: version, entityKind: kind, entityId: id, changeKind: tombstone ? "tombstone" : "upsert", payload: .string(id))
    }

    @Test func indexesByBothKindAndIDAndRemovesOnlyTheTargetedRecord() {
        var replica = PathwayReplicaEntities([change("issue", "same"), change("capturedEmail", "same")])
        #expect(replica.apply([change("issue", "same", version: 2, tombstone: true)]) == ["issue"])
        #expect(replica.changes(ofKind: "issue").isEmpty)
        #expect(replica.changes(ofKind: "capturedEmail") == [change("capturedEmail", "same")])
        #expect(replica.apply([change("issue", "absent", tombstone: true)]).isEmpty)
        #expect(replica.apply([change("capturedEmail", "same")]).isEmpty)
    }

    @Test func preservesPageOrderAndSnapshotValueSemantics() {
        var replica = PathwayReplicaEntities([change("issue", "one")])
        let snapshot = replica
        replica.apply([change("issue", "one", version: 2, tombstone: true), change("issue", "one", version: 3)])
        #expect(replica.changes(ofKind: "issue") == [change("issue", "one", version: 3)])
        #expect(snapshot.changes(ofKind: "issue") == [change("issue", "one")])
    }

    @Test func featureSelectionExaminesKindsInsteadOfEveryPayload() {
        let entries = (0..<10_000).map { change("capturedEmail", String($0)) } + [change("issue", "task")]
        let replica = PathwayReplicaEntities(entries)
        var examinedKinds: [String] = []
        let issues = replica.changes { kind in examinedKinds.append(kind); return kind.hasPrefix("issue") }
        #expect(issues == [change("issue", "task")])
        #expect(examinedKinds.sorted() == ["capturedEmail", "issue"])
    }
}
