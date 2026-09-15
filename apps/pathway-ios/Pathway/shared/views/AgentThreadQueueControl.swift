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
            if !model.queuedRuns.isEmpty || !model.cloudPendingItems.isEmpty {
                Button { isPresented = true } label: {
                    Label("\(model.queuedRuns.count + model.cloudPendingItems.count) queued", systemImage: "text.line.first.and.arrowtriangle.forward")
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
    @State private var editingCloudItem: PathwayTimelineItem?

    private var queue: [PathwayThreadRun] {
        let runs = model.queuedRuns
        guard let reorderedIDs else { return runs }
        let byID = Dictionary(uniqueKeysWithValues: runs.map { ($0.id, $0) })
        return reorderedIDs.compactMap { byID[$0] } + runs.filter { !reorderedIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            List {
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
                        .frame(maxWidth: .infinity, alignment: .leading)
                        action("Edit", symbol: "pencil", id: "edit", run: run) {
                            editing = true
                            perform {
                                defer { editing = false }
                                try await model.restoreQueuedMessage(run.id)
                                onEdit()
                            }
                        }
                        .disabled(!model.canRestoreQueuedMessage(run))
                        action("Steer", symbol: "arrow.turn.up.right", id: "steer", run: run) {
                            perform { try await model.steerQueuedRun(run.id) }
                        }
                        .disabled(model.activeRunID == nil || !model.canRestoreQueuedMessage(run))
                        action("Delete", symbol: "trash", id: "delete", run: run) {
                            perform { try await model.cancelQueuedRun(run.id) }
                        }
                        .tint(.red)
                    }
                    .disabled(!model.isSubscriptionReady)
                    .moveDisabled(busy || !model.isSubscriptionReady || queue.count < 2)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8))
                    .accessibilityIdentifier("agent-thread-queue-row-\(run.id)")
                }
                .onMove(perform: move)
                ForEach(model.cloudPendingItems) { item in
                    cloudRow(item)
                }
                .onMove(perform: moveCloudMessage)
            }
            .listStyle(.plain)
            .environment(\.editMode, .constant(.active))
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
                if runs.isEmpty && model.cloudPendingItems.isEmpty && !editing && editingCloudItem == nil { dismiss() }
            }
            .onChange(of: editing) { _, value in
                if !value && model.queuedRuns.isEmpty && model.cloudPendingItems.isEmpty { dismiss() }
            }
            .onChange(of: model.cloudPendingItems.map(\.id)) { _, ids in
                if ids.isEmpty && model.queuedRuns.isEmpty && !editing && editingCloudItem == nil { dismiss() }
            }
            .sheet(item: $editingCloudItem, onDismiss: {
                if model.cloudPendingItems.isEmpty && model.queuedRuns.isEmpty { dismiss() }
            }) { item in
                AgentTranscriptMessageEditor(item: item, model: model)
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func cloudRow(_ item: PathwayTimelineItem) -> some View {
        let message = model.cloudQueueMessage(for: item) ?? [:]
        let editable = model.canEditCloudQueueMessage(item)
        let isFollowUp = message["submission"]?.objectValue?["kind"]?.stringValue == "message"
        return HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.text?.isEmpty == false ? AgentTranscriptMessageEditor.editableText(item.text ?? "") : "Queued message")
                    .font(.subheadline).lineLimit(2)
                if !item.attachments.isEmpty {
                    Label("\(item.attachments.count) attachments", systemImage: "paperclip")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let error = message["error"]?.stringValue {
                    Text(error).font(.caption).foregroundStyle(.red)
                } else if !editable {
                    Text("Sending to environment").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if message["state"]?.stringValue == "blocked" {
                Button {
                    perform { try await model.mutateCloudQueueMessage(item, action: "retry") }
                } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Retry queued message")
            }
            Button { editingCloudItem = item } label: {
                Image(systemName: "pencil").frame(width: 44, height: 44)
            }
            .disabled(!editable)
            .accessibilityLabel("Edit queued message")
            Button {
                perform { try await model.mutateCloudQueueMessage(item, action: "steer", targetRunID: model.activeRunID) }
            } label: {
                Image(systemName: "arrow.turn.up.right").frame(width: 44, height: 44)
            }
            .disabled(!editable || !isFollowUp || message["state"]?.stringValue == "blocked" || model.activeRunID == nil || !model.isSubscriptionReady)
            .accessibilityLabel("Steer queued message")
            Button {
                perform { try await model.mutateCloudQueueMessage(item, action: "cancel") }
            } label: {
                Image(systemName: "trash").frame(width: 44, height: 44)
            }
            .tint(.red)
            .disabled(!model.canCancelCloudQueueMessage(item))
            .accessibilityLabel("Delete queued message")
        }
        .buttonStyle(.borderless)
        .moveDisabled(busy || !editable || !isFollowUp || model.cloudPendingItems.count < 2)
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8))
        .accessibilityIdentifier("agent-thread-queue-row-\(item.id)")
    }

    private func moveCloudMessage(from source: IndexSet, to destination: Int) {
        var items = model.cloudPendingItems
        guard source.count == 1, let index = source.first, items.indices.contains(index) else { return }
        let item = items[index]
        items.move(fromOffsets: source, toOffset: destination)
        guard let newIndex = items.firstIndex(where: { $0.id == item.id }), newIndex != index else { return }
        let nextID = newIndex + 1 < items.count ? items[newIndex + 1].fields["queueCommandId"]?.stringValue : nil
        perform { try await model.mutateCloudQueueMessage(item, action: "reorder", beforeCommandID: nextID) }
    }

    private func action(_ title: String, symbol: String, id: String, run: PathwayThreadRun, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Label(title, systemImage: symbol).labelStyle(.iconOnly)
                .font(.subheadline).frame(width: 44, height: 44)
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
