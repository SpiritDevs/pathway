import SwiftUI

struct PathwayCompanyInvitationsView: View {
    let model: PathwayCompanyAdministrationModel
    @State private var invitation: PathwayCompanyAdminInvitation?
    @State private var action: String?
    @State private var now = Date()
    @Environment(\.scenePhase) private var scenePhase
    private var resendDeadlines: [Date] {
        model.invitations.filter { $0.state != "accepted" && $0.state != "revoked" }.compactMap(\.resendAvailableAt).sorted()
    }
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            ForEach(model.invitations) { invitation in
                VStack(alignment: .leading, spacing: 6) {
                    Text(invitation.email)
                    Text(invitation.state).font(.caption).foregroundStyle(.secondary)
                    Text("Expires \(Date(timeIntervalSince1970: invitation.expiresAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                    if model.allows("members.invite") && invitation.state != "accepted" && invitation.state != "revoked" {
                        HStack {
                            Button("Resend") { self.invitation = invitation; action = "resend" }.disabled(!invitation.canResend(at: now))
                            Button("Revoke", role: .destructive) { self.invitation = invitation; action = "revoke" }
                        }
                    }
                }
            }
            if model.invitations.isEmpty { Text("No invitations") }
        }.navigationTitle("Invitations").disabled(model.busy).refreshable { await model.load() }
            .task(id: resendDeadlines) {
                now = Date()
                for deadline in resendDeadlines where deadline > now {
                    do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) }
                    catch { return }
                    now = Date()
                }
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active { now = Date() } }
            .toolbar { if model.allows("members.invite") { NavigationLink { PathwayCompanyInviteEditor(model: model) } label: { Image(systemName: "plus") }.accessibilityLabel("Invite member") } }
            .confirmationDialog(action == "resend" ? "Resend invitation email?" : "Revoke invitation?", isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } })) {
                Button(action == "resend" ? "Send email" : "Revoke", role: action == "resend" ? nil : .destructive) {
                    if let invitation, let action { self.action = nil; Task { _ = await model.mutate(action == "resend" ? "invitations:resend" : "invitations:revoke", fields: ["invitationId": .string(invitation.id)], kind: action == "resend" ? "action" : "mutation") } }
                }
                Button("Cancel", role: .cancel) { action = nil }
            } message: { Text(invitation?.email ?? "") }
    }
}
struct PathwayCompanyInviteEditor: View {
    let model: PathwayCompanyAdministrationModel
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var selectedTeams = Set<String>()
    @State private var selectedRoles = Set<String>()
    @State private var invitationID = UUID().uuidString
    @State private var confirm = false
    var body: some View {
        Form {
            PathwayCompanyAdminFeedback(model: model)
            TextField("Email address", text: $email).textContentType(.emailAddress).autocorrectionDisabled().textInputAutocapitalization(.never)
            Section("Teams") {
                ForEach(model.teams.filter { $0.archivedAt == nil }) { team in
                    Toggle(team.name, isOn: Binding(get: { selectedTeams.contains(team.id) }, set: { if $0 { selectedTeams.insert(team.id) } else { selectedTeams.remove(team.id) } }))
                }
            }
            Section("Company roles") {
                ForEach(model.roles) { role in
                    Toggle(role.name, isOn: Binding(get: { selectedRoles.contains(role.id) }, set: { if $0 { selectedRoles.insert(role.id) } else { selectedRoles.remove(role.id) } }))
                }
            }
            Button("Send invitation") { confirm = true }.disabled(!email.contains("@") || !model.allows("members.invite"))
        }.navigationTitle("Invite member").disabled(model.busy)
            .confirmationDialog("Send invitation email?", isPresented: $confirm) {
                Button("Send invitation") { Task { await send() } }; Button("Cancel", role: .cancel) { }
            } message: { Text("Invite \(email) to \(model.company.name) with the selected teams and roles.") }
    }
    private func send() async {
        if await model.mutate("invitations:create", fields: ["id": .string(invitationID), "email": .string(email), "teamIds": .array(selectedTeams.sorted().map(JSONValue.string)), "roleIds": .array(selectedRoles.sorted().map(JSONValue.string))], kind: "action") { dismiss() }
    }
}
