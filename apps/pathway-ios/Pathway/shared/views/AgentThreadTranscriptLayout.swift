import Foundation

/// Rows hold positions in the model's items, never payloads, so streamed text keeps the row collection
/// and each visible row reads its item's current value.
struct AgentTranscriptRow: Identifiable, Equatable {
    enum Content: Equatable {
        case item(Int)
        /// A work group's header. An expanded group follows it with one `.child` row per member.
        case work(label: String, items: [Int], settled: Bool, expanded: Bool)
        /// An expanded group's member; the last member of a settled group draws the group's divider.
        case child(Int, closesGroup: Bool)
    }
    let id: String
    let content: Content
}

/// How the model's items last changed. The transcript layout rebuilds after structural changes and
/// otherwise rechecks only the items updated in place. Every mutation of the items must be recorded.
struct PathwayTimelineChanges {
    private(set) var revision = 0
    /// The revision of the last insertion, removal, reorder, replacement or run change.
    private(set) var structure = 0
    /// Items replaced in place since the last structural change, with the revision of their latest update.
    private(set) var updated: [String: Int] = [:]

    mutating func restructure() {
        revision += 1
        structure = revision
        updated.removeAll()
    }

    mutating func update(_ id: String) {
        revision += 1
        updated[id] = revision
    }
}

/// Mirrors desktop's settled-turn folds: keep the final answer and durable child links visible.
enum AgentThreadTranscriptLayout {
    private static let persistent = Set(["subagent", "fork", "thread_created", "proposed_plan"])
    private static let attention = Set(["approval_request", "user_input_request", "error", "run_interrupt_request", "run_interrupt_result"])

    /// Rows that never fold: durable links, anything asking for attention, Computer notices, and
    /// published HTML pages, which stay above the reply they belong to.
    private static func isPinned(_ item: PathwayTimelineItem) -> Bool {
        persistent.contains(item.type) || attention.contains(item.type)
            || item.fields["workspacePreparation"]?.objectValue != nil || PathwayComputerNotice(item) != nil
            || PathwayHTMLRender(item) != nil
    }

    static func rows(_ items: [PathwayTimelineItem], activeRunID: String?,
                     isVisible: (PathwayTimelineItem) -> Bool = { _ in true }) -> [AgentTranscriptRow] {
        var visible: [Int] = []
        var byRun: [String: [Int]] = [:]
        var starts: [String: Date] = [:]
        var pendingUserDate: Date?
        for index in items.indices where isVisible(items[index]) {
            visible.append(index)
            let item = items[index]
            if item.isUserMessage { pendingUserDate = item.startedAt ?? item.updatedAt; continue }
            guard let run = item.runID else { continue }
            if byRun[run] == nil, let pendingUserDate { starts[run] = pendingUserDate }
            if byRun[run] == nil { pendingUserDate = nil }
            byRun[run, default: []].append(index)
        }
        var folds: [Int: AgentTranscriptRow] = [:]
        var hidden = Set<Int>()
        for (run, entries) in byRun {
            guard run != activeRunID, !entries.contains(where: {
                items[$0].streaming || ["running", "pending", "waiting"].contains(items[$0].status) || items[$0].type.hasPrefix("run_interrupt")
            }) else { continue }
            let terminal = entries.last { items[$0].type == "assistant_message" }
            let folded = entries.filter { $0 != terminal && !isPinned(items[$0]) }
            guard let first = folded.first else { continue }
            let start = starts[run] ?? entries.compactMap { items[$0].startedAt }.min()
            let end = entries.compactMap { items[$0].completedAt ?? items[$0].updatedAt }.max()
            let label: String
            if let start, let end, end >= start {
                label = "Worked for \(duration(end.timeIntervalSince(start)))"
            } else { label = "Worked" }
            folds[first] = AgentTranscriptRow(id: "work:\(run)", content: .work(label: label, items: folded, settled: true, expanded: false))
            hidden.formUnion(folded)
        }
        var output: [AgentTranscriptRow] = []
        var pending: [Int] = []
        func flush() {
            guard let first = pending.first else { return }
            if pending.count == 1 { output.append(.init(id: items[first].id, content: .item(first))) }
            else {
                output.append(.init(id: "activity:\(items[first].id)",
                                    content: .work(label: activityLabel(pending.map { items[$0] }), items: pending, settled: false, expanded: false)))
            }
            pending.removeAll(keepingCapacity: true)
        }
        for index in visible {
            let item = items[index]
            if let fold = folds[index] { flush(); output.append(fold) }
            if hidden.contains(index) { continue }
            if !item.isConversation && !isPinned(item) {
                if let last = pending.last, items[last].runID != item.runID { flush() }
                pending.append(index)
            } else {
                flush(); output.append(.init(id: item.id, content: .item(index)))
            }
        }
        flush()
        return output
    }

