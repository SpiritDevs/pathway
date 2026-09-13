import SwiftUI

struct PathwayCalendarSettingsView: View {
    @Bindable var model: PathwayCalendarModel
    let companyID: String
    @State private var name = ""
    @State private var newID = UUID().uuidString.lowercased()
    var body: some View {
        Form {
            Section("My calendars") {
                ForEach(model.calendars.filter { $0.companyID == companyID && model.canEdit($0) }) { calendar in
                    NavigationLink(calendar.string("name")) { PathwayCalendarSharingView(model: model, original: calendar) }
                }
            }
            Section("Create calendar") {
                TextField("Calendar name", text: $name)
                Button("Create") {
                    Task {
                        if await model.perform({ _ = try await model.request("create", companyID: companyID, fields: ["id": .string(newID), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]) }) {
                            name = ""; newID = UUID().uuidString.lowercased()
                        }
                    }
                }.disabled(model.isWriting || companyID.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Shared calendars") {
                ForEach(model.calendars.filter { $0.companyID == companyID && !model.canEdit($0) }) { calendar in
                    LabeledContent(calendar.string("name"), value: calendar.string("kind") == "google" ? "Google · read only" : "Read only")
                }
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Calendar settings")
    }
}

private struct PathwayCalendarSharingView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayCalendarModel
    let original: PathwayCalendarRecord
    @State private var name = ""
    @State private var sharing = "private"
    @State private var teamID = ""
    @State private var memberID = ""
    @State private var grants: [PathwayCalendarRecord] = []
    @State private var deleting = false
    private var calendar: PathwayCalendarRecord? { model.calendars.first { $0.id == original.id && model.canEdit($0) } }
    var body: some View {
        Group {
            if let calendar {
                Form {
                    Section {
                        TextField("Name", text: $name)
                        Picker("Visible to", selection: $sharing) { Text("Private").tag("private"); Text("Team").tag("team"); Text("Company").tag("company") }
                        if sharing == "team" {
                            Picker("Team", selection: $teamID) {
                                Text("Choose a team").tag("")
                                ForEach(model.teams.filter { $0.companyID == calendar.companyID }) { Text($0.string("name")).tag($0.entityID) }
                            }
                        }
                        Button("Save calendar") {
                            Task { _ = await model.perform { _ = try await model.request("update", companyID: calendar.companyID, fields: ["calendarId": .string(calendar.entityID), "name": .string(name), "sharing": .string(sharing), "teamId": sharing == "team" ? .string(teamID) : .null]) } }
                        }.disabled(model.isWriting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (sharing == "team" && teamID.isEmpty))
                    }
                    Section("Individual access") {
                        ForEach(grants) { grant in
                            HStack {
                                Text(grant.string("granteeName"))
                                Spacer()
                                Button("Revoke", role: .destructive) {
                                    Task {
                                        if await model.perform({ _ = try await model.request("revoke", companyID: calendar.companyID, fields: ["calendarId": .string(calendar.entityID), "granteeMembershipId": grant.fields["granteeMembershipId"] ?? .null]) }) { await loadGrants(calendar) }
                                    }
                                }.disabled(model.isWriting)
                            }
                        }
                        Picker("Member", selection: $memberID) {
                            Text("Choose a member").tag("")
                            ForEach(model.members.filter { $0.companyID == calendar.companyID && $0.entityID != calendar.string("ownerMembershipId") }) {
                                Text($0.string("displayNameSnapshot").isEmpty ? $0.string("emailSnapshot") : $0.string("displayNameSnapshot")).tag($0.entityID)
                            }
                        }
                        Button("Share calendar") {
                            Task {
                                if await model.perform({ _ = try await model.request("share", companyID: calendar.companyID, fields: ["id": .string(UUID().uuidString.lowercased()), "calendarId": .string(calendar.entityID), "granteeMembershipId": .string(memberID)]) }) { await loadGrants(calendar); memberID = "" }
                            }
                        }.disabled(memberID.isEmpty || model.isWriting)
                    }
                    Section { Button("Delete calendar", role: .destructive) { deleting = true }.disabled(model.isWriting) }
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
                .task(id: calendar.id) { name = calendar.string("name"); sharing = calendar.string("sharing"); teamID = calendar.string("teamId"); await loadGrants(calendar) }
                .confirmationDialog("Delete this calendar and its events?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete calendar", role: .destructive) { Task { if await model.perform({ _ = try await model.request("remove", companyID: calendar.companyID, fields: ["calendarId": .string(calendar.entityID)]) }) { dismiss() } } }
                }
            } else { ContentUnavailableView("Calendar unavailable", systemImage: "calendar.badge.exclamationmark") }
        }.navigationTitle("Sharing")
    }
    private func loadGrants(_ calendar: PathwayCalendarRecord) async {
        do {
            let result = try await model.request("listGrants", companyID: calendar.companyID, fields: ["calendarId": .string(calendar.entityID)], kind: "query")
            grants = (result.arrayValue ?? []).compactMap(\.objectValue).map { .init(companyID: calendar.companyID, kind: "grant", fields: $0) }
        } catch { model.errorMessage = error.localizedDescription }
    }
}
