import Contacts
import ContactsUI
import SwiftUI

struct CreateDocumentDetailsView: View {
    @Bindable var model: CreateDocumentFlowModel
    let onEditRecipient: (UUID) -> Void
    let onAddRecipient: () -> Void

    @State private var primaryReplacementCandidateID: UUID?
    @State private var contactPickerDestination: RecipientContactPickerDestination?
    @State private var pendingRecipientEditID: UUID?

    var body: some View {
        List {
            Section {
                TextField("Untitled Document", text: $model.title)
                    .textContentType(.name)
                    .accessibilityLabel("Document title")
                    .padding(.horizontal, 12)
                    .frame(minHeight: 52)
                    .background(
                        Color(uiColor: .secondarySystemBackground),
                        in: .rect(cornerRadius: 14)
                    )
                    .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)

                if model.context.canAssignOwner, model.context.assignableUsers.count > 1 {
                    Picker("Owner", selection: $model.ownerUserID) {
                        Text("Me").tag(String?.none)
                        ForEach(model.context.assignableUsers.filter { $0.id != model.context.currentUserID }) { user in
                            Text(user.displayName).tag(Optional(user.id))
                        }
                    }
                    .pickerStyle(.menu)
                }
            } header: {
                Text("Document")
                    .font(.headline)
                    .textCase(nil)
            }

            Section {
                ForEach(Array(model.recipients.enumerated()), id: \.element.id) { index, recipient in
                    recipientRow(recipient, at: index)
                }
            } header: {
                HStack(alignment: .center) {
                    Text("Recipients")
                        .font(.headline)
                        .textCase(nil)
                    Spacer()
                    Menu {
                        Button {
                            onAddRecipient()
                        } label: {
                            Label("Add Recipient", systemImage: "person.badge.plus")
                        }

                        Button {
                            presentPathwayContactPicker()
                        } label: {
                            Label(
                                "Add Pathway Contact",
                                systemImage: "person.crop.circle.badge.checkmark"
                            )
                        }
                        .disabled(!model.context.canSearchContacts)

                        Button {
                            presentPhoneContactPicker()
                        } label: {
                            Label("Add from Phone", systemImage: "person.crop.rectangle.stack")
                        }
                    } label: {
                        Label("Add", systemImage: "person.badge.plus")
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                    .textCase(nil)
                    .accessibilityHint("Adds another recipient to this document")
                }
            } footer: {
                Text(recipientHelperText)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog(
            "Choose a primary recipient to replace",
            isPresented: replacementDialogIsPresented,
            titleVisibility: .visible,
            presenting: primaryReplacementCandidateID
        ) { candidateID in
            ForEach(primaryRecipients) { primary in
                Button("Replace \(replacementLabel(for: primary))") {
                    _ = model.makeRecipientPrimary(
                        id: candidateID,
                        replacingPrimaryID: primary.id
                    )
                    primaryReplacementCandidateID = nil
                }
            }
            Button("Cancel", role: .cancel) {
                primaryReplacementCandidateID = nil
            }
        } message: { _ in
            Text("All required primary positions are filled. The person you replace will remain as an additional recipient.")
        }
        .sheet(
            item: $contactPickerDestination,
            onDismiss: openPendingRecipientEditor
        ) { destination in
            switch destination {
            case let .pathway(recipientID):
                ContactPickerView(
                    model: model,
                    recipientID: recipientID,
                    onSelected: { pendingRecipientEditID = $0 }
                )
            case let .phone(recipientID):
                PhoneContactPickerView(
                    onSelect: { contact in
                        applyPhoneContact(contact, to: recipientID)
                        pendingRecipientEditID = recipientID
                    },
                    onCancel: {}
                )
            }
        }
    }

    private func recipientRow(
        _ recipient: CreateDocumentRecipient,
        at index: Int
    ) -> some View {
        let isPrimary = index < model.requiredPrimaryRecipientCount
        let isOptionalEmptyRecipient = !model.context.requireDocumentRecipient &&
            !model.hasEnteredRecipients &&
            recipient.isBlank
        let canPromote = !isPrimary &&
            model.requiredPrimaryRecipientCount > 0 &&
            !recipient.isBlank

        return HStack(spacing: 6) {
            Button {
                onEditRecipient(recipient.id)
            } label: {
                RecipientSummaryRow(
                    recipient: recipient,
                    role: isOptionalEmptyRecipient
                        ? "Optional recipient"
                        : (isPrimary ? "Primary recipient" : "Additional recipient")
                )
            }
            .buttonStyle(.plain)

            if canPromote {
                Button {
                    requestPrimaryPromotion(for: recipient.id)
                } label: {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .font(.title3)
                        .frame(width: 38, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Make \(displayName(for: recipient)) a primary recipient")
                .accessibilityHint("Promotes immediately when a primary position is empty, or asks who to replace")
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(
            Color(uiColor: .secondarySystemBackground),
            in: .rect(cornerRadius: 14)
        )
        .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing, allowsFullSwipe: !isPrimary) {
            if canDelete(recipient, at: index) {
                Button(role: .destructive) {
                    model.removeRecipient(id: recipient.id)
                } label: {
                    Label(isPrimary ? "Clear Primary Recipient" : "Delete", systemImage: "trash")
                }
            }
        }
        .contextMenu {
            if canPromote {
                Button("Make Primary", systemImage: "person.crop.circle.badge.checkmark") {
                    requestPrimaryPromotion(for: recipient.id)
                }
            }
            if canDelete(recipient, at: index) {
                Button(
                    isPrimary ? "Clear Primary Recipient" : "Delete",
                    systemImage: "trash",
                    role: .destructive
                ) {
                    model.removeRecipient(id: recipient.id)
                }
            }
        }
    }

    private var replacementDialogIsPresented: Binding<Bool> {
        Binding(
            get: { primaryReplacementCandidateID != nil },
            set: { isPresented in
                if !isPresented { primaryReplacementCandidateID = nil }
            }
        )
    }

    private var primaryRecipients: [CreateDocumentRecipient] {
        Array(model.recipients.prefix(model.requiredPrimaryRecipientCount))
            .filter { !$0.isBlank }
    }

    private func requestPrimaryPromotion(for recipientID: UUID) {
        if !model.makeRecipientPrimary(id: recipientID) {
            primaryReplacementCandidateID = recipientID
        }
    }

    private func presentPathwayContactPicker() {
        pendingRecipientEditID = nil
        contactPickerDestination = .pathway(recipientID: availableRecipientID())
    }

    private func presentPhoneContactPicker() {
        pendingRecipientEditID = nil
        contactPickerDestination = .phone(recipientID: availableRecipientID())
    }

    private func availableRecipientID() -> UUID {
        if let blankRecipient = model.recipients.first(where: \.isBlank) {
            return blankRecipient.id
        }
        model.addRecipient()
        return model.recipients.last?.id ?? UUID()
    }

    private func openPendingRecipientEditor() {
        guard let recipientID = pendingRecipientEditID else { return }
        pendingRecipientEditID = nil
        onEditRecipient(recipientID)
    }

    private func applyPhoneContact(_ contact: CNContact, to recipientID: UUID) {
        guard let index = model.recipients.firstIndex(where: { $0.id == recipientID }) else {
            return
        }

        let firstName = contact.givenName.trimmingCharacters(in: .whitespacesAndNewlines)
        let companyName = contact.organizationName.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = contact.emailAddresses.first.map { String($0.value) } ?? ""
        let phone = contact.phoneNumbers.first?.value.stringValue ?? ""
        let address = contact.postalAddresses.first.map {
            CNPostalAddressFormatter.string(from: $0.value, style: .mailingAddress)
        } ?? ""

        model.recipients[index] = CreateDocumentRecipient(
            id: recipientID,
            email: email,
            firstName: firstName.isEmpty ? companyName : firstName,
            lastName: contact.familyName,
            phoneNumber: phone,
            address: address,
            companyName: companyName,
            saveContact: model.recipients[index].saveContact
        )
    }

    private func canDelete(_ recipient: CreateDocumentRecipient, at index: Int) -> Bool {
        if index < model.requiredPrimaryRecipientCount {
            return !recipient.isBlank
        }
        return !recipient.isBlank || model.recipients.count > max(1, model.requiredPrimaryRecipientCount)
    }

    private func displayName(for recipient: CreateDocumentRecipient) -> String {
        let name = [recipient.firstName, recipient.lastName]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return name.isEmpty ? "this recipient" : name
    }

    private func replacementLabel(for recipient: CreateDocumentRecipient) -> String {
        let name = displayName(for: recipient)
        return recipient.email.isEmpty ? name : "\(name) (\(recipient.email))"
    }

    private var recipientHelperText: String {
        if !model.context.requireDocumentRecipient {
            return "Recipients are optional. Any recipient you add needs a first name and valid email."
        }
        if model.requiredPrimaryRecipientCount > 0 {
            return "\(model.requiredPrimaryRecipientCount) primary recipient\(model.requiredPrimaryRecipientCount == 1 ? "" : "s") required by this template."
        }
        return "At least one recipient is required by your company settings."
    }
}

private enum RecipientContactPickerDestination: Identifiable {
    case pathway(recipientID: UUID)
    case phone(recipientID: UUID)

    var id: String {
        switch self {
        case let .pathway(recipientID):
            "pathway-\(recipientID)"
        case let .phone(recipientID):
            "phone-\(recipientID)"
        }
    }
}

private struct RecipientSummaryRow: View {
    let recipient: CreateDocumentRecipient
    let role: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: recipient.isBlank ? "person.crop.circle.badge.plus" : "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(recipient.isBlank ? Color.secondary : Color.accentColor)
                .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 3) {
                Text(role)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(displayName)
                    .font(.body.weight(.semibold))
                if !recipient.email.isEmpty {
                    Text(recipient.email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Incomplete")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }

            Spacer()
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint("Opens recipient details")
    }

    private var displayName: String {
        let name = [recipient.firstName, recipient.lastName]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return name.isEmpty ? "New recipient" : name
    }

    private var accessibilitySummary: String {
        [role, displayName, recipient.email, recipient.email.isEmpty ? "Incomplete" : "Complete"]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

struct RecipientEditorView: View {
    @Environment(\.dismiss) private var dismiss

    @Binding var recipient: CreateDocumentRecipient
    @Bindable var model: CreateDocumentFlowModel
    let isPrimary: Bool
    let canDelete: Bool

    @State private var isContactPickerPresented = false
    @FocusState private var focusedField: RecipientField?

    var body: some View {
        Form {
            Section {
                if model.context.canSearchContacts {
                    Button {
                        isContactPickerPresented = true
                    } label: {
                        Label("Choose from Pathway Contacts", systemImage: "person.crop.circle.badge.checkmark")
                    }
                }
            } header: {
                Text(isPrimary ? "Primary recipient" : "Additional recipient")
            }

            Section("Name") {
                TextField("First name", text: $recipient.firstName)
                    .textContentType(.givenName)
                    .focused($focusedField, equals: .firstName)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .lastName }
                TextField("Last name", text: $recipient.lastName)
                    .textContentType(.familyName)
                    .focused($focusedField, equals: .lastName)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .email }
            }

            Section("Contact") {
                TextField("Email", text: $recipient.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .phone }
                TextField("Phone", text: $recipient.phoneNumber)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .focused($focusedField, equals: .phone)
            }

            Section("Organisation") {
                TextField("Company", text: $recipient.companyName)
                    .textContentType(.organizationName)
                    .focused($focusedField, equals: .company)
                TextField("Account reference", text: $recipient.accountRef)
                    .focused($focusedField, equals: .account)
                TextField("Address", text: $recipient.address, axis: .vertical)
                    .textContentType(.fullStreetAddress)
                    .lineLimit(2...4)
                    .focused($focusedField, equals: .address)
            }

            if model.context.canSaveContacts, recipient.contactId == nil {
                Section {
                    Toggle("Save to Pathway Contacts", isOn: $recipient.saveContact)
                } footer: {
                    Text("The document can still be created if saving the contact is unavailable.")
                }
            }

            if canDelete {
                Section {
                    Button("Delete Recipient", role: .destructive) {
                        model.removeRecipient(id: recipient.id)
                        dismiss()
                    }
                }
            }
        }
        .navigationTitle(isPrimary ? "Primary Recipient" : "Recipient")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    focusedField = nil
                    dismiss()
                }
                .fontWeight(.semibold)
            }

            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
        .sheet(isPresented: $isContactPickerPresented) {
            ContactPickerView(model: model, recipientID: recipient.id)
        }
        .onAppear {
            if recipient.isBlank { focusedField = .firstName }
        }
    }
}

private enum RecipientField: Hashable {
    case firstName
    case lastName
    case email
    case phone
    case company
    case account
    case address
}

private struct ContactPickerView: View {
    @Environment(\.dismiss) private var dismiss

    @Bindable var model: CreateDocumentFlowModel
    let recipientID: UUID
    var onSelected: ((UUID) -> Void)? = nil

    @State private var query = ""
    @State private var results: [CreateDocumentContact] = []
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            Group {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
                    ContentUnavailableView(
                        "Find a contact",
                        systemImage: "person.text.rectangle",
                        description: Text("Enter at least two letters of a name or email address.")
                    )
                } else if isLoading && results.isEmpty {
                    ProgressView("Searching contacts…")
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(results) { contact in
                        Button {
                            model.applyContact(contact, to: recipientID)
                            onSelected?(recipientID)
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
                    results = []
                    return
                }
                do {
                    try await Task.sleep(for: .milliseconds(300))
                    guard !Task.isCancelled else { return }
                    isLoading = true
                    let contacts = await model.searchContacts(
                        field: trimmed.contains("@") ? .email : .firstName,
                        query: trimmed
                    )
                    guard !Task.isCancelled, query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed else {
                        return
                    }
                    results = contacts
                    isLoading = false
                } catch is CancellationError {
                    return
                } catch {
                    isLoading = false
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct PhoneContactPickerView: UIViewControllerRepresentable {
    let onSelect: (CNContact) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let picker = CNContactPickerViewController()
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(
        _ uiViewController: CNContactPickerViewController,
        context: Context
    ) {
        context.coordinator.parent = self
        uiViewController.delegate = context.coordinator
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency CNContactPickerDelegate {
        var parent: PhoneContactPickerView

        init(parent: PhoneContactPickerView) {
            self.parent = parent
        }

        func contactPicker(
            _ picker: CNContactPickerViewController,
            didSelect contact: CNContact
        ) {
            parent.onSelect(contact)
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
            parent.onCancel()
        }
    }
}
