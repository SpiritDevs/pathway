import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct PathwayIssueDragPayload: Codable, Equatable, Sendable {
    let companyID: String
    let issueID: String

    static let contentType = UTType(exportedAs: "com.spiritdevs.pathway.issue-reference", conformingTo: .data)

    func itemProvider() -> NSItemProvider {
        let provider = NSItemProvider()
        let data = try? JSONEncoder().encode(self)
        provider.registerDataRepresentation(forTypeIdentifier: Self.contentType.identifier, visibility: .ownProcess) { @Sendable completion in
            Task { @MainActor in completion(data, nil) }
            return nil
        }
        return provider
    }

    @discardableResult
    static func load(from providers: [NSItemProvider], perform: @escaping @MainActor @Sendable (Self) -> Void) -> Bool {
        guard providers.count == 1, let provider = providers.first,
              provider.hasItemConformingToTypeIdentifier(contentType.identifier) else {
            return false
        }
        provider.loadDataRepresentation(forTypeIdentifier: contentType.identifier) { @Sendable data, _ in
            guard let data, let payload = try? JSONDecoder().decode(Self.self, from: data) else {
                return
            }
            Task { @MainActor in perform(payload) }
        }
        return true
    }
}

enum PathwayIssueDropEdge: Equatable, Sendable { case before, after }

struct PathwayIssueListDropEntry {
    let issueID: String?
    let statusID: String?
}

/// Native List moves use insertion offsets across the complete collection, including headers.
struct PathwayIssueListDropPosition {
    let statusID: String
    let targetIssueID: String?
    let edge: PathwayIssueDropEdge

    static func resolve(entries: [PathwayIssueListDropEntry], sourceID: String, destination: Int) -> Self? {
        guard (0...entries.count).contains(destination),
              let sourceIndex = entries.firstIndex(where: { $0.issueID == sourceID }) else { return nil }
        var remaining = entries
        remaining.remove(at: sourceIndex)
        let insertion = destination > sourceIndex ? destination - 1 : destination
        let preceding = remaining.prefix(insertion)
        let headerIndex = preceding.lastIndex(where: { $0.issueID == nil })
        guard let statusID = headerIndex.map({ remaining[$0].statusID }) ?? remaining.first?.statusID else { return nil }
        let groupStart = headerIndex.map { $0 + 1 } ?? 0
        let groupEnd = remaining.dropFirst(groupStart).firstIndex(where: { $0.issueID == nil }) ?? remaining.count
        let siblings = remaining[groupStart..<groupEnd].compactMap(\.issueID)
        let issueIndex = preceding.dropFirst(groupStart).compactMap(\.issueID).count
        if issueIndex < siblings.count {
            return .init(statusID: statusID, targetIssueID: siblings[issueIndex], edge: .before)
        }
        return .init(statusID: statusID, targetIssueID: siblings.last, edge: .after)
    }
}

struct PathwayIssueDropMove: Equatable {
    let issueID: String
    let statusID: String
    let sortOrder: String
}

/// A drop changes one fractional ordering key, plus status when it crosses a section.
/// Priority remains a separate property, exactly as it does on desktop.
enum PathwayIssueDropOrdering {
    static func resolve(
        payload: PathwayIssueDragPayload, companyID: String,
        records: [PathwayIssueRecord], statusIDs: Set<String>,
        targetStatusID: String, targetIssueID: String?, edge: PathwayIssueDropEdge
    ) -> PathwayIssueDropMove? {
        guard payload.companyID == companyID, statusIDs.contains(targetStatusID),
              let source = records.first(where: { $0.companyId == companyID && $0.id == payload.issueID }),
              !source.isDeleted, !source.triage, source.id != targetIssueID else { return nil }
        let allSiblings = records.filter {
            $0.companyId == companyID && !$0.isDeleted && !$0.triage && $0.statusId == targetStatusID
        }.sorted { ($0.sortOrder, $0.id) < ($1.sortOrder, $1.id) }
        let siblings = allSiblings.filter { $0.id != source.id }
        let index: Int
        if let targetIssueID {
            guard let targetIndex = siblings.firstIndex(where: { $0.id == targetIssueID }) else { return nil }
            index = targetIndex + (edge == .after ? 1 : 0)
        } else {
            index = 0
        }
        if source.statusId == targetStatusID && allSiblings.firstIndex(where: { $0.id == source.id }) == index { return nil }
        let before = index > 0 ? siblings[index - 1].sortOrder : nil
        let after = index < siblings.count ? siblings[index].sortOrder : nil
        guard let key = PathwayIssueOrdering.key(between: before, and: after) else { return nil }
        return .init(issueID: source.id, statusID: targetStatusID, sortOrder: key)
    }
}

struct PathwayIssueDragSource: ViewModifier {
    let payload: PathwayIssueDragPayload
    let enabled: Bool

    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.onDrag {
            return payload.itemProvider()
        } }
        else { content }
    }
}

struct PathwayIssueDropTarget: ViewModifier {
    let enabled: Bool
    var isHeader = false
    let onDrop: @MainActor @Sendable (PathwayIssueDragPayload, PathwayIssueDropEdge) -> Void
    @State private var height: CGFloat = 44
    @State private var highlightedEdge: PathwayIssueDropEdge?

    @ViewBuilder func body(content: Content) -> some View {
        if enabled {
            content
                .contentShape(Rectangle())
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
                .overlay(alignment: highlightedEdge == .after ? .bottom : .top) {
                    if highlightedEdge != nil {
                        Rectangle().fill(Color.accentColor).frame(height: 2).allowsHitTesting(false)
                    }
                }
                .onDrop(of: [PathwayIssueDragPayload.contentType], delegate: PathwayIssueDropDelegate(
                    rowHeight: height, isHeader: isHeader, highlightedEdge: $highlightedEdge, onDrop: onDrop
                ))
        } else { content }
    }
}

private struct PathwayIssueDropDelegate: DropDelegate {
    let rowHeight: CGFloat
    let isHeader: Bool
    @Binding var highlightedEdge: PathwayIssueDropEdge?
    let onDrop: @MainActor @Sendable (PathwayIssueDragPayload, PathwayIssueDropEdge) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        let accepted = info.hasItemsConforming(to: [PathwayIssueDragPayload.contentType])
        return accepted
    }

    func dropEntered(info: DropInfo) {
        highlightedEdge = edge(at: info.location)
    }
    func dropExited(info: DropInfo) { highlightedEdge = nil }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        highlightedEdge = edge(at: info.location)
        return DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        highlightedEdge = nil
        let providers = info.itemProviders(for: [PathwayIssueDragPayload.contentType])
        let position = edge(at: info.location)
        let action = onDrop
        return PathwayIssueDragPayload.load(from: providers) { action($0, position) }
    }

    private func edge(at location: CGPoint) -> PathwayIssueDropEdge {
        isHeader || location.y < rowHeight / 2 ? .before : .after
    }
}
