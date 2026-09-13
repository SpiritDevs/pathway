import SwiftUI

struct PathwayCompanyTeamsView: View {
    let model: PathwayCompanyAdministrationModel
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            ForEach(model.teams) { team in
                NavigationLink { PathwayCompanyTeamEditor(model: model, team: team) } label: {
                    VStack(alignment: .leading) {
                        Text(team.name)
                        Text("\(team.memberCount) members\(team.archivedAt == nil ? "" : " · archived")").font(.caption).foregroundStyle(.secondary)
                        if !team.description.isEmpty { Text(team.description).font(.caption) }
                    }
                }
            }
        }.navigationTitle("Teams").refreshable { await model.load() }
            .toolbar { if model.allows("teams.manage") { NavigationLink { PathwayCompanyTeamEditor(model: model) } label: { Image(systemName: "plus") }.accessibilityLabel("Create team") } }
    }
}
struct PathwayCompanyTeamEditor: View {
    let model: PathwayCompanyAdministrationModel
    var team: PathwayCompanyAdminTeam?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var id = UUID().uuidString
    @State private var initialized = false
    var body: some View {
        Form {
            PathwayCompanyAdminFeedback(model: model)
            TextField("Name", text: $name)
            TextField("Description", text: $description, axis: .vertical)
            if team?.archivedAt != nil { Text("This team is archived. Its historical memberships and work remain visible.").foregroundStyle(.secondary) }
            Button("Save team") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.allows("teams.manage"))
            if let team {
                Section("Members") {
                    ForEach(model.members.filter { $0.state == "active" || $0.teamIds.contains(team.id) }) { member in
                        Toggle(member.displayName.isEmpty ? member.email : member.displayName, isOn: Binding(get: { member.teamIds.contains(team.id) }, set: { enabled in
                            Task { _ = await model.mutate(enabled ? "teams:addMember" : "teams:removeMember", fields: ["teamId": .string(team.id), "membershipId": .string(member.id)]) }
                        })).disabled(!model.allows("teams.manage") || !member.canChangeMembership(in: team))
                    }
                }
                if model.allows("teams.manage") {
                    Button(team.archivedAt == nil ? "Archive team" : "Restore team") {
                        Task {
                            if await model.mutate(team.archivedAt == nil ? "teams:archive" : "teams:restore", fields: ["teamId": .string(team.id)]) { dismiss() }
                        }
                    }
                }
            }
        }.navigationTitle(team == nil ? "New team" : "Team").disabled(model.busy)
            .task { guard !initialized else { return }; initialized = true; name = team?.name ?? ""; description = team?.description ?? "" }
    }
    private func save() async {
        var fields: [String: JSONValue] = ["name": .string(name), "description": .string(description)]
        fields[team == nil ? "id" : "teamId"] = .string(team?.id ?? id)
        if await model.mutate(team == nil ? "teams:create" : "teams:update", fields: fields) { dismiss() }
    }
}

struct PathwayCompanyRolesView: View {
    let model: PathwayCompanyAdministrationModel
    @State private var deleting: PathwayCompanyAdminRole?
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            ForEach(model.roles) { role in
                NavigationLink { PathwayCompanyRoleEditor(model: model, role: role) } label: {
                    VStack(alignment: .leading) { Text(role.name); Text(role.description).font(.caption).foregroundStyle(.secondary); Text("\(role.permissions.count) permissions").font(.caption) }
                }.swipeActions { if model.allows("roles.manage") { Button("Delete", role: .destructive) { deleting = role } } }
            }
        }.navigationTitle("Roles").refreshable { await model.load() }
            .toolbar { if model.allows("roles.manage") { NavigationLink { PathwayCompanyRoleEditor(model: model) } label: { Image(systemName: "plus") }.accessibilityLabel("Create role") } }
            .confirmationDialog("Delete this role and its assignments?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("Delete role", role: .destructive) { if let deleting { self.deleting = nil; Task { _ = await model.mutate("roles:remove", fields: ["roleId": .string(deleting.id)]) } } }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: { Text("Members lose permissions provided only by this role. Their other roles and ownership remain in effect.") }
    }
}
struct PathwayCompanyRoleEditor: View {
    let model: PathwayCompanyAdministrationModel
    var role: PathwayCompanyAdminRole?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var permissions = Set<String>()
    @State private var id = UUID().uuidString
    @State private var initialized = false
    var body: some View {
        Form {
            PathwayCompanyAdminFeedback(model: model)
            Section("Role") { TextField("Name", text: $name); TextField("Description", text: $description, axis: .vertical) }
            Section("Permissions") {
                ForEach(model.permissionCatalog, id: \.self) { permission in
                    Toggle(permission.replacingOccurrences(of: "issues.", with: "tasks.", options: .anchored).replacingOccurrences(of: ".", with: " · ").capitalized, isOn: Binding(get: { permissions.contains(permission) }, set: { if $0 { permissions.insert(permission) } else { permissions.remove(permission) } }))
                }
            }
            Button("Save role") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.allows("roles.manage"))
        }.navigationTitle(role == nil ? "New role" : "Role").disabled(model.busy || !model.allows("roles.manage"))
            .task { guard !initialized else { return }; initialized = true; name = role?.name ?? ""; description = role?.description ?? ""; permissions = Set(role?.permissions ?? []) }
    }
    private func save() async {
        var fields: [String: JSONValue] = ["name": .string(name), "description": .string(description), "permissions": .array(permissions.sorted().map(JSONValue.string))]
        fields[role == nil ? "id" : "roleId"] = .string(role?.id ?? id)
        if await model.mutate(role == nil ? "roles:create" : "roles:update", fields: fields) { dismiss() }
    }
}
