import SwiftUI

struct AgentThreadLatestMessageButton: View {
    let activity: PathwayThreadActivity?
    let scrollToLatest: () -> Void

    var body: some View {
        Button(action: scrollToLatest) {
            HStack(spacing: 8) {
                if let label = activity?.progressLabel {
                    Circle()
                        .fill(RadialGradient(colors: [.white, .cyan, .blue, .indigo],
                                             center: .topLeading, startRadius: 0, endRadius: 22))
                        .frame(width: 20, height: 20)
                        .accessibilityHidden(true)
                    Text(label)
                } else {
                    Image(systemName: "chevron.down")
                }
            }
            .font(.subheadline)
            .padding(.horizontal, activity?.progressLabel == nil ? 0 : 12)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        #if os(visionOS)
        .background(.regularMaterial, in: Capsule())
        #else
        .glassEffect(.regular.interactive(), in: .capsule)
        #endif
        .accessibilityLabel("Latest message")
        .accessibilityValue(activity?.progressLabel ?? "")
        .accessibilityHint("Scroll to the latest message")
        .accessibilityIdentifier("agent-thread-jump-bottom")
    }
}
