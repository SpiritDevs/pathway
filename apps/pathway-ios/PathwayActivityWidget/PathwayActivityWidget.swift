#if os(iOS)
import ActivityKit
#endif
import SwiftUI
import WidgetKit

@main
struct PathwayActivityWidgetBundle: WidgetBundle {
    var body: some Widget {
        PathwayWorkSummaryWidget()
        #if os(iOS)
        PathwayAgentActivityWidget()
        #endif
    }
}

#if os(iOS)
struct PathwayAgentActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LiveActivityAttributes.self) { context in
            if let aggregate = context.state.aggregate {
                PathwayActivityCard(aggregate: aggregate, stale: context.isStale)
                    .padding(12)
                    .activityBackgroundTint(.black)
                    .activitySystemActionForegroundColor(.white)
                    .widgetURL(aggregate.activities.first?.url)
            } else {
                Label("Open Pathway to refresh activity", systemImage: "arrow.clockwise")
                    .padding().foregroundStyle(.white)
            }
        } dynamicIsland: { context in
            let aggregate = context.state.aggregate
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Pathway", systemImage: "sparkles").font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let aggregate { Text("\(aggregate.activeCount) active").font(.caption).monospacedDigit() }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let aggregate {
                        VStack(alignment: .leading, spacing: 6) {
                            if context.isStale { Label("Reconnect to update", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary) }
                            ForEach(Array(aggregate.activities.prefix(3))) { row in PathwayActivityRowView(row: row) }
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: aggregate?.activities.first?.symbol ?? "sparkles")
            } compactTrailing: {
                if let aggregate { Text("\(aggregate.activeCount)").monospacedDigit() }
            } minimal: {
                Image(systemName: aggregate?.activities.first?.symbol ?? "sparkles")
            }
            .widgetURL(aggregate?.activities.first?.url)
            .keylineTint(.cyan)
        }
    }
}

private struct PathwayActivityCard: View {
    let aggregate: PathwayActivityAggregate
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(aggregate.title, systemImage: "sparkles").font(.headline).lineLimit(1)
                Spacer()
                if aggregate.activeCount > 0 { Text("\(aggregate.activeCount) active").font(.caption).monospacedDigit() }
            }
            Text(stale ? "Reconnect to update" : aggregate.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            ForEach(Array(aggregate.activities.prefix(2))) { row in PathwayActivityRowView(row: row) }
        }
        .foregroundStyle(.white)
    }
}

private struct PathwayActivityRowView: View {
    let row: PathwayActivityRow
    var body: some View {
        if let url = row.url { Link(destination: url) { content } }
        else { content }
    }
    private var content: some View {
        HStack(spacing: 8) {
            Image(systemName: row.symbol).foregroundStyle(tint).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.threadTitle).font(.subheadline).lineLimit(1)
                Text("\(row.projectTitle) · \(row.status)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
    private var tint: Color {
        switch row.phase {
        case "failed": .red
        case "waiting_for_input", "waiting_for_approval": .orange
        case "completed": .green
        case "stale": .gray
        default: .cyan
        }
    }
}

#endif
