import SwiftUI

struct PathwayCompanyAdministrationView: View {
    let companies: [PathwayCompany]
    let request: PathwayCompanyAdministrationRequest
    let entities: PathwayCompanyAdministrationEntities
    @State private var newName = ""
    @State private var createID = UUID().uuidString
    @State private var creating = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(companies) { company in
                NavigationLink {
                    PathwayCompanyDetailView(company: company, request: request, entities: entities)
                } label: {
                    VStack(alignment: .leading) { Text(company.name); Text(company.workspaceKind == "organization" ? "Organization" : "Personal workspace").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.navigationTitle("Companies & people")
            .toolbar { Button("Create company", systemImage: "plus") { creating = true } }
            .sheet(isPresented: $creating) {
                NavigationStack {
                    Form {
                        TextField("Company name", text: $newName)
                        if let error { Text(error).foregroundStyle(.red) }
                        Button("Create company") { Task { await create() } }.disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    }.navigationTitle("New company").toolbar { Button("Cancel", role: .cancel) { creating = false } }
                }
            }
    }
    private func create() async {
        busy = true; defer { busy = false }
        do {
            _ = try await request("mutation", "companies:create", ["id": .string(createID), "name": .string(newName)])
            creating = false; newName = ""; createID = UUID().uuidString; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct PathwayCompanyDetailView: View {
    let company: PathwayCompany
    @State private var model: PathwayCompanyAdministrationModel
    @State private var name: String
    @State private var offlineDays = 7
    @State private var loadedOfflineDays = false
    @State private var confirmation: String?
    init(company: PathwayCompany, request: @escaping PathwayCompanyAdministrationRequest, entities: @escaping PathwayCompanyAdministrationEntities) {
        self.company = company
        _model = State(initialValue: .init(company: company, request: request, entities: entities))
        _name = State(initialValue: company.name)
    }
    var body: some View {
        List {
            PathwayCompanyAdminFeedback(model: model)
            if model.company.lifecycleState != "active" {
                Section {
                    Text("This company is \(model.company.lifecycleState).")
                    if model.company.isOwner && model.company.lifecycleState == "deletionScheduled" { Button("Restore company") { Task { _ = await model.mutate("companies:restore", reload: false) } } }
                }
            } else {
                Section("Company") {
                    TextField("Name", text: $name)
                    Button("Save name") { Task { _ = await model.mutate("companies:rename", fields: ["name": .string(name)]) } }
                        .disabled(!model.allows("company.manage") || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if loadedOfflineDays {
                        Stepper("Offline access: \(offlineDays) days", value: $offlineDays, in: 0...90)
                        Button("Save offline access policy") { Task { _ = await model.mutate("companies:setOfflineAccessDays", fields: ["days": .number(Double(offlineDays))]) } }.disabled(!model.allows("company.manage"))
                    }
                }
                if model.isOrganization {
                    NavigationLink { PathwayCompanyMembersView(model: model) } label: { Label("Members", systemImage: "person.2") }
                    NavigationLink { PathwayCompanyTeamsView(model: model) } label: { Label("Teams", systemImage: "person.3") }
                    NavigationLink { PathwayCompanyRolesView(model: model) } label: { Label("Roles & permissions", systemImage: "key") }
                    NavigationLink { PathwayCompanyInvitationsView(model: model) } label: { Label("Invitations", systemImage: "envelope") }
                    Button("Leave company", role: .destructive) { confirmation = "leave" }
                }
                if model.company.isOwner { Button("Schedule company deletion", role: .destructive) { confirmation = "delete" } }
            }
        }.navigationTitle(model.company.name).disabled(model.busy)
            .task { await model.load(); if let days = model.offlineDays { offlineDays = days; loadedOfflineDays = true } }
            .refreshable { await model.load() }
            .onChange(of: company) { _, value in model.company = value }
            .confirmationDialog(confirmation == "leave" ? "Leave this company?" : "Schedule company deletion?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
                Button(confirmation == "leave" ? "Leave company" : "Schedule deletion", role: .destructive) {
                    if let confirmation { self.confirmation = nil; Task { _ = await model.mutate(confirmation == "leave" ? "memberships:leave" : "companies:scheduleDeletion", reload: false) } }
                }
                Button("Cancel", role: .cancel) { confirmation = nil }
            } message: { Text("Access to this company's work will change. The server protects the last active owner. Scheduled deletion can be restored only within its recovery window.") }
    }
}

struct PathwayCompanyAdminFeedback: View {
    let model: PathwayCompanyAdministrationModel
    var body: some View {
        if model.busy { ProgressView("Updating company…") }
        if !model.errors.isEmpty { Text(model.errors.joined(separator: "\n")).foregroundStyle(.red) }
        if let notice = model.notice { Text(notice).foregroundStyle(.secondary) }
    }
}
