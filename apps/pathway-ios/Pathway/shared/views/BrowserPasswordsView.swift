import SwiftUI

struct PathwaySavedBrowserLogin: Decodable, Identifiable {
    let id: String
    let label: String
    let origin: String
    let username: String
    let revision: Int
}

struct BrowserPasswordsView: View {
    @Environment(PathwayAppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let origin: String?
    var fill: ((String, String, String) async -> Bool)? = nil
    @State private var records: [PathwaySavedBrowserLogin] = []
    @State private var error: String?
    @State private var status: String?
    @State private var busy = false
    @State private var editing: PathwaySavedBrowserLogin?
    @State private var showsEditor = false
    @State private var pendingDelete: PathwaySavedBrowserLogin?

    var body: some View {
        NavigationStack {
            List {
                if let origin, fill != nil {
                    Section { Text("Select a saved login for \(origin). Filling does not submit the form.").font(.footnote) }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if let status { Text(status).font(.footnote) }
                ForEach(records) { record in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(record.label).font(.headline)
                        Text("\(record.origin) · \(record.username)").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            if fill != nil { Button("Fill login") { Task { await fillLogin(record) } }.buttonStyle(.borderedProminent) }
                            Button("Replace") { editing = record; showsEditor = true }.buttonStyle(.bordered)
                            Button("Delete", role: .destructive) { pendingDelete = record }.buttonStyle(.bordered)
                        }
                    }
                }
                if records.isEmpty && error == nil { Text("No saved logins").foregroundStyle(.secondary) }
                Section { Text("Passwords are encrypted on Pathway's servers and synced to your personal account.").font(.footnote).foregroundStyle(.secondary) }
            }
            .disabled(busy)
            .navigationTitle("Passwords")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", role: .cancel) { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("Add login", systemImage: "plus") { editing = nil; showsEditor = true } }
            }
            .task(id: origin) { await load() }
            .refreshable { await load() }
            .sheet(isPresented: $showsEditor, onDismiss: { Task { await load() } }) {
                BrowserPasswordEditor(record: editing, initialOrigin: origin ?? "")
            }
            .confirmationDialog("Delete this saved password?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
                Button("Delete password", role: .destructive) { if let record = pendingDelete { Task { await remove(record) } } }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            }
        }
    }
    private func load() async {
        do {
            let fields: [String: JSONValue] = origin.map { ["origin": .string($0)] } ?? [:]
            let value = try await app.cloud.browserPasswordRequest("list", arguments: .object(fields))
            guard !Task.isCancelled else { return }
            records = try JSONDecoder().decode([PathwaySavedBrowserLogin].self, from: JSONEncoder().encode(value))
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func fillLogin(_ record: PathwaySavedBrowserLogin) async {
        guard let fill, let origin else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await app.cloud.browserPasswordRequest("getForAutofill", arguments: .object(["id": .string(record.id), "origin": .string(origin)]))
            guard let login = value.objectValue, login["origin"]?.stringValue == origin,
                  let username = login["username"]?.stringValue, let password = login["password"]?.stringValue else { throw PathwayThreadConversationError.message("Login is unavailable.") }
            status = await fill(origin, username, password) ? "Login filled. Submit the website's sign-in form when ready." : "Could not fill this page. Check the website and browser control, then try again."
        } catch { self.error = "Could not unlock this login. Check your account connection and try again." }
    }
    private func remove(_ record: PathwaySavedBrowserLogin) async {
        busy = true
        defer { busy = false; pendingDelete = nil }
        do {
            _ = try await app.cloud.browserPasswordRequest("remove", arguments: .object(["id": .string(record.id), "expectedRevision": .number(Double(record.revision))]))
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

private struct BrowserPasswordEditor: View {
    @Environment(PathwayAppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let record: PathwaySavedBrowserLogin?
    @State private var id: String
    @State private var label: String
    @State private var origin: String
    @State private var username: String
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    init(record: PathwaySavedBrowserLogin?, initialOrigin: String) {
        self.record = record
        _id = State(initialValue: record?.id ?? UUID().uuidString)
        _label = State(initialValue: record?.label ?? "")
        _origin = State(initialValue: record?.origin ?? initialOrigin)
        _username = State(initialValue: record?.username ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Label", text: $label)
                TextField("Website", text: $origin).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password).textContentType(.newPassword)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .disabled(busy)
            .navigationTitle(record == nil ? "Add login" : "Replace login")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(busy || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty || origin.isEmpty) }
            }
        }
    }
    private func save() async {
        busy = true
        defer { busy = false }
        do {
            var fields: [String: JSONValue] = ["id": .string(id), "label": .string(label), "origin": .string(origin), "username": .string(username), "password": .string(password)]
            if let record { fields["expectedRevision"] = .number(Double(record.revision)) }
            _ = try await app.cloud.browserPasswordRequest("save", arguments: .object(fields))
            password = ""
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
