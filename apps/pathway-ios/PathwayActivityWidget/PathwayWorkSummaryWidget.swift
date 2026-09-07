import SwiftUI
import WidgetKit

struct PathwayWorkSummaryEntry: TimelineEntry {
    let date: Date
    let snapshot: PathwayWorkWidgetSnapshot?
}

struct PathwayWorkSummaryProvider: TimelineProvider {
    func placeholder(in context: Context) -> PathwayWorkSummaryEntry {
        PathwayWorkSummaryEntry(date: Date(), snapshot: nil)
    }
    func getSnapshot(in context: Context, completion: @escaping (PathwayWorkSummaryEntry) -> Void) {
        completion(currentEntry())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<PathwayWorkSummaryEntry>) -> Void) {
        // Reads saved app data only. A timeline refresh updates the age label, never the work counts.
        let entry = currentEntry()
        completion(Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(900))))
    }
    private func currentEntry() -> PathwayWorkSummaryEntry {
        PathwayWorkSummaryEntry(date: Date(), snapshot: PathwayWorkWidgetStore.read(directory: PathwayWorkWidgetStore.sharedDirectory))
    }
}

struct PathwayWorkSummaryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: PathwayWorkWidgetStore.kind, provider: PathwayWorkSummaryProvider()) { entry in
            PathwayWorkSummaryView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Work Summary")
        .description("Saved running and attention counts. Open Pathway to refresh or draft a new thread.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct PathwayWorkSummaryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PathwayWorkSummaryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Pathway", systemImage: "sparkles").font(.headline)
            if let snapshot = entry.snapshot {
                if family == .systemMedium {
                    HStack(spacing: 20) {
                        Link(destination: PathwayWorkWidgetDestination.running.url) {
                            count(snapshot.runningCount, title: "Running", symbol: "play.circle")
                        }
                        Link(destination: PathwayWorkWidgetDestination.attention.url) {
                            count(snapshot.attentionCount, title: "Needs attention", symbol: "exclamationmark.bubble")
                        }
                        Spacer(minLength: 0)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(snapshot.runningCount) running").font(.title3).bold().monospacedDigit()
                        Text("\(snapshot.attentionCount) need attention").font(.caption).monospacedDigit()
                    }
                }
                HStack(spacing: 3) {
                    Text("Saved")
                    Text(snapshot.updatedAt, style: .relative)
                    Text("ago")
                }
                .font(.caption2).foregroundStyle(.secondary)
                .accessibilityLabel("Last saved \(snapshot.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                if family == .systemMedium {
                    Link(destination: PathwayWorkWidgetDestination.draft.url) {
                        Label("New draft", systemImage: "square.and.pencil").font(.caption)
                    }
                } else {
                    Text(snapshot.attentionCount > 0 ? "Open needs attention" : "Open running")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("Open Pathway to load your work.").font(.subheadline)
                Text("Sign in to refresh the saved summary.").font(.caption2).foregroundStyle(.secondary)
                if family == .systemMedium {
                    Link("New draft", destination: PathwayWorkWidgetDestination.draft.url).font(.caption)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(primaryDestination.url)
        .privacySensitive()
    }

    private var primaryDestination: PathwayWorkWidgetDestination {
        (entry.snapshot?.attentionCount ?? 0) > 0 ? .attention : .running
    }
    private func count(_ value: Int, title: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value, format: .number).font(.title2).bold().monospacedDigit()
            Label(title, systemImage: symbol).font(.caption).lineLimit(2)
        }
    }
}
