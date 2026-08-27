import Contacts
import SwiftUI

struct DocumentInformationRecipientsTab: View {
    let recipients: [DocumentRecipient]
    let canManage: Bool
    let canSearchPathwayContacts: Bool
    let searchPathwayContacts: (String) async throws -> [CreateDocumentContact]
    let add: (DocumentRecipientDraft) async throws -> Void
    let update: (String, DocumentRecipientDraft) async throws -> Void
    let remove: (String) async throws -> Void
    let move: (IndexSet, Int) async -> Void

    @State private var editor: RecipientEditorDestination?
    @State private var pendingRemoval: DocumentRecipient?
    @State private var mutationError: String?
    @State private var isMutating = false

    var body: some View {
        Group {
            if recipients.isEmpty {
                ContentUnavailableView {
                    Label("No Recipients", systemImage: "person.2")
                } description: {
                    Text("Add the people who should receive this document.")
                } actions: {
                    if canManage {
                        Button("Add Recipient", systemImage: "plus") {
                            editor = .add
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            } else {
                List {
                    ForEach(recipients) { recipient in
                        recipientRow(recipient)
                    }
                    .onMove { offsets, destination in
                        Task { await move(offsets, destination) }
                    }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(canManage ? .active : .inactive))
            }
        }
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add Recipient", systemImage: "person.badge.plus") {
                        editor = .add
                    }
                    .disabled(isMutating)
                }
            }
        }
        .sheet(item: $editor) { destination in
            RecipientEditorSheet(
                destination: destination,
                canSearchPathwayContacts: canSearchPathwayContacts,
                searchPathwayContacts: searchPathwayContacts
            ) { draft in
                try await save(destination, draft: draft)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Remove Recipient?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove Recipient", role: .destructive) {
                guard let recipient = pendingRemoval else { return }
                pendingRemoval = nil
                Task { await removeRecipient(recipient) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("Required primary recipients cannot be removed.")
        }
        .alert(
            "Recipient Update Failed",
            isPresented: Binding(
                get: { mutationError != nil },
                set: { if !$0 { mutationError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { mutationError = nil }
        } message: {
            Text(mutationError ?? "Pathway could not update this recipient.")
        }
    }

    private func recipientRow(_ recipient: DocumentRecipient) -> some View {
        Button {
            guard canManage else { return }
            editor = .edit(recipient)
        } label: {
            HStack(spacing: 12) {
                Text(recipient.initials)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.blue)
                    .frame(width: 40, height: 40)
                    .background(.blue.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(recipient.displayName)
                        .font(.body.weight(.medium))
                    if let email = recipient.email, !email.isEmpty {
                        Text(email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if let phone = recipient.phone, !phone.isEmpty {
                        Text(phone)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if recipient.linkedToContact {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Linked contact")
                }

                if canManage {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isMutating)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canManage {
                Button("Remove", systemImage: "trash", role: .destructive) {
                    pendingRemoval = recipient
                }
            }
        }
        .accessibilityHint(canManage ? "Opens recipient details" : "Recipient details are view only")
    }

    private func save(
        _ destination: RecipientEditorDestination,
        draft: DocumentRecipientDraft
    ) async throws {
        isMutating = true
        defer { isMutating = false }
        do {
            switch destination {
            case .add:
                try await add(draft)
            case let .edit(recipient):
                try await update(recipient.id, draft)
            }
        } catch {
            mutationError = error.localizedDescription
            throw error
        }
    }

    private func removeRecipient(_ recipient: DocumentRecipient) async {
        isMutating = true
        defer { isMutating = false }
        do {
            try await remove(recipient.id)
        } catch {
            mutationError = error.localizedDescription
        }
    }
}

private enum RecipientEditorDestination: Identifiable {
    case add
    case edit(DocumentRecipient)

    var id: String {
        switch self {
        case .add: "add"
        case let .edit(recipient): "edit-\(recipient.id)"
        }
    }

    var recipient: DocumentRecipient? {
        switch self {
        case .add: nil
        case let .edit(recipient): recipient
        }
    }
}

private struct RecipientEditorSheet: View {
    @Environment(\.dismiss) private var dismiss

    let destination: RecipientEditorDestination
    let canSearchPathwayContacts: Bool
    let searchPathwayContacts: (String) async throws -> [CreateDocumentContact]
    let save: (DocumentRecipientDraft) async throws -> Void

    @State private var contactID: String?
    @State private var firstName: String
    @State private var lastName: String
    @State private var email: String
    @State private var phone: String
    @State private var company: String
    @State private var address: String
    @State private var position: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var contactSource: RecipientContactSource?

    init(
        destination: RecipientEditorDestination,
        canSearchPathwayContacts: Bool,
        searchPathwayContacts: @escaping (String) async throws -> [CreateDocumentContact],
        save: @escaping (DocumentRecipientDraft) async throws -> Void
    ) {
        self.destination = destination
        self.canSearchPathwayContacts = canSearchPathwayContacts
        self.searchPathwayContacts = searchPathwayContacts
        self.save = save
        let recipient = destination.recipient
        _contactID = State(initialValue: nil)
        _firstName = State(initialValue: recipient?.firstName ?? "")
        _lastName = State(initialValue: recipient?.lastName ?? "")
        _email = State(initialValue: recipient?.email ?? "")
        _phone = State(initialValue: recipient?.phone ?? "")
        _company = State(initialValue: recipient?.company ?? "")
        _address = State(initialValue: recipient?.address ?? "")
        _position = State(initialValue: recipient?.position ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                if destination.recipient == nil {
                    Section("Add from contacts") {
                        Button {
                            contactSource = .pathway
                        } label: {
                            Label(
                                "Pathway Contacts",
                                systemImage: "person.crop.circle.badge.checkmark"
                            )
                        }
                        .disabled(!canSearchPathwayContacts)

                        Button {
                            contactSource = .phone
                        } label: {
                            Label("Phone Contacts", systemImage: "person.crop.rectangle.stack")
                        }
                    }
                }

                Section("Name") {
                    TextField("First name", text: $firstName)
                        .textContentType(.givenName)
                    TextField("Last name", text: $lastName)
                        .textContentType(.familyName)
                }

                Section("Contact") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .textContentType(.emailAddress)
                    TextField("Phone", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                }

                Section("Organisation") {
                    TextField("Company", text: $company)
                        .textContentType(.organizationName)
                    TextField("Position", text: $position)
                        .textContentType(.jobTitle)
                    TextField("Address", text: $address, axis: .vertical)
                        .lineLimit(2 ... 4)
                        .textContentType(.fullStreetAddress)
                }
            }
            .navigationTitle(destination.recipient == nil ? "Add Recipient" : "Edit Recipient")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await submit() }
                    }
                    .disabled(isSaving || firstName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .sheet(item: $contactSource) { source in
            switch source {
            case .pathway:
                PathwayRecipientContactPicker(
                    search: searchPathwayContacts,
                    select: applyPathwayContact
                )
            case .phone:
                PhoneContactPickerView(
                    onSelect: { contact in
                        applyPhoneContact(contact)
                        contactSource = nil
                    },
                    onCancel: { contactSource = nil }
                )
            }
        }
        .alert(
            "Couldn’t Save Recipient",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Pathway could not save this recipient.")
        }
    }

    private func submit() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await save(
                DocumentRecipientDraft(
                    contactId: contactID,
                    firstName: firstName.trimmingCharacters(in: .whitespacesAndNewlines),
                    lastName: lastName.trimmingCharacters(in: .whitespacesAndNewlines),
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    phone: phone.trimmingCharacters(in: .whitespacesAndNewlines),
                    company: company.trimmingCharacters(in: .whitespacesAndNewlines),
                    address: address.trimmingCharacters(in: .whitespacesAndNewlines),
                    position: position.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyPathwayContact(_ contact: CreateDocumentContact) {
        contactID = contact.id
        firstName = contact.firstName
        lastName = contact.lastName ?? ""
        email = contact.email
        phone = contact.phone ?? ""
        company = contact.company ?? ""
        address = contact.address ?? ""
    }

    private func applyPhoneContact(_ contact: CNContact) {
        contactID = nil
        let phoneCompany = contact.organizationName.trimmingCharacters(in: .whitespacesAndNewlines)
        let phoneFirstName = contact.givenName.trimmingCharacters(in: .whitespacesAndNewlines)
        firstName = phoneFirstName.isEmpty ? phoneCompany : phoneFirstName
        lastName = contact.familyName
        email = contact.emailAddresses.first.map { String($0.value) } ?? ""
        phone = contact.phoneNumbers.first?.value.stringValue ?? ""
        company = phoneCompany
        address = contact.postalAddresses.first.map {
            CNPostalAddressFormatter.string(from: $0.value, style: .mailingAddress)
        } ?? ""
    }
}

private enum RecipientContactSource: String, Identifiable {
    case pathway
    case phone

    var id: String { rawValue }
}

private struct PathwayRecipientContactPicker: View {
    @Environment(\.dismiss) private var dismiss

    let search: (String) async throws -> [CreateDocumentContact]
    let select: (CreateDocumentContact) -> Void

    @State private var query = ""
    @State private var contacts: [CreateDocumentContact] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
                    ContentUnavailableView(
                        "Find a contact",
                        systemImage: "person.text.rectangle",
                        description: Text("Enter at least two letters of a name or email address.")
                    )
                } else if isLoading && contacts.isEmpty {
                    ProgressView("Searching contacts…")
                } else if let errorMessage {
                    ContentUnavailableView(
                        "Contacts unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(errorMessage)
                    )
                } else if contacts.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(contacts) { contact in
                        Button {
                            select(contact)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(contact.displayName)
                                    .font(.body.weight(.semibold))
                                Text(contact.email)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                if let company = contact.company, !company.isEmpty {
                                    Text(company)
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Pathway Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Name or email")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task(id: query) {
                let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmed.count >= 2 else {
                    contacts = []
                    errorMessage = nil
                    return
                }
                do {
                    try await Task.sleep(for: .milliseconds(300))
                    try Task.checkCancellation()
                    isLoading = true
                    errorMessage = nil
                    let results = try await search(trimmed)
                    try Task.checkCancellation()
                    guard query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else {
                        return
                    }
                    contacts = results
                    isLoading = false
                } catch is CancellationError {
                    return
                } catch {
                    contacts = []
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private extension DocumentRecipient {
    var initials: String {
        let value = [firstName.first, lastName?.first]
            .compactMap { $0 }
            .map(String.init)
            .joined()
            .uppercased()
        return value.isEmpty ? "QC" : value
    }
}
