import SwiftUI

struct DocumentInformationHistoryTab: View {
    let events: [DocumentHistoryEvent]

    var body: some View {
        if events.isEmpty {
            ContentUnavailableView(
                "No History Yet",
                systemImage: "clock.arrow.circlepath",
                description: Text("Document activity will appear here.")
            )
        } else {
            List(events.sorted { $0.timeStamp > $1.timeStamp }) { event in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: event.systemImage)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(event.tint)
                        .frame(width: 34, height: 34)
                        .background(event.tint.opacity(0.12), in: Circle())
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.title)
                            .font(.body.weight(.medium))
                        if let actor = event.actor, !actor.isEmpty {
                            Text(actor)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Text(event.date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 5)
                .accessibilityElement(children: .combine)
            }
            .listStyle(.plain)
        }
    }
}

private extension DocumentHistoryEvent {
    var title: String { eventCode.formattedDocumentStatus }

    var actor: String? {
        actorDisplay ?? userName
    }

    var date: Date {
        Date(timeIntervalSince1970: timeStamp / 1_000)
    }

    var systemImage: String {
        if eventCode.contains("send") { return "paperplane" }
        if eventCode.contains("view") || eventCode.contains("open") { return "eye" }
        if eventCode.contains("accept") { return "checkmark.circle" }
        if eventCode.contains("recipient") { return "person.2" }
        if eventCode.contains("status") { return "arrow.triangle.2.circlepath" }
        return "doc.badge.clock"
    }

    var tint: Color {
        if eventCode.contains("accept") { return .green }
        if eventCode.contains("send") { return .blue }
        if eventCode.contains("delete") || eventCode.contains("remove") { return .red }
        return .orange
    }
}
