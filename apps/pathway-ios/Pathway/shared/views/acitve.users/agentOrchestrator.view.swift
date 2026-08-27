import SwiftUI

struct AgentOrchestratorView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "Orchestrator AI",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Coordinate your AI agents, tasks, and workflows from here.")
            )
            .navigationTitle("Agent Orchestrator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .accessibilityIdentifier("agent-orchestrator-view")
    }
}

#Preview("Agent Orchestrator") {
    AgentOrchestratorView()
}
