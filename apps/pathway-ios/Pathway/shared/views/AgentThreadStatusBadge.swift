import SwiftUI

struct AgentThreadStatusBadge: View {
    let thread: PathwayAgentThread

    private var status: PathwayThreadStatus {
        PathwayThreadStatus(requestKind: thread.shell.pendingRuntimeRequest?.kind,
            hasPlan: thread.shell.hasActionableProposedPlan,
            runStatus: thread.shell.activityRunStatus ?? thread.shell.status,
            hasActiveRun: thread.shell.activeRunId != nil, hasError: thread.shell.lastError != nil)
    }

    private var color: Color {
        switch status {
        case .question, .plan: .indigo
        case .approval, .needsYou: .orange
        case .working, .preparing, .queued: .blue
        case .failed: .red
        case .waiting, .stopped, .ready: .secondary
        }
    }

    var body: some View {
        Text(status.rawValue)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.1), in: .capsule)
            .fixedSize()
            .accessibilityLabel("Status: \(status.rawValue)")
            .accessibilityIdentifier("agent-thread-status")
    }
}
