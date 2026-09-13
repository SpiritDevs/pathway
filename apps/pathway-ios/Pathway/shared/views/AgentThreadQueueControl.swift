import SwiftUI

/// The queue stays accessible beside the diff counter, including when the composer is collapsed.
struct AgentThreadQueueControl: View {
    let model: PathwayAgentThreadModel
    @Binding var isComposerExpanded: Bool
    @Binding var isComposerFocused: Bool
    @State private var isPresented = false
    @State private var focusComposerOnDismiss = false

    var body: some View {
        Group {
            if model.queuedMessageCount > 0 {
                Button { isPresented = true } label: {
                    Label("\(model.queuedMessageCount) queued", systemImage: "text.line.first.and.arrowtriangle.forward")
                        .font(.caption).monospacedDigit()
                }
                #if os(visionOS)
                .buttonStyle(.bordered)
                #else
                .buttonStyle(.glass)
                #endif
                .buttonBorderShape(.capsule)
                .accessibilityIdentifier("agent-thread-queue")
            }
        }
        .sheet(isPresented: $isPresented, onDismiss: {
            if focusComposerOnDismiss {
                focusComposerOnDismiss = false
                isComposerExpanded = true
                isComposerFocused = true
            }
        }) {
            AgentThreadQueueSheet(model: model) {
                focusComposerOnDismiss = true
                isPresented = false
            }
        }
    }
}

private struct AgentThreadQueueSheet: View {
    let model: PathwayAgentThreadModel
    let onEdit: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var editing = false
    @State private var errorMessage: String?
    @State private var reorderedIDs: [String]?

