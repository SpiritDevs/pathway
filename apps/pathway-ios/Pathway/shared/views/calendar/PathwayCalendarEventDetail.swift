import SwiftUI
import UniformTypeIdentifiers

struct PathwayCalendarEventDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Bindable var model: PathwayCalendarModel
    let original: PathwayCalendarRecord
    @State private var editing = false
    @State private var deleting = false
    @State private var importing = false
    private var event: PathwayCalendarRecord? { model.events.first { $0.id == original.id } }
    var body: some View {
        Group {
            if let event {
                Form {
                    Section {
                        Text(event.string("title")).font(.title2)
                        if let start = event.date("startAt"), let end = event.date("endAt") {
                            LabeledContent("Starts", value: start.formatted(date: .abbreviated, time: event.fields["allDay"]?.boolValue == true ? .omitted : .shortened))
                            LabeledContent("Ends", value: end.formatted(date: .abbreviated, time: event.fields["allDay"]?.boolValue == true ? .omitted : .shortened))
                        }
                        LabeledContent("Time zone", value: event.string("timeZone"))
                        if !event.string("location").isEmpty { LabeledContent("Location", value: event.string("location")) }
                        if !event.string("notes").isEmpty { Text(event.string("notes")).textSelection(.enabled) }
                        ForEach((event.fields["urls"]?.arrayValue ?? []).compactMap(\.stringValue), id: \.self) { value in
                            if let url = URL(string: value), ["http", "https"].contains(url.scheme ?? "") { Link(value, destination: url) }
                        }
                    }
                    Section("Invitees") {
                        ForEach((event.fields["invitees"]?.arrayValue ?? []).compactMap(\.objectValue).map { PathwayCalendarRecord(companyID: event.companyID, kind: "invitee", fields: $0.merging(["id": $0["email"] ?? .string("")]) { _, new in new }) }) { row in
                            let person = row.fields
                            LabeledContent(person["email"]?.stringValue ?? "Invitee", value: person["response"]?.stringValue ?? "needs-action")
                        }
                    }
                    Section("Attachments") {
                        ForEach((event.fields["attachments"]?.arrayValue ?? []).compactMap(\.objectValue).map { PathwayCalendarRecord(companyID: event.companyID, kind: "attachment", fields: $0) }) { row in
                            let attachment = row.fields
                            HStack {
                                Button(attachment["fileName"]?.stringValue ?? "Attachment") {
                                    Task { _ = await model.perform { openURL(try await model.attachmentURL(event, id: attachment["id"]?.stringValue ?? "")) } }
                                }
                                Spacer()
                                if model.canEditEvent(event) {
                                    Button("Remove attachment", systemImage: "trash", role: .destructive) {
                                        Task { _ = await model.perform { _ = try await model.request("removeEventAttachment", companyID: event.companyID, fields: ["eventId": .string(event.entityID), "attachmentId": attachment["id"] ?? .null]) } }
                                    }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                                }
                            }
                        }
                        if model.canEditEvent(event) { Button("Add attachment", systemImage: "paperclip") { importing = true }.disabled(model.isWriting) }
                    }
                    if model.canEditEvent(event) {
                        Section { Button("Edit event") { editing = true }; Button("Delete event", role: .destructive) { deleting = true } }
                    }
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
                .environment(\.timeZone, TimeZone(identifier: event.string("timeZone")) ?? .current)
                .sheet(isPresented: $editing) { PathwayCalendarEventEditor(model: model, companyID: event.companyID, event: event) }
                .confirmationDialog("Delete this event?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete event", role: .destructive) { Task { if await model.perform({ try await model.delete(event) }) { dismiss() } } }
                }
                .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
                    Task { _ = await model.perform { let url = try result.get(); try await model.upload(event, url: url, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream") } }
                }
            } else { ContentUnavailableView("Event unavailable", systemImage: "calendar.badge.exclamationmark", description: Text("It may have been deleted or its sharing permissions changed.")) }
        }
        .navigationTitle("Event")
    }
}
