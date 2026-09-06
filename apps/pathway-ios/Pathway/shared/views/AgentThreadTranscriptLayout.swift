import Foundation

struct AgentTranscriptRow: Identifiable, Equatable {
    enum Content: Equatable {
        case item(PathwayTimelineItem)
        case work(label: String, items: [PathwayTimelineItem], settled: Bool)
    }
    let id: String
    let content: Content
}

/// Mirrors desktop's settled-turn folds: keep the final answer and durable child links visible.
enum AgentThreadTranscriptLayout {
    private static let persistent = Set(["subagent", "fork", "thread_created", "proposed_plan"])
    private static let attention = Set(["approval_request", "user_input_request", "error", "run_interrupt_request", "run_interrupt_result"])

    static func rows(_ items: [PathwayTimelineItem], activeRunID: String?) -> [AgentTranscriptRow] {
        var byRun: [String: [PathwayTimelineItem]] = [:]
        var starts: [String: Date] = [:]
        var pendingUserDate: Date?
        for item in items {
            if item.isUserMessage { pendingUserDate = item.startedAt ?? item.updatedAt; continue }
            guard let run = item.runID else { continue }
            if byRun[run] == nil, let pendingUserDate { starts[run] = pendingUserDate }
            if byRun[run] == nil { pendingUserDate = nil }
            byRun[run, default: []].append(item)
        }
        var folds: [String: AgentTranscriptRow] = [:]
        var hidden = Set<String>()
        for (run, entries) in byRun {
            guard run != activeRunID,
                  !entries.contains(where: { $0.streaming || ["running", "pending", "waiting"].contains($0.status) || $0.type.hasPrefix("run_interrupt") }) else { continue }
            let terminal = entries.last(where: { $0.type == "assistant_message" })?.id
            let folded = entries.filter {
                $0.id != terminal && !persistent.contains($0.type) && !attention.contains($0.type)
                    && $0.fields["workspacePreparation"]?.objectValue == nil
            }
            guard let first = folded.first else { continue }
            let start = starts[run] ?? entries.compactMap(\.startedAt).min()
            let end = entries.compactMap { $0.completedAt ?? $0.updatedAt }.max()
            let label: String
            if let start, let end, end >= start {
                label = "Worked for \(duration(end.timeIntervalSince(start)))"
            } else { label = "Worked" }
            folds[first.id] = AgentTranscriptRow(id: "work:\(run)", content: .work(label: label, items: folded, settled: true))
            hidden.formUnion(folded.map(\.id))
        }
        var output: [AgentTranscriptRow] = []
        var pending: [PathwayTimelineItem] = []
        func flush() {
            guard let first = pending.first else { return }
            if pending.count == 1 { output.append(.init(id: first.id, content: .item(first))) }
            else { output.append(.init(id: "activity:\(first.id)", content: .work(label: activityLabel(pending), items: pending, settled: false))) }
            pending.removeAll(keepingCapacity: true)
        }
        for item in items {
            if let fold = folds[item.id] { flush(); output.append(fold) }
            if hidden.contains(item.id) { continue }
            if !item.isConversation && !persistent.contains(item.type) && !attention.contains(item.type)
                && item.fields["workspacePreparation"]?.objectValue == nil {
                if pending.last?.runID != item.runID { flush() }
                pending.append(item)
            } else {
                flush(); output.append(.init(id: item.id, content: .item(item)))
            }
        }
        flush()
        return output
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        if total >= 3600 { return "\(total / 3600)h \((total % 3600) / 60)m" }
        if total >= 60 { return "\(total / 60)m \(total % 60)s" }
        return "\(total)s"
    }

    static func activityLabel(_ items: [PathwayTimelineItem]) -> String {
        let files = items.filter { $0.type == "file_change" }.count
        let searches = items.filter { $0.type == "file_search" || $0.type == "web_search" }.count
        let commands = items.filter { $0.type == "command_execution" }.count
        var parts: [String] = []
        if files > 0 { parts.append("Edited \(files) \(files == 1 ? "file" : "files")") }
        if searches > 0 { parts.append("\(parts.isEmpty ? "Searched" : "searched") \(searches) \(searches == 1 ? "time" : "times")") }
        if commands > 0 { parts.append("\(parts.isEmpty ? "Ran" : "ran") \(commands) \(commands == 1 ? "command" : "commands")") }
        return parts.isEmpty ? "\(items.count) activities" : parts.joined(separator: ", ")
    }
}

/// Memoize row structure, never message payloads. Streaming text uses the current items on every read.
@MainActor
final class AgentThreadTranscriptLayoutCache {
    private struct ItemKey: Equatable {
        let id: String
        let type: String
        let runID: String?
        let status: String
        let streaming: Bool
        let workspacePreparation: Bool
        let startedAt: String?
        let completedAt: String?
        let updatedAt: String?
    }
    private struct Key: Equatable {
        let activeRunID: String?
        let items: [ItemKey]
    }
    private var key: Key?
    private var structure: [AgentTranscriptRow] = []
    private(set) var rebuildCount = 0

    func rows(_ items: [PathwayTimelineItem], activeRunID: String?) -> [AgentTranscriptRow] {
        let next = Key(activeRunID: activeRunID, items: items.map { item in
            let settled = item.runID != activeRunID && !item.streaming && !["running", "pending", "waiting"].contains(item.status)
            return ItemKey(id: item.id, type: item.type, runID: item.runID, status: item.status,
                           streaming: item.streaming, workspacePreparation: item.fields["workspacePreparation"]?.objectValue != nil,
                           startedAt: settled ? item.fields["startedAt"]?.stringValue : nil,
                           completedAt: settled ? item.fields["completedAt"]?.stringValue : nil,
                           updatedAt: settled ? item.fields["updatedAt"]?.stringValue : nil)
        })
        if next != key {
            structure = AgentThreadTranscriptLayout.rows(items, activeRunID: activeRunID)
            key = next
            rebuildCount += 1
        }
        let current = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        return structure.compactMap { row in
            switch row.content {
            case .item(let item):
                return current[item.id].map { AgentTranscriptRow(id: row.id, content: .item($0)) }
            case .work(let label, let items, let settled):
                return AgentTranscriptRow(id: row.id, content: .work(label: label, items: items.compactMap { current[$0.id] }, settled: settled))
            }
        }
    }
}
