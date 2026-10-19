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
                    .padding(10)
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
                    Label { Text("Pathway") } icon: { PathwayActivityLogo().frame(width: 15, height: 20) }
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let aggregate { PathwayActivityStatusBadge(aggregate: aggregate, stale: context.isStale) }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let aggregate {
                        VStack(alignment: .leading, spacing: 6) {
                            if context.isStale && aggregate.activeCount > 0 { Label("Reconnect to update", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary) }
                            ForEach(Array(aggregate.activities.prefix(3))) { row in PathwayActivityRowView(row: row) }
                        }
                    }
                }
            } compactLeading: {
                PathwayActivityLogo().frame(width: 15, height: 20).foregroundStyle(.white)
                    .accessibilityLabel("Pathway")
            } compactTrailing: {
                if let aggregate {
                    PathwayActivityStatusBadge(aggregate: aggregate, stale: context.isStale)
                }
            } minimal: {
                if let aggregate {
                    PathwayActivityStatusBadge(aggregate: aggregate, stale: context.isStale)
                }
            }
            .widgetURL(aggregate?.activities.first?.url)
            .keylineTint(.cyan)
        }
    }
}

// Monochrome silhouette of the folded P in assets/prod/pathway-macos-1024.png.
private struct PathwayActivityLogo: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0.02, y: 0))
        path.addLine(to: CGPoint(x: 0.58, y: 0))
        path.addCurve(to: CGPoint(x: 0.58, y: 0.68), control1: CGPoint(x: 1.14, y: 0), control2: CGPoint(x: 1.14, y: 0.68))
        path.addLine(to: CGPoint(x: 0.305, y: 0.68))
        path.addLine(to: CGPoint(x: 0.305, y: 1))
        path.addLine(to: CGPoint(x: 0, y: 1))
        path.addLine(to: CGPoint(x: 0, y: 0.59))
        path.addLine(to: CGPoint(x: 0.305, y: 0.355))
        path.addLine(to: CGPoint(x: 0.305, y: 0.455))
        path.addLine(to: CGPoint(x: 0.575, y: 0.455))
        path.addCurve(to: CGPoint(x: 0.575, y: 0.225), control1: CGPoint(x: 0.765, y: 0.455), control2: CGPoint(x: 0.765, y: 0.225))
        path.addLine(to: CGPoint(x: 0.305, y: 0.225))
        path.closeSubpath()
        return path.applying(CGAffineTransform(scaleX: rect.width, y: rect.height))
            .applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }
}

private struct PathwayActivityStatusBadge: View {
    let aggregate: PathwayActivityAggregate
    let stale: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        if stale && aggregate.activeCount > 0 {
            Image(systemName: "wifi.slash").foregroundStyle(.gray)
                .accessibilityLabel("Reconnect to update thread status")
        } else if aggregate.runningThreadCount > 0 {
            ZStack {
                // WidgetKit animates updates for at most two seconds. Rotate once
                // when new activity arrives instead of running an app-side timer.
                Image(systemName: "circle.dotted")
                    .resizable()
                    .foregroundStyle(.cyan)
                    .symbolEffect(.rotate, options: .nonRepeating, value: reduceMotion || isLuminanceReduced ? "" : aggregate.updatedAt)
                Text(aggregate.runningThreadCount > 99 ? "99+" : "\(aggregate.runningThreadCount)")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .frame(width: 19)
            }
            .frame(width: 28, height: 28)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(aggregate.runningThreadCount) running threads")
        } else if let row = aggregate.restingStatusRow {
            Image(systemName: row.symbol).foregroundStyle(row.tint)
                .accessibilityLabel(row.hasQuestion ? "Thread has a question" : row.status)
        }
    }
}

private struct PathwayActivityCard: View {
    let aggregate: PathwayActivityAggregate
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Label { Text(aggregate.title) } icon: { PathwayActivityLogo().frame(width: 10, height: 13) }
                    .font(.caption.bold()).lineLimit(1)
                Spacer()
                if stale && aggregate.activeCount > 0 {
                    Label("Reconnect", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary)
                } else if aggregate.activeCount > 0 {
                    Text("\(aggregate.activeCount) active").font(.caption).monospacedDigit()
                }
            }
            ForEach(Array(aggregate.activities.prefix(3))) { row in PathwayActivityRowView(row: row) }
        }
        .foregroundStyle(.white)
    }
}

private struct PathwayActivityRowView: View {
    let row: PathwayActivityRow
    @ScaledMetric(relativeTo: .caption) private var timerWidth = 70
    var body: some View {
        if let url = row.url {
            Link(destination: url) { content }
                .buttonStyle(.plain)
                .accessibilityHint("Open this thread in Pathway")
        }
        else { content }
    }
    private var content: some View {
        HStack(spacing: 8) {
            Image(systemName: row.symbol).foregroundStyle(row.tint).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.threadTitle).font(.subheadline).lineLimit(1)
                    Spacer(minLength: 0)
                    status.font(.caption).monospacedDigit()
                }
                Text(row.projectTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    @ViewBuilder private var status: some View {
        if row.hasQuestion {
            Text("Question").foregroundStyle(.blue)
        } else if row.isComplete {
            Text(row.elapsedText ?? "Completed").foregroundStyle(.green)
                .accessibilityLabel(row.elapsedText.map { "Completed in \($0)" } ?? "Completed")
        } else if (row.phase == "running" || row.phase == "starting"), let start = row.startDate {
            Text(timerInterval: start...Date.distantFuture, countsDown: false)
                .frame(width: timerWidth, alignment: .trailing)
                .multilineTextAlignment(.trailing)
        } else {
            Text(row.status).foregroundStyle(row.tint)
        }
    }
}

private extension PathwayActivityRow {
    var tint: Color {
        switch phase {
        case "failed": .red
        case "waiting_for_input": .blue
        case "waiting_for_approval": .orange
        case "completed": .green
        case "stale": .gray
        default: .cyan
        }
    }
}

#endif
