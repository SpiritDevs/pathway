import SwiftUI

struct PathwayEmailView: View {
    @Bindable var model: PathwayEmailModel
    let companies: [PathwayCompany]
    let environments: [PathwayCompanyEnvironment]
    var initialFilter = "inbox"
    @State private var companyID = ""
    @State private var environmentID = ""
    @State private var search = ""
    @State private var unreadOnly = false
    @State private var tagID = ""
    @State private var inbox = ""
    @State private var selection: Set<String> = []
    @State private var selecting = false
    @State private var deleting = false
    @State private var settings = false
    private var visible: [PathwayEmailRecord] {
        model.messages.filter { message in
            message.companyID == companyID && (environmentID.isEmpty || message.environmentID == environmentID) &&
            (!unreadOnly || !message.isRead) && (tagID.isEmpty || message.tagIDs.contains(tagID)) && (inbox.isEmpty || message.inbox == inbox) &&
            (search.isEmpty || [message.subject, message.sender, message.message["textBody"]?.stringValue ?? ""].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }
    private var selected: [PathwayEmailRecord] { visible.filter { selection.contains($0.id) } }
    var body: some View {
        List {
            Section {
                Picker("Workspace", selection: $companyID) { ForEach(companies) { Text($0.name).tag($0.id) } }
                Picker("Environment", selection: $environmentID) {
                    Text("All environments").tag("")
                    ForEach(environments.filter { $0.companyId == companyID }) { Text($0.environment.label).tag($0.environment.environmentId) }
                }
                Picker("Inbox", selection: $inbox) {
                    Text("All inboxes").tag("")
                    ForEach(Array(Set(model.messages.filter { $0.companyID == companyID }.map(\.inbox))).sorted(), id: \.self) { Text($0).tag($0) }
                }
                Picker("Tag", selection: $tagID) {
                    Text("All tags").tag("")
                    ForEach(model.tags.filter { $0.companyID == companyID }) { Text($0.string("name")).tag($0.entityID) }
                }
                Toggle("Unread only", isOn: $unreadOnly)
            }
            if selecting {
                Section("\(selected.count) selected") {
                    Button(selection.count == visible.count ? "Deselect all" : "Select all") { selection = selection.count == visible.count ? [] : Set(visible.map(\.id)) }
                    HStack {
                        Button("Read") { run { try await model.mark(selected, read: true) } }
                        Button("Unread") { run { try await model.mark(selected, read: false) } }
                        Menu("Tags") {
                            ForEach(model.tags.filter { $0.companyID == companyID }) { tag in
                                Button("Add \(tag.string("name"))") { run { try await model.setTag(selected, tagID: tag.entityID, present: true) } }
                                Button("Remove \(tag.string("name"))") { run { try await model.setTag(selected, tagID: tag.entityID, present: false) } }
                            }
                        }
                        Button("Delete", role: .destructive) { deleting = true }
                    }.disabled(selected.isEmpty || model.isWriting)
                }
            }
            Section("Messages") {
                if visible.isEmpty { ContentUnavailableView("No captured email", systemImage: "envelope", description: Text("Email captured by your environments appears here. Adjust filters or configure capture in settings.")) }
                ForEach(visible) { message in
                    if selecting {
                        Button { if selection.contains(message.id) { selection.remove(message.id) } else { selection.insert(message.id) } } label: {
                            HStack { Image(systemName: selection.contains(message.id) ? "checkmark.circle.fill" : "circle"); PathwayEmailRow(message: message) }
                        }.foregroundStyle(.primary)
                    } else {
                        NavigationLink { PathwayEmailDetailView(model: model, original: message) } label: { PathwayEmailRow(message: message) }
                            .accessibilityIdentifier("email-message-\(message.id)")
                            .swipeActions { Button(message.isRead ? "Unread" : "Read") { run { try await model.mark([message], read: !message.isRead) } }.tint(.blue) }
                    }
                }
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Email")
        .onChange(of: initialFilter, initial: true) { unreadOnly = initialFilter == "unread" }
        .searchable(text: $search, prompt: "Search captured email")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(selecting ? "Done" : "Select") { selecting.toggle(); selection = [] }
                Button("Email settings", systemImage: "gearshape") { settings = true }
            }
        }
        .onChange(of: companies, initial: true) { if !companies.contains(where: { $0.id == companyID }) { companyID = companies.first?.id ?? "" } }
        .onChange(of: companyID) { selection = []; environmentID = ""; inbox = ""; tagID = "" }
        .sheet(isPresented: $settings) { NavigationStack { PathwayEmailSettingsView(model: model, companyID: companyID, environments: environments.filter { $0.companyId == companyID }) } }
        .confirmationDialog("Delete \(selected.count) captured messages?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete messages", role: .destructive) { run { try await model.remove(selected); selection = [] } }
        }
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) { Task { _ = await model.perform(operation) } }
}

private struct PathwayEmailRow: View {
    let message: PathwayEmailRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { if !message.isRead { Image(systemName: "circle.fill").font(.caption2).foregroundStyle(.blue).accessibilityLabel("Unread") }; Text(message.subject).fontWeight(message.isRead ? .regular : .semibold) }
            Text(message.sender).font(.subheadline).lineLimit(1)
            Text(message.message["textBody"]?.stringValue ?? "HTML message").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            HStack { Text(message.inbox); if let date = ISO8601DateFormatter().date(from: message.receivedAt) { Text(date, format: .dateTime.day().month().hour().minute()) } }.font(.caption2).foregroundStyle(.secondary)
        }.accessibilityElement(children: .combine)
    }
}
