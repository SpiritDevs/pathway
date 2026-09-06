import SwiftUI

struct PathwayCaptureInboxView: View {
    let onSelect: (PathwayCapturedDraft) -> Void
    @Environment(\.dismiss) private var dismiss
    private var inbox: PathwayCaptureInbox { .shared }
    var body: some View {
        NavigationStack {
            List {
                if let error = inbox.errorMessage { Text(error).foregroundStyle(.red) }
                if inbox.drafts.isEmpty {
                    ContentUnavailableView("No Shared Drafts", systemImage: "square.and.arrow.down", description: Text("Share text, photos or files to Pathway from another app."))
                }
                ForEach(inbox.drafts) { draft in
                    Button {
                        onSelect(draft)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(draft.prompt.isEmpty ? "Shared attachments" : draft.prompt).lineLimit(3)
                            Text("\(draft.attachments.count) files · \(draft.createdAt.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { Task { await inbox.remove(draft) } }
                    }
                }
            }
            .navigationTitle("Shared Drafts")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .refreshable { await inbox.refresh() }
            .task { await inbox.refresh() }
        }
    }
}

struct PathwaySharedDraftsDestination: View {
    @State private var selectedDraft: PathwayCapturedDraft?
    var body: some View {
        PathwayCaptureInboxView { selectedDraft = $0 }
            .sheet(item: $selectedDraft, onDismiss: { Task { await PathwayCaptureInbox.shared.refresh() } }) { draft in
                NewAgentThreadView(onClose: { selectedDraft = nil }, capturedDraft: draft)
            }
    }
}
