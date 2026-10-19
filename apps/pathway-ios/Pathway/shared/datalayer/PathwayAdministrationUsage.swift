import Foundation

struct PathwayAdministrationUsage: Decodable {
    let contractVersion: Int
    let readAt: String
    let buckets: [Bucket]
    let sources: [Source]
    let pricing: Pricing
    struct Totals: Decodable {
        let uncachedInputTokens: Int
        let cachedInputTokens: Int
        let cacheCreationTokens: Int
        let outputTokens: Int
        let reasoningTokens: Int
        var tokens: Int { uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens }
    }
    struct Bucket: Decodable {
        let day: String
        let provider: String
        let model: String
        let totals: Totals
        let costUsd: Double
        let unpricedRecords: Int
    }
    struct Source: Decodable, Identifiable {
        let fingerprint: Fingerprint
        let status: String
        let distinctSessions: Int
        let message: String?
        var id: String { fingerprint.hostId + "|" + fingerprint.provider + "|" + fingerprint.resolvedHomePath + "|" + fingerprint.volumeId }
        struct Fingerprint: Decodable { let hostId: String; let provider: String; let resolvedHomePath: String; let volumeId: String }
    }
    struct Pricing: Decodable { let status: String; let source: String }
    struct ModelTotal: Identifiable {
        let id: String
        let name: String
        let provider: String
        let tokens: Int
        let cost: Double
    }
    var totalTokens: Int { buckets.reduce(0) { $0 + $1.totals.tokens } }
    var totalCost: Double { buckets.reduce(0) { $0 + $1.costUsd } }
    var unpricedRecords: Int { buckets.reduce(0) { $0 + $1.unpricedRecords } }
    var models: [ModelTotal] {
        let groups = Dictionary(grouping: buckets) { bucket in bucket.provider + "|" + bucket.model }
        var result: [ModelTotal] = []
        for (id, values) in groups {
            guard let first = values.first else { continue }
            let tokens = values.reduce(0) { total, bucket in total + bucket.totals.tokens }
            let cost = values.reduce(0.0) { total, bucket in total + bucket.costUsd }
            result.append(ModelTotal(id: id, name: first.model, provider: first.provider, tokens: tokens, cost: cost))
        }
        return result.sorted { $0.tokens > $1.tokens }
    }

}
struct PathwayAdministrationQuota: Decodable, Identifiable {
    let instanceId: String
    let provider: String
    let updatedAt: String
    let status: String
    let planName: String?
    let detail: String?
    let stale: Bool?
    let limits: [Limit]
    let usageLines: [UsageLine]
    var id: String { instanceId }
    struct Limit: Decodable, Identifiable {
        let window: String
        let scope: String?
        let limitId: String?
        let lane: String?
        let usedPercent: Double?
        let resetsAt: String?
        var id: String { [window, scope ?? "", limitId ?? "", lane ?? ""].joined(separator: "|") }
        var remaining: Double? { usedPercent.map { max(0, min(100, 100 - $0)) } }
    }
    struct UsageLine: Decodable, Identifiable {
        let label: String
        let value: String
        let subtitle: String?
        var id: String { label }
    }
}