    /// Expanded groups list their members as rows of their own, so the lazy transcript creates only visible ones.
    static func expand(_ rows: [AgentTranscriptRow], items: [PathwayTimelineItem], expanded: Set<String>) -> [AgentTranscriptRow] {
        guard !expanded.isEmpty else { return rows }
        var output: [AgentTranscriptRow] = []
        output.reserveCapacity(rows.count)
        for row in rows {
            guard case let .work(label, members, settled, _) = row.content, expanded.contains(row.id) else { output.append(row); continue }
            output.append(.init(id: row.id, content: .work(label: label, items: members, settled: settled, expanded: true)))
            for (offset, index) in members.enumerated() {
                output.append(.init(id: items[index].id, content: .child(index, closesGroup: settled && offset == members.count - 1)))
            }
        }
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

/// Memoizes row structure. A streamed update rechecks only the items the model updated in place,
/// so reading rows does not walk the whole history unless the structure changed.
@MainActor
final class AgentThreadTranscriptLayoutCache {
    private struct ItemKey: Equatable {
        let id: String
        let type: String
        let runID: String?
        let status: String
        let streaming: Bool
        let visible: Bool
        let workspacePreparation: Bool
        /// Output can land after the status turns completed; a page then pins its row.
        let htmlRender: Bool
        let startedAt: String?
        let completedAt: String?
        let updatedAt: String?

        init(_ item: PathwayTimelineItem, activeRunID: String?, visible: Bool) {
            let settled = item.runID != activeRunID && !item.streaming && !["running", "pending", "waiting"].contains(item.status)
            id = item.id; type = item.type; runID = item.runID; status = item.status; streaming = item.streaming
            self.visible = visible
            workspacePreparation = item.fields["workspacePreparation"]?.objectValue != nil
            htmlRender = PathwayHTMLRender(item) != nil
            startedAt = settled ? item.fields["startedAt"]?.stringValue : nil
            completedAt = settled ? item.fields["completedAt"]?.stringValue : nil
            updatedAt = settled ? item.fields["updatedAt"]?.stringValue : nil
        }
    }
    /// The count and end IDs also catch an items mutation the model failed to record.
    private struct Key: Equatable {
        let structure: Int
        let activeRunID: String?
        let count: Int
        let firstID: String?
        let lastID: String?
    }
    private var key: Key?
    private var revision = 0
    private var keys: [ItemKey] = []
    private var positions: [String: Int] = [:]
    private var isVisible: (PathwayTimelineItem) -> Bool = { _ in true }
    private var structure: [AgentTranscriptRow] = []
    private var expanded: Set<String> = []
    private var display: [AgentTranscriptRow] = []
    private(set) var rebuildCount = 0

    func rows(_ model: PathwayAgentThreadModel, expanded: Set<String>) -> [AgentTranscriptRow] {
        // Queued and cancelled runs decide which messages show; the model records run changes as structural.
        _ = model.runs
        return rows(model.items, changes: model.itemChanges, activeRunID: model.activeRunID, expanded: expanded,
                    visibility: model.transcriptVisibility)
    }

    func rows(_ items: [PathwayTimelineItem], changes: PathwayTimelineChanges, activeRunID: String?, expanded: Set<String> = [],
              visibility: () -> ((PathwayTimelineItem) -> Bool)? = { nil }) -> [AgentTranscriptRow] {
        let next = Key(structure: changes.structure, activeRunID: activeRunID, count: items.count, firstID: items.first?.id, lastID: items.last?.id)
        var stale = next != key
        if !stale {
            for (id, updated) in changes.updated where updated > revision {
                guard let index = positions[id], items[index].id == id,
                      ItemKey(items[index], activeRunID: activeRunID, visible: isVisible(items[index])) == keys[index] else { stale = true; break }
            }
        }
        revision = changes.revision
        if stale {
            let isVisible = visibility() ?? { _ in true }
            self.isVisible = isVisible
            keys = items.map { ItemKey($0, activeRunID: activeRunID, visible: isVisible($0)) }
            positions = Dictionary(items.indices.map { (items[$0].id, $0) }, uniquingKeysWith: { _, latest in latest })
            structure = AgentThreadTranscriptLayout.rows(items, activeRunID: activeRunID, isVisible: isVisible)
            key = next
            rebuildCount += 1
        }
        if stale || expanded != self.expanded {
            display = AgentThreadTranscriptLayout.expand(structure, items: items, expanded: expanded)
            self.expanded = expanded
        }
        return display
    }
}