    private var queue: [PathwayThreadRun] {
        let runs = model.queuedRuns
        guard let reorderedIDs else { return runs }
        let byID = Dictionary(uniqueKeysWithValues: runs.map { ($0.id, $0) })
        return reorderedIDs.compactMap { byID[$0] } + runs.filter { !reorderedIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            List {
                cloudRows
                ForEach(queue) { run in
                    HStack(spacing: 4) {
                        VStack(alignment: .leading, spacing: 2) {
                            let message = model.queuedMessage(for: run)
                            let text = message?.text ?? ""
                            Text(text.isEmpty ? "Queued message" : text)
                                .font(.subheadline).lineLimit(2)
                            if let message, !message.attachments.isEmpty {
                                Label("\(message.attachments.count) attachments", systemImage: "paperclip")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        action("Delete", symbol: "trash", id: "delete", run: run) {
                            perform { try await model.cancelQueuedRun(run.id) }
                        }
                        .tint(.red)
                        action("Edit", symbol: "pencil", id: "edit", run: run) {
                            editing = true
                            perform {
                                defer { editing = false }
                                try await model.restoreQueuedMessage(run.id)
                                onEdit()
                            }
                        }
                        .disabled(!model.canRestoreQueuedMessage(run))
                        .tint(.blue)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        action("Steer", symbol: "arrow.turn.up.right", id: "steer", run: run) {
                            perform { try await model.steerQueuedRun(run.id) }
                        }
                        .disabled(model.activeRunID == nil || !model.canRestoreQueuedMessage(run))
                        .tint(.orange)
                    }
                    .disabled(busy || !model.isSubscriptionReady)
                    .moveDisabled(busy || !model.isSubscriptionReady || queue.count < 2)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8))
                    .accessibilityIdentifier("agent-thread-queue-row-\(run.id)")
                }
                .onMove(perform: move)
            }
            .listStyle(.plain)
            .disabled(busy)
            .navigationTitle("Queued messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .alert("Couldn’t update queue", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK") { errorMessage = nil }
            } message: { Text(errorMessage ?? "") }
            .onChange(of: model.queuedRuns, initial: true) { _, runs in
                reorderedIDs = nil
                if model.queuedMessageCount == 0 && !editing { dismiss() }
            }
            .onChange(of: model.queuedMessageCount) { _, count in
                if count == 0 && !editing { dismiss() }
            }
            .onChange(of: editing) { _, value in
                if !value && model.queuedMessageCount == 0 { dismiss() }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var cloudRows: some View {
        ForEach(model.cloudQueuedItems) { item in
            HStack(spacing: 4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text((item.text ?? "").isEmpty ? "Queued message" : item.text ?? "")
                        .font(.subheadline).lineLimit(2)
                    Text(model.cloudQueueMessage(for: item)?["state"]?.stringValue == "blocked" ? "Needs attention" : "Waiting for environment")
                        .font(.caption2).foregroundStyle(.secondary)
                    if !item.attachments.isEmpty {
                        Label("\(item.attachments.count) attachments", systemImage: "paperclip").font(.caption2)
                    }
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    perform { try await model.mutateCloudQueueMessage(item, action: "cancel") }
                } label: { Label("Delete", systemImage: "trash") }
                    .disabled(!model.canCancelCloudQueueMessage(item))
                Button {
                    editing = true
                    perform {
                        defer { editing = false }
                        try await model.restoreCloudQueuedMessage(item)
                        onEdit()
                    }
                } label: { Label("Edit", systemImage: "pencil") }
                    .tint(.blue)
                    .disabled(!model.canEditCloudQueueMessage(item) || !model.canCancelCloudQueueMessage(item))
                    .accessibilityLabel("Edit queued message")
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                Button("Steer", systemImage: "arrow.turn.up.right") {
                    guard let activeRunID = model.activeRunID else { return }
                    perform { try await model.mutateCloudQueueMessage(item, action: "steer", deliveryFields: ["targetRunId": .string(activeRunID)]) }
                }
                .tint(.orange)
                .disabled(!model.canChangeCloudQueuedDelivery(item) || model.activeRunID == nil || model.cloudQueueMessage(for: item)?["state"]?.stringValue != "queued")
                if model.cloudQueueMessage(for: item)?["state"]?.stringValue == "blocked" {
                    Button {
                        perform { try await model.mutateCloudQueueMessage(item, action: "retry") }
                    } label: { Label("Retry", systemImage: "arrow.clockwise") }
                        .tint(.orange)
                        .accessibilityLabel("Retry queued message")
                }
            }
            .moveDisabled(busy || model.cloudQueuedItems.count < 2 || !model.cloudQueuedItems.allSatisfy(model.canChangeCloudQueuedDelivery))
            .buttonStyle(.borderless)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8))
        }
        .onMove { source, destination in
            var rows = model.cloudQueuedItems
            guard source.count == 1, let index = source.first, rows.indices.contains(index), rows.allSatisfy(model.canChangeCloudQueuedDelivery) else { return }
            let moved = rows[index]
            rows.move(fromOffsets: source, toOffset: destination)
            guard let newIndex = rows.firstIndex(where: { $0.id == moved.id }), newIndex != index else { return }
            let before = newIndex + 1 < rows.count ? model.cloudQueueMessage(for: rows[newIndex + 1])?["commandId"] ?? .null : .null
            perform { try await model.mutateCloudQueueMessage(moved, action: "reorder", deliveryFields: ["beforeCommandId": before]) }
        }
    }

    private func action(_ title: String, symbol: String, id: String, run: PathwayThreadRun, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("\(title) queued message")
        .accessibilityIdentifier("agent-thread-queue-\(id)-\(run.id)")
    }

    private func move(from source: IndexSet, to destination: Int) {
        var reordered = queue
        guard source.count == 1, let index = source.first, reordered.indices.contains(index) else { return }
        let movedID = reordered[index].id
        reordered.move(fromOffsets: source, toOffset: destination)
        guard let newIndex = reordered.firstIndex(where: { $0.id == movedID }), newIndex != index else { return }
        let nextID = newIndex + 1 < reordered.count ? reordered[newIndex + 1].id : nil
        reorderedIDs = reordered.map(\.id)
        perform {
            do { try await model.reorderQueuedRun(movedID, beforeRunID: nextID) }
            catch { reorderedIDs = nil; throw error }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await action() }
            catch { errorMessage = error.localizedDescription }
        }
    }
}
