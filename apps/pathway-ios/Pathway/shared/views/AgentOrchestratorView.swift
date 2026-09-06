import SwiftUI

struct AgentOrchestratorView: View {
    var isSeparateWindow = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        NewAgentThreadView(onClose: close)
            .accessibilityIdentifier("agent-orchestrator-view")
    }

    private func close() {
        #if os(visionOS)
        if isSeparateWindow { dismissWindow(id: PathwayWindow.agentOrchestrator.rawValue) } else { dismiss() }
        #else
        dismiss()
        #endif
    }
}
