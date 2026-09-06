import SwiftUI

/// Live subagent shortcuts remain reachable even when their transcript activity is folded.
struct AgentThreadSubagentPicker: View {
    let model: PathwayAgentThreadModel
    let openThread: (String) -> Void
    @State private var isPresented = false

    private var agents: [PathwayThreadSubagent] {
        model.subagents.sorted {
            let left = isWorking($0), right = isWorking($1)
            if left != right { return left }
            return $0.id < $1.id
        }
    }
    private var workingCount: Int { agents.filter(isWorking).count }

    var body: some View {
        if !agents.isEmpty {
            Button { isPresented.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "person.2")
                    Text("\(agents.count) \(agents.count == 1 ? "agent" : "agents")")
                    if workingCount > 0 {
                        Circle().fill(.green).frame(width: 6, height: 6)
                    }
                }.font(.caption).monospacedDigit()
            }
            .buttonStyle(.glass).buttonBorderShape(.capsule)
            .accessibilityValue("\(workingCount) working")
            .accessibilityIdentifier("agent-thread-subagents")
            .popover(isPresented: $isPresented, arrowEdge: .bottom) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(agents) { agent in
                            Button {
                                guard let id = agent.childThreadID else { return }
                                isPresented = false
                                openThread(id)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: symbol(agent))
                                        .foregroundStyle(color(agent)).frame(width: 20)
                                    Text(agent.title).font(.subheadline.weight(.medium))
                                        .lineLimit(2).foregroundStyle(.primary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text(status(agent)).font(.caption).foregroundStyle(.secondary)
                                    if agent.childThreadID != nil {
                                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.horizontal, 16).padding(.vertical, 13)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .disabled(agent.childThreadID == nil)
                            .accessibilityIdentifier("agent-thread-subagent-\(agent.id)")
                        }
                    }
                }
                .frame(width: 330, height: min(CGFloat(agents.count) * 60, 300))
                .presentationCompactAdaptation(.popover)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("agent-thread-subagent-list")
            }
        }
    }

    private func isWorking(_ agent: PathwayThreadSubagent) -> Bool {
        ["pending", "starting", "running", "working", "waiting"].contains(agent.status)
    }
    private func status(_ agent: PathwayThreadSubagent) -> String {
        switch agent.status {
        case "running", "working": "Working"
        case "pending", "starting": "Starting"
        case "completed": "Finished"
        case "waiting": "Waiting"
        case "failed", "error": "Failed"
        case "interrupted", "cancelled", "stopped": "Stopped"
        default: agent.status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
    private func symbol(_ agent: PathwayThreadSubagent) -> String {
        switch agent.status {
        case "completed": "checkmark.circle.fill"
        case "failed", "error": "exclamationmark.circle.fill"
        case "interrupted", "cancelled", "stopped": "pause.circle.fill"
        default: "circle.fill"
        }
    }
    private func color(_ agent: PathwayThreadSubagent) -> Color {
        switch agent.status {
        case "completed": .secondary
        case "failed", "error": .red
        case "waiting", "interrupted", "cancelled", "stopped": .orange
        default: .green
        }
    }
}
