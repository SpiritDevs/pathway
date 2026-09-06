import SwiftUI

struct PathwayContactsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Bindable var model: PathwayContactsModel
    let companies: [PathwayCompany]
    var initialFilter = "people"
    @State private var companyID = ""
    @State private var query = ""
    @State private var searchField = "name"
    @State private var editing: PathwayContact?
    @State private var retry = 0
    private var filtered: [PathwayContact] { model.contacts }
    private var canManage: Bool { PathwayContactsModel.canManage(companyID: companyID, companies: appModel.cloud.companies, entities: appModel.cloud.issues.entities) }
    var body: some View {
        List {
            Section { Picker("Workspace", selection: $companyID) { ForEach(companies) { Text($0.name).tag($0.id) } } }
            Section {
                Picker("Search in", selection: $searchField) {
                    Text("Name").tag("name"); Text("Role").tag("role"); Text("Company").tag("company"); Text("Email").tag("email"); Text("Phone").tag("phone")
                }
                Text("Search covers the entire workspace directory. Enter words or a word prefix in the selected field.").font(.caption).foregroundStyle(.secondary)
            }
            if model.loading { ProgressView("Loading contacts…") }
            ForEach(filtered) { contact in
                NavigationLink { PathwayContactDetail(model: model, companyID: companyID, contactID: contact.id) } label: {
                    VStack(alignment: .leading) {
                        HStack { Text(contact.name).font(.headline); if contact.favorite { Image(systemName: "star.fill").foregroundStyle(.yellow) } }
                        Text([contact.role, contact.company].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            if !model.loading && filtered.isEmpty { ContentUnavailableView("No contacts", systemImage: "person.crop.rectangle.stack", description: Text(canManage ? "Add a contact to this workspace, or change your search." : "No contacts match your search in this workspace.")) }
            if model.hasMore { Button(model.loadingMore ? "Loading…" : "Load more contacts") { Task { _ = await model.perform { try await model.loadMore() } } }.disabled(model.loadingMore) }
            if let error = model.errorMessage { Section { Text(error).foregroundStyle(.red); Button("Reconnect") { retry += 1 } } }
        }
        .navigationTitle("Contacts")
        .searchable(text: $query)
        .toolbar { if canManage { ToolbarItem(placement: .topBarTrailing) { Button("Add contact", systemImage: "plus") { editing = .draft() } } } }
        .onChange(of: companies, initial: true) { if !companies.contains(where: { $0.id == companyID }) { companyID = companies.first?.id ?? "" } }
        .task(id: "\(companyID):\(query):\(searchField):\(initialFilter):\(retry)") { await model.observe(companyID: companyID, search: query, searchField: searchField, favoritesOnly: initialFilter == "favorites") }
        .refreshable { retry += 1 }
        .sheet(item: $editing) { contact in PathwayContactEditor(model: model, companyID: companyID, contact: contact) }
        .onChange(of: canManage) { if !canManage { editing = nil } }
    }
}
private struct PathwayContactDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    @Bindable var model: PathwayContactsModel
    let companyID: String
    let contactID: String
    @State private var editing: PathwayContact?
    @State private var deleting = false
    @State private var contact: PathwayContact?
    @State private var loadError: String?
    @State private var loading = true
    @State private var loadedIdentity = ""
    private var canManage: Bool { PathwayContactsModel.canManage(companyID: companyID, companies: appModel.cloud.companies, entities: appModel.cloud.issues.entities) }
    var body: some View {
        Group {
            if let contact, loadedIdentity == "\(companyID):\(contactID)" {
                Form {
                    Section { Text(contact.name).font(.title2); LabeledContent("Role", value: contact.role); LabeledContent("Company", value: contact.company) }
                    Section("Contact") {
                        if !contact.email.isEmpty, let url = URL(string: "mailto:\(contact.email)") { Link(contact.email, destination: url) }
                        if !contact.phone.isEmpty, let url = URL(string: "tel:\(contact.phone)") { Link(contact.phone, destination: url) }
                    }
                    Section("Notes") { Text(contact.notes.isEmpty ? "No notes" : contact.notes).textSelection(.enabled) }
                    if canManage { Section { Button("Edit") { editing = contact }; Button("Delete contact", role: .destructive) { deleting = true } } }
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
                .confirmationDialog("Delete this contact from the workspace?", isPresented: $deleting, titleVisibility: .visible) { Button("Delete contact", role: .destructive) { Task { guard canManage else { return }; if await model.perform({ try await model.remove(contact, companyID: companyID) }) { dismiss() } } } }
            } else if loading { ProgressView("Loading contact…") }
            else { ContentUnavailableView("Contact unavailable", systemImage: "person.crop.rectangle", description: Text(loadError ?? "The contact may have been removed or its workspace may no longer be available.")) }
        }
        .navigationTitle("Contact")
        .task(id: "\(companyID):\(contactID)") {
            contact = nil; loadedIdentity = ""; loadError = nil; loading = true
            do { try await model.observeContact(companyID: companyID, contactID: contactID) { contact = $0; loadedIdentity = "\(companyID):\(contactID)"; loading = false } }
            catch { guard !Task.isCancelled else { return }; contact = nil; loading = false; loadError = error.localizedDescription }
        }
        .sheet(item: $editing) { contact in PathwayContactEditor(model: model, companyID: companyID, contact: contact) }
        .onChange(of: canManage) { if !canManage { editing = nil } }
    }
}
private struct PathwayContactEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(PathwayAppModel.self) private var appModel
    @Bindable var model: PathwayContactsModel
    let companyID: String
    @State private var contact: PathwayContact
    @State private var requestID = UUID().uuidString.lowercased()
    @State private var submitted: PathwayContact?
    init(model: PathwayContactsModel, companyID: String, contact: PathwayContact) { self.model = model; self.companyID = companyID; _contact = State(initialValue: contact) }
    private var canManage: Bool { PathwayContactsModel.canManage(companyID: companyID, companies: appModel.cloud.companies, entities: appModel.cloud.issues.entities) }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $contact.name)
                TextField("Role", text: $contact.role)
                TextField("Company", text: $contact.company)
                TextField("Email", text: $contact.email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                TextField("Phone", text: $contact.phone).keyboardType(.phonePad)
                TextField("Notes", text: $contact.notes, axis: .vertical).lineLimit(4...10)
                Toggle("Favorite", isOn: $contact.favorite)
                if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(contact.revision == 0 ? "Add contact" : "Edit contact")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard canManage else { return }
                        if let submitted, submitted != contact { requestID = UUID().uuidString.lowercased() }
                        submitted = contact
                        Task { if await model.perform({ try await model.save(contact, companyID: companyID, requestID: requestID) }) { dismiss() } }
                    }.disabled(!canManage || model.writing || contact.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
