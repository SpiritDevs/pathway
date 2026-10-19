import Foundation

/// A company's replica, indexed by kind so feature projections never scan unrelated payloads.
struct PathwayReplicaEntities {
    private var byKind: [String: [String: PathwaySyncChange]] = [:]

    init(_ changes: [PathwaySyncChange] = []) {
        apply(changes)
    }

    var values: [PathwaySyncChange] { byKind.values.flatMap { $0.values } }

    func changes(ofKind kind: String) -> [PathwaySyncChange] {
        byKind[kind].map { Array($0.values) } ?? []
    }

    func changes(matching includes: (String) -> Bool) -> [PathwaySyncChange] {
        byKind.flatMap { kind, entries in includes(kind) ? Array(entries.values) : [] }
    }

    /// Returns only kinds whose stored contents changed, including removals.
    @discardableResult
    mutating func apply(_ changes: [PathwaySyncChange]) -> Set<String> {
        var changedKinds: Set<String> = []
        for change in changes {
            if change.changeKind == "tombstone" {
                guard byKind[change.entityKind]?.removeValue(forKey: change.entityId) != nil else { continue }
                if byKind[change.entityKind]?.isEmpty == true { byKind[change.entityKind] = nil }
            } else {
                guard byKind[change.entityKind]?[change.entityId] != change else { continue }
                byKind[change.entityKind, default: [:]][change.entityId] = change
            }
            changedKinds.insert(change.entityKind)
        }
        return changedKinds
    }
}
