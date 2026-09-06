import Foundation

enum PathwayThreadListFilter: String, CaseIterable, Identifiable {
    case all, running, needsAttention, archived
    var id: Self { self }
    var title: String {
        switch self {
        case .all: "All threads"
        case .running: "Running"
        case .needsAttention: "Needs attention"
        case .archived: "Archived"
        }
    }
}

/// Uses the same fractional keys as the desktop pinned list.
enum PathwayThreadOrder {
    static func between(_ before: String?, _ after: String?) -> String? {
        let a = Array((before ?? "").utf8), b = Array((after ?? "").utf8)
        func valid(_ value: [UInt8]) -> Bool { value.isEmpty || (value.allSatisfy { (97...122).contains($0) } && value.last != 97) }
        guard valid(a), valid(b), b.isEmpty || (before ?? "") < (after ?? "") else { return nil }
        return String(decoding: midpoint(a, b), as: UTF8.self)
    }

    private static func midpoint(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        if !b.isEmpty {
            var common = 0
            while common < b.count && (common < a.count ? a[common] : 97) == b[common] { common += 1 }
            if common > 0 {
                return Array(b.prefix(common)) + midpoint(Array(a.dropFirst(common)), Array(b.dropFirst(common)))
            }
        }
        let lower = Int(a.first ?? 97) - 97, upper = b.isEmpty ? 26 : Int(b[0]) - 97
        if upper - lower > 1 { return [UInt8(97 + Int((Double(lower + upper) / 2).rounded()))] }
        if b.count > 1 { return [b[0]] }
        return [UInt8(97 + lower)] + midpoint(Array(a.dropFirst()), [])
    }

    static func plan(ordered: [PathwayAgentThread], movedID: String) -> [(PathwayAgentThread, String)] {
        guard let index = ordered.firstIndex(where: { $0.id == movedID }) else { return [] }
        let before = index > 0 ? ordered[index - 1] : nil
        let after = index + 1 < ordered.count ? ordered[index + 1] : nil
        if (before == nil || before?.shell.pinOrderKey != nil), (after == nil || after?.shell.pinOrderKey != nil),
           let key = between(before?.shell.pinOrderKey, after?.shell.pinOrderKey) { return [(ordered[index], key)] }
        var previous: String?
        return ordered.map { thread in
            let key = between(previous, nil) ?? "n"
            previous = key
            return (thread, key)
        }
    }
}
