import SwiftUI

struct PathwayContactsView: View {
    @Bindable var model: PathwayContactsModel
    let companies: [PathwayCompany]
    var initialFilter = "people"
    @State private var companyID = ""
    @State private var query = ""
    @State private var editing: PathwayContact?
    @State private var retry = 0
    private var filtered: [PathwayContact] { model.contacts.filter { (initialFilter != "favorites" || $0.favorite) && (query.isEmpty || [$0.name, $0.role, $0.company, $0.email, $0.phone].contains { $0.localizedCaseInsensitiveContains(query) }) } }
    var body: some View {
        List {
            Section { Picker("Workspace", selection: $companyID) { ForEach(companies) { Text($0.name).tag($0.id) } } }
            if model.loading { ProgressView("Loading contacts…") }
            ForEach(filtered) { contact in
                NavigationLink { PathwayContactDetail(model: model, companyID: companyID, contactID: contact.id) } label: {
                    VStack(alignment: .leading) {
                        HStack { Text(contact.name).font(.headline); if contact.favorite { Image(systemName: "star.fill").foregroundStyle(.yellow) } }
                        Text([contact.role, contact.company].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            if !model.loading && filtered.isEmpty { ContentUnavailableView("No contacts", systemImage: "person.crop.rectangle.stack", description: Text("Add a contact to this workspace, or change your search.")) }
            if let error = model.errorMessage { Section { Text(error).foregroundStyle(.red); Button("Reconnect") { retry += 1 } } }
        }
        .navigationTitle("Contacts")
        .searchable(text: $query)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Add contact", systemImage: "plus") { editing = .draft() }.disabled(companyID.isEmpty) } }
        .onChange(of: companies, initial: true) { if !companies.contains(where: { $0.id == companyID }) { companyID = companies.first?.id ?? "" } }
        .task(id: "\(companyID):\(retry)") { await model.observe(companyID: companyID) }
        .sheet(item: $editing) { contact in PathwayContactEditor(model: model, companyID: companyID, contact: contact) }
    }
}
private struct PathwayContactDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayContactsModel
    let companyID: String
    let contactID: String
    @State private var editing: PathwayContact?
    @State private var deleting = false
    var body: some View {
        Group {
            if let contact = model.contacts.first(where: { $0.id == contactID }), model.companyID == companyID {
                Form {
                    Section { Text(contact.name).font(.title2); LabeledContent("Role", value: contact.role); LabeledContent("Company", value: contact.company) }
                    Section("Contact") {
                        if !contact.email.isEmpty, let url = URL(string: "mailto:\(contact.email)") { Link(contact.email, destination: url) }
                        if !contact.phone.isEmpty, let url = URL(string: "tel:\(contact.phone)") { Link(contact.phone, destination: url) }
                    }
                    Section("Notes") { Text(contact.notes.isEmpty ? "No notes" : contact.notes).textSelection(.enabled) }
                    Section { Button("Edit") { editing = contact }; Button("Delete contact", role: .destructive) { deleting = true } }
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
                .confirmationDialog("Delete this contact from the workspace?", isPresented: $deleting, titleVisibility: .visible) { Button("Delete contact", role: .destructive) { Task { if await model.perform({ try await model.remove(contact, companyID: companyID) }) { dismiss() } } } }
            } else { ContentUnavailableView("Contact unavailable", systemImage: "person.crop.rectangle") }
        }
        .navigationTitle("Contact")
        .sheet(item: $editing) { contact in PathwayContactEditor(model: model, companyID: companyID, contact: contact) }
    }
}
private struct PathwayContactEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayContactsModel
    let companyID: String
    @State private var contact: PathwayContact
    @State private var requestID = UUID().uuidString.lowercased()
    @State private var submitted: PathwayContact?
    init(model: PathwayContactsModel, companyID: String, contact: PathwayContact) { self.model = model; self.companyID = companyID; _contact = State(initialValue: contact) }
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
                        if let submitted, submitted != contact { requestID = UUID().uuidString.lowercased() }
                        submitted = contact
                        Task { if await model.perform({ try await model.save(contact, companyID: companyID, requestID: requestID) }) { dismiss() } }
                    }.disabled(model.writing || contact.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
