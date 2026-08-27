import SwiftUI
import UIKit

@MainActor
struct SettingsProfileView: View {
    let service: any SettingsProfileServicing
    let roleNames: [String]
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?
    let onRequestBack: () -> Void
    let onDirtyStateChange: (Bool) -> Void

    @State private var snapshot: SettingsProfileSnapshot?
    @State private var baseDraft = SettingsProfileDraft()
    @State private var draft = SettingsProfileDraft()
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var isUpdatingActivity = false
    @State private var isUpdatingMagicLink = false
    @State private var showsActivity = true
    @State private var sendsMagicLinkEmail = false
    @State private var errorMessage: String?
    @State private var didLoad = false
    @State private var showDiscardConfirmation = false

    var body: some View {
        Group {
            if isLoading {
                profileLoadingContent
            } else if let snapshot {
                profileForm(snapshot)
            } else {
                SettingsErrorView(
                    title: "Profile Unavailable",
                    message: errorMessage ?? "Your profile could not be loaded.",
                    onRetry: { Task { await loadProfile() } }
                )
            }
        }
        .navigationTitle("My Profile")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    if isDirty {
                        showDiscardConfirmation = true
                    } else {
                        onRequestBack()
                    }
                } label: {
                    Label("Settings", systemImage: "chevron.backward")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving {
                        ProgressView()
                    } else {
                        Text("Save")
                    }
                }
                .disabled(!canSave)
                .accessibilityHint(saveAccessibilityHint)
            }
        }
        .task {
            guard !didLoad else { return }
            didLoad = true
            await loadProfile()
        }
        .onChange(of: isDirty) { _, newValue in
            onDirtyStateChange(newValue)
        }
        .onDisappear {
            onDirtyStateChange(false)
        }
        .interactiveDismissDisabled(isDirty)
        .confirmationDialog(
            "Discard profile changes?",
            isPresented: $showDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) {
                draft = baseDraft
                onRequestBack()
            }
            Button("Keep Editing", role: .cancel) {}
        } message: {
            Text("Your unsaved name and contact changes will be lost.")
        }
    }

    private func profileForm(_ snapshot: SettingsProfileSnapshot) -> some View {
        Form {
            Section {
                VStack(spacing: 10) {
                    SettingsAvatar(
                        initials: profileInitials(snapshot),
                        imageURL: snapshot.profile.profileImage,
                        profileColor: snapshot.profile.profileColor,
                        userID: snapshot.user.id,
                        companyID: snapshot.company.id,
                        cloudFrontSignature: cloudFrontSignature,
                        size: 76
                    )
                    Text(displayName)
                        .font(.title3.weight(.semibold))
                    Text(snapshot.user.email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(displayName), \(snapshot.user.email)")
            }

            Section("Name") {
                TextField("First name", text: $draft.firstName)
                    .textContentType(.givenName)
                TextField("Last name", text: $draft.lastName)
                    .textContentType(.familyName)
            }

            Section {
                profileTextField(
                    "Office phone",
                    field: .officePhone,
                    contentType: .telephoneNumber,
                    keyboard: .phonePad
                )
                profileTextField(
                    "Mobile phone",
                    field: .phone,
                    contentType: .telephoneNumber,
                    keyboard: .phonePad
                )
                profileTextField(
                    "Address",
                    field: .address,
                    contentType: .fullStreetAddress,
                    keyboard: .default
                )
                profileTextField(
                    "WhatsApp",
                    field: .whatsapp,
                    contentType: .telephoneNumber,
                    keyboard: .phonePad
                )
                profileTextField("Slack", field: .slack, keyboard: .default)
                profileTextField("Microsoft Teams", field: .microsoftTeams, keyboard: .default)
            } header: {
                Text("Contact")
            } footer: {
                Text("Select Save to apply changes to your name and contact details.")
            }

            Section("Company") {
                LabeledContent("Company", value: snapshot.company.name)
                LabeledContent("Data region", value: snapshot.company.storageLocation)
                if !roleNames.isEmpty {
                    LabeledContent("Roles", value: roleNames.joined(separator: ", "))
                }
            }

            Section {
                Toggle("Show activity indicator", isOn: activityBinding)
                    .disabled(isUpdatingActivity)
                Toggle("Email me a magic sign-in link", isOn: magicLinkBinding)
                    .disabled(isUpdatingMagicLink)
            } header: {
                Text("Activity")
            } footer: {
                Text("These preferences save immediately. If an update fails, Pathway restores the previous setting.")
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityLabel("Error: \(errorMessage)")
                }
            }
        }
        .formStyle(.grouped)
        .scrollDismissesKeyboard(.interactively)
        .disabled(isSaving)
    }

    private func profileInitials(_ snapshot: SettingsProfileSnapshot) -> String {
        let value = [snapshot.user.firstName, snapshot.user.lastName]
            .compactMap { $0?.first }
            .map(String.init)
            .joined()
            .uppercased()
        return value.isEmpty ? "QC" : value
    }

    private var profileLoadingContent: some View {
        Form {
            Section {
                VStack(spacing: 10) {
                    Circle().frame(width: 76, height: 76)
                    Text("Profile name")
                    Text("email@example.com").font(.subheadline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            Section("Name") {
                Text("First name")
                Text("Last name")
            }
            Section("Contact") {
                Text("Office phone")
                Text("Mobile phone")
                Text("Address")
            }
        }
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading profile")
    }

    private func profileTextField(
        _ title: String,
        field: SettingsProfileContactField,
        contentType: UITextContentType? = nil,
        keyboard: UIKeyboardType
    ) -> some View {
        TextField(title, text: draftBinding(for: field))
            .textContentType(contentType)
            .keyboardType(keyboard)
    }

    private func draftBinding(for field: SettingsProfileContactField) -> Binding<String> {
        Binding(
            get: { draft.value(for: field) },
            set: { draft.setValue($0, for: field) }
        )
    }

    private var activityBinding: Binding<Bool> {
        Binding(
            get: { showsActivity },
            set: { requestedValue in
                guard !isUpdatingActivity else { return }
                let previousValue = showsActivity
                showsActivity = requestedValue
                isUpdatingActivity = true
                errorMessage = nil
                Task {
                    do {
                        try await service.updateActivityIndicator(disabled: !requestedValue)
                    } catch is CancellationError {
                        showsActivity = previousValue
                    } catch {
                        showsActivity = previousValue
                        errorMessage = error.localizedDescription
                    }
                    isUpdatingActivity = false
                }
            }
        )
    }

    private var magicLinkBinding: Binding<Bool> {
        Binding(
            get: { sendsMagicLinkEmail },
            set: { requestedValue in
                guard !isUpdatingMagicLink else { return }
                let previousValue = sendsMagicLinkEmail
                sendsMagicLinkEmail = requestedValue
                isUpdatingMagicLink = true
                errorMessage = nil
                Task {
                    do {
                        try await service.updateMagicLinkEmail(enabled: requestedValue)
                    } catch is CancellationError {
                        sendsMagicLinkEmail = previousValue
                    } catch {
                        sendsMagicLinkEmail = previousValue
                        errorMessage = error.localizedDescription
                    }
                    isUpdatingMagicLink = false
                }
            }
        )
    }

    private var displayName: String {
        let value = "\(draft.firstName) \(draft.lastName)"
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "Pathway User" : value
    }

    private var isDirty: Bool { draft != baseDraft }

    private var canSave: Bool {
        isDirty && !isSaving && !draft.trimmedDisplayName.isEmpty
    }

    private var saveAccessibilityHint: String {
        if isSaving { return "Profile changes are saving" }
        if draft.trimmedDisplayName.isEmpty { return "Enter a first or last name to save" }
        if !isDirty { return "There are no unsaved changes" }
        return "Saves your name and contact changes"
    }

    private func loadProfile() async {
        isLoading = true
        errorMessage = nil
        do {
            guard let loaded = try await service.loadProfile(now: .now) else {
                snapshot = nil
                errorMessage = "Your profile was not found."
                isLoading = false
                return
            }
            snapshot = loaded
            let loadedDraft = SettingsProfileDraft(snapshot: loaded)
            baseDraft = loadedDraft
            draft = loadedDraft
            showsActivity = !loaded.profile.disabledActivityIndicator
            sendsMagicLinkEmail = loaded.user.sendMagicLinkEmail
        } catch is CancellationError {
            return
        } catch {
            snapshot = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func save() async {
        guard canSave else { return }
        let submittedDraft = draft
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            if submittedDraft.firstName != baseDraft.firstName || submittedDraft.lastName != baseDraft.lastName {
                try await service.updateName(
                    firstName: submittedDraft.firstName.trimmingCharacters(in: .whitespacesAndNewlines),
                    lastName: submittedDraft.lastName.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                baseDraft.firstName = submittedDraft.firstName
                baseDraft.lastName = submittedDraft.lastName
            }

            for field in SettingsProfileContactField.allCases
            where submittedDraft.value(for: field) != baseDraft.value(for: field) {
                try await service.updateContact(
                    field,
                    value: submittedDraft.value(for: field).trimmingCharacters(in: .whitespacesAndNewlines)
                )
                baseDraft.setValue(submittedDraft.value(for: field), for: field)
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SettingsProfileDraft: Equatable {
    var firstName = ""
    var lastName = ""
    var officePhone = ""
    var phone = ""
    var address = ""
    var whatsapp = ""
    var slack = ""
    var microsoftTeams = ""

    init() {}

    init(snapshot: SettingsProfileSnapshot) {
        firstName = snapshot.user.firstName ?? ""
        lastName = snapshot.user.lastName ?? ""
        officePhone = snapshot.profile.officePhone ?? ""
        phone = snapshot.profile.phone ?? ""
        address = snapshot.profile.address ?? ""
        whatsapp = snapshot.profile.whatsapp ?? ""
        slack = snapshot.profile.slack ?? ""
        microsoftTeams = snapshot.profile.microsoftTeams ?? ""
    }

    var trimmedDisplayName: String {
        "\(firstName) \(lastName)".trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func value(for field: SettingsProfileContactField) -> String {
        switch field {
        case .officePhone: officePhone
        case .phone: phone
        case .address: address
        case .whatsapp: whatsapp
        case .slack: slack
        case .microsoftTeams: microsoftTeams
        }
    }

    mutating func setValue(_ value: String, for field: SettingsProfileContactField) {
        switch field {
        case .officePhone: officePhone = value
        case .phone: phone = value
        case .address: address = value
        case .whatsapp: whatsapp = value
        case .slack: slack = value
        case .microsoftTeams: microsoftTeams = value
        }
    }
}
