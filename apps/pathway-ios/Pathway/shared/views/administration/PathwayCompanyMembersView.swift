import SwiftUI

struct PathwayCompanyMembersView: View {
    let model: PathwayCompanyAdministrationModel
    @State private var query = ""
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            ForEach(model.members.filter { query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query) || $0.email.localizedCaseInsensitiveContains(query) }) { member in
                NavigationLink { PathwayCompanyMemberView(model: model, membershipID: member.id) } label: {
                    VStack(alignment: .leading) {
                        Text(member.displayName.isEmpty ? member.email : member.displayName)
                        Text("\(member.email) · \(member.isOwner ? "Owner · " : "")\(member.state)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.navigationTitle("Members").searchable(text: $query).refreshable { await model.load() }
    }
}

struct PathwayCompanyMemberView: View {
    let model: PathwayCompanyAdministrationModel
    let membershipID: String
    @State private var confirmation: String?
    private var member: PathwayCompanyAdminMember? { model.members.first { $0.id == membershipID } }
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            if let member {
                Section {
                    Text(member.displayName).font(.headline)
                    Text(member.email).textSelection(.enabled)
                    LabeledContent("State", value: member.state)
                    LabeledContent("Owner", value: member.isOwner ? "Yes" : "No")
                }
                Section("Team membership") {
                    ForEach(model.teams) { team in
                        Toggle(team.name + (team.archivedAt == nil ? "" : " (archived)"), isOn: Binding(get: { member.teamIds.contains(team.id) }, set: { enabled in
                            Task { _ = await model.mutate(enabled ? "teams:addMember" : "teams:removeMember", fields: ["teamId": .string(team.id), "membershipId": .string(member.id)]) }
                        })).disabled(!model.allows("teams.manage") || !member.canChangeMembership(in: team))
                    }
                }
                Section("Roles") {
                    ForEach(model.assignments.filter { $0.membershipId == membershipID }) { assignment in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(model.roles.first { $0.id == assignment.roleId }?.name ?? "Role unavailable")
                                Text(assignment.scope.kind == "company" ? "Whole company" : (model.teams.first { $0.id == assignment.scope.teamId }?.name ?? "Team")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Remove", role: .destructive) { confirmation = "role:" + assignment.id }.disabled(!model.allows("roles.manage"))
                        }
                    }
                    if member.state == "active" && model.allows("roles.manage") {
                        NavigationLink("Assign role") { PathwayCompanyAssignRoleView(model: model, membershipID: membershipID) }
                    }
                }
                if member.state != "left" {
                    Section("Access") {
                        if model.allows("members.manage") {
                            Button(member.state == "locked" ? "Unlock member" : "Lock member", role: member.state == "locked" ? nil : .destructive) { confirmation = member.state == "locked" ? "unlock" : "lock" }
                                .disabled(PathwayCompanyAdministrationPermissions.isLastActiveOwner(member, members: model.members))
                            Button("Remove member", role: .destructive) { confirmation = "remove" }
                                .disabled(PathwayCompanyAdministrationPermissions.isLastActiveOwner(member, members: model.members))
                        }
                        if model.company.isOwner && member.state == "active" {
                            Button(member.isOwner ? "Revoke ownership" : "Grant ownership") { confirmation = member.isOwner ? "revokeOwner" : "grantOwner" }
                                .disabled(member.isOwner && PathwayCompanyAdministrationPermissions.isLastActiveOwner(member, members: model.members))
                        }
                    }
                } else {
                    Text("A departed member returns through a new invitation.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("Member").disabled(model.busy)
            .confirmationDialog("Change member access?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
                Button(actionLabel, role: .destructive) { if let confirmation { self.confirmation = nil; Task { await perform(confirmation) } } }
                Button("Cancel", role: .cancel) { confirmation = nil }
            } message: { Text("This changes the member's access to company data. The server checks current permissions and preserves at least one active owner.") }
    }
    private var actionLabel: String {
        switch confirmation { case "lock": "Lock member"; case "unlock": "Unlock member"; case "remove": "Remove member"; case "grantOwner": "Grant ownership"; case "revokeOwner": "Revoke ownership"; default: "Remove role assignment" }
    }
    private func perform(_ action: String) async {
        if action.hasPrefix("role:") { _ = await model.mutate("roles:unassign", fields: ["assignmentId": .string(String(action.dropFirst(5)))]); return }
        var fields: [String: JSONValue] = ["membershipId": .string(membershipID)]
        let method: String
        switch action {
        case "lock", "unlock": method = "memberships:setState"; fields["state"] = .string(action == "lock" ? "locked" : "active")
        case "remove": method = "memberships:remove"
        case "grantOwner": method = "companies:addOwner"
        default: method = "companies:removeOwner"
        }
        _ = await model.mutate(method, fields: fields)
    }
}

struct PathwayCompanyAssignRoleView: View {
    let model: PathwayCompanyAdministrationModel
    let membershipID: String
    @Environment(\.dismiss) private var dismiss
    @State private var roleID = ""
    @State private var teamID = ""
    @State private var assignmentID = UUID().uuidString
    var body: some View {
        Form {
            PathwayCompanyAdminFeedback(model: model)
            Picker("Role", selection: $roleID) { Text("Choose role").tag(""); ForEach(model.roles) { Text($0.name).tag($0.id) } }
            Picker("Scope", selection: $teamID) { Text("Whole company").tag(""); ForEach(model.teams.filter { $0.archivedAt == nil }) { Text($0.name).tag($0.id) } }
            Text("Team-scoped roles do not grant company administration permissions.").font(.caption).foregroundStyle(.secondary)
            Button("Assign role") { Task { await assign() } }.disabled(roleID.isEmpty || !model.allows("roles.manage"))
        }.navigationTitle("Assign role").disabled(model.busy)
    }
    private func assign() async {
        let scope: JSONValue = teamID.isEmpty ? .object(["kind": .string("company")]) : .object(["kind": .string("team"), "teamId": .string(teamID)])
        if await model.mutate("roles:assign", fields: ["id": .string(assignmentID), "membershipId": .string(membershipID), "assignment": .object(["roleId": .string(roleID), "scope": scope])]) { dismiss() }
    }
}
