import SwiftUI

/// Searchable "Set parent" sheet: lists `thread` under the chosen thread.
struct AgentThreadParentPicker: View {
    let thread: PathwayAgentThread
    let threads: [PathwayAgentThread]
    let environmentLabel: (PathwayAgentThread) -> String?
    let select: (PathwayAgentThread) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(matches) { candidate in
                    Button {
                        select(candidate)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading) {
                            Text(candidate.shell.title).foregroundStyle(.primary)
                            if candidate.environmentId != thread.environmentId,
                               let label = environmentLabel(candidate) {
                                Text(label).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .overlay {
                if matches.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "No other threads" : "No matching threads", systemImage: "text.bubble")
                }
            }
            .searchable(text: $query, prompt: "Find a thread")
            .navigationTitle("Set parent").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private var matches: [PathwayAgentThread] {
        PathwayThreadParents.candidates(for: thread, in: threads).filter {
            query.isEmpty || $0.shell.title.localizedStandardContains(query)
                || (environmentLabel($0)?.localizedStandardContains(query) ?? false)
        }
    }
}
