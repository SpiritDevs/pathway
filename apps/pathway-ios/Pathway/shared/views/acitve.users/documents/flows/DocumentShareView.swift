import SwiftUI

struct DocumentShareView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    let document: DashboardDocument

    @State private var links: [String: DocumentShareLink] = [:]
    @State private var selectedLink: ShareLinkSelection?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Preparing secure links…")
            } else if links.isEmpty {
                ContentUnavailableView(
                    "No Share Links",
                    systemImage: "link.badge.plus",
                    description: Text(errorMessage ?? "Share links are unavailable for this document.")
                )
            } else {
                List {
                    if let generalLink {
                        Section("General Link") {
                            shareLinkRow(generalLink)
                        }
                    }

                    if !recipientLinks.isEmpty {
                        Section("Recipient Links") {
                            ForEach(recipientLinks) { selection in
                                shareLinkRow(selection)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("Share Document")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task { await loadLinks() }
        .sheet(item: $selectedLink) { selection in
            NavigationStack {
                DocumentShareLinkEditor(
                    documentID: document.id,
                    selection: selection,
                    save: save
                )
            }
            .presentationDetents([.medium, .large])
        }
        .alert("Sharing Failed", isPresented: Binding(
            get: { errorMessage != nil && !links.isEmpty },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Share links could not be updated.")
        }
    }

    private var generalLink: ShareLinkSelection? {
        links["general"].map { ShareLinkSelection(label: "general", link: $0) }
    }

    private var recipientLinks: [ShareLinkSelection] {
        links
            .filter { $0.key != "general" }
            .map { ShareLinkSelection(label: $0.key, link: $0.value) }
            .sorted {
                $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    private func shareLinkRow(_ selection: ShareLinkSelection) -> some View {
        ShareLinkRow(
            selection: selection,
            url: viewerURL(for: selection.link.key),
            edit: { selectedLink = selection }
        )
    }

    private func viewerURL(for key: String) -> URL {
        AppConfiguration.pathwaySiteURL
            .appending(path: "en")
            .appending(path: "viewer")
            .appending(path: key)
    }

    private func loadLinks() async {
        defer { isLoading = false }
        guard let bootstrap = appModel.dashboardBootstrap else {
            errorMessage = "Account capabilities are still loading."
            return
        }
        do {
            let information = try await appModel.documentService.information(documentID: document.id)
            let capabilities = DocumentActionCapabilities(information: information, bootstrap: bootstrap)
            guard capabilities.canShare else {
                if !capabilities.emailIsVerified {
                    errorMessage = "Verify your email address before sharing documents."
                } else if bootstrap.userData.isActive == false {
                    errorMessage = "An active subscription is required to share documents."
                } else {
                    errorMessage = "You do not have permission to share this document."
                }
                return
            }
            links = try await appModel.documentService.shareLinks(documentID: document.id).links ?? [:]
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save(_ selection: ShareLinkSelection, _ update: DocumentShareLinkUpdate) async throws {
        let result = try await appModel.documentService.updateShareLink(
            documentID: document.id,
            key: selection.link.key,
            update: update
        )
        guard let key = result.key,
              let metadata = result.metadata,
              let active = result.active,
              let accessMode = result.accessMode else {
            throw DocumentServiceError.rejected("Pathway returned an incomplete share link.")
        }
        links[selection.label] = DocumentShareLink(
            key: key,
            active: active,
            accessMode: accessMode,
            metadata: metadata
        )
    }
}

struct ShareLinkSelection: Identifiable, Equatable {
    let label: String
    let link: DocumentShareLink
    var id: String { link.key }

    var displayName: String { label == "general" ? "General link" : label }
}

private struct ShareLinkRow: View {
    let selection: ShareLinkSelection
    let url: URL
    let edit: () -> Void

    @ScaledMetric(relativeTo: .headline) private var badgeSize: CGFloat = 36

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                leadingBadge

                VStack(alignment: .leading, spacing: 3) {
                    Text(selection.displayName)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    statusLine
                }

                Spacer(minLength: 8)

                settingsButton
            }

            Divider()

            actionRow
                .disabled(!selection.link.active)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("share-link-\(selection.label)")
    }

    private var leadingBadge: some View {
        Image(systemName: selection.label == "general" ? "link" : "person.fill")
            .font(.system(size: badgeSize * 0.45, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: badgeSize, height: badgeSize)
            .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 9))
            .accessibilityHidden(true)
    }

    private var statusLine: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(selection.link.active ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)

            Text(accessLabel)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(selection.link.active ? "\(accessLabel), active" : "Disabled")
    }

    private var settingsButton: some View {
        Button(action: edit) {
            Image(systemName: "slider.horizontal.3")
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
        .controlSize(.small)
        .tint(.secondary)
        .accessibilityLabel("Link settings")
    }

    private var actionRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                shareButton
                copyButton
            }

            VStack(spacing: 10) {
                shareButton
                copyButton
            }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.regular)
        .tint(.accentColor)
    }

    private var shareButton: some View {
        ShareLink(item: url) {
            Label("Share", systemImage: "square.and.arrow.up")
                .frame(maxWidth: .infinity)
        }
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.url = url
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } label: {
            Label("Copy Link", systemImage: "doc.on.doc")
                .frame(maxWidth: .infinity)
        }
        .accessibilityLabel("Copy link")
    }

    private var accessLabel: String {
        guard selection.link.active else { return "Disabled" }
        return switch selection.link.accessMode {
        case .disabled: "Disabled"
        case .preview: "Preview"
        case .viewOnly: "View only"
        case .fullAccess: "Full access"
        }
    }
}

private struct DocumentShareLinkEditor: View {
    @Environment(\.dismiss) private var dismiss

    let documentID: String
    let selection: ShareLinkSelection
    let save: (ShareLinkSelection, DocumentShareLinkUpdate) async throws -> Void

    @State private var accessMode: DocumentShareAccessMode
    @State private var hasExpiry: Bool
    @State private var expiryDate: Date
    @State private var hasAccessLimit: Bool
    @State private var accessLimit: Int
    @State private var passwordProtected: Bool
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        documentID: String,
        selection: ShareLinkSelection,
        save: @escaping (ShareLinkSelection, DocumentShareLinkUpdate) async throws -> Void
    ) {
        self.documentID = documentID
        self.selection = selection
        self.save = save
        _accessMode = State(initialValue: selection.link.accessMode)
        let expireAt = selection.link.metadata.expireDate
        _hasExpiry = State(initialValue: expireAt != nil)
        _expiryDate = State(initialValue: expireAt.map { Date(timeIntervalSince1970: $0 / 1_000) } ?? .now)
        let limit = selection.link.metadata.accessLimit
        _hasAccessLimit = State(initialValue: limit != nil)
        _accessLimit = State(initialValue: limit ?? 1)
        _passwordProtected = State(initialValue: selection.link.metadata.passwordActive ?? false)
    }

    var body: some View {
        Form {
            Section("Access") {
                Picker("Access level", selection: $accessMode) {
                    Text("Disabled").tag(DocumentShareAccessMode.disabled)
                    Text("Preview").tag(DocumentShareAccessMode.preview)
                    Text("View only").tag(DocumentShareAccessMode.viewOnly)
                    Text("Full access").tag(DocumentShareAccessMode.fullAccess)
                }
            }

            Section("Limits") {
                Toggle("Expiry date", isOn: $hasExpiry)
                if hasExpiry {
                    DatePicker("Expires", selection: $expiryDate, in: .now...)
                }
                Toggle("Access limit", isOn: $hasAccessLimit)
                if hasAccessLimit {
                    Stepper("\(accessLimit) opens", value: $accessLimit, in: 1...10_000)
                }
            }

            Section("Password") {
                Toggle("Require password", isOn: $passwordProtected)
                if passwordProtected {
                    SecureField(
                        selection.link.metadata.passwordActive == true ? "New password (optional)" : "Password",
                        text: $password
                    )
                    Text("Leave blank to keep the current password.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(selection.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(isSaving)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { saveChanges() }.disabled(isSaving || !isValid)
            }
        }
        .overlay { if isSaving { ProgressView().controlSize(.large) } }
        .alert("Couldn’t Save Link", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Try again.")
        }
    }

    private var isValid: Bool {
        !passwordProtected || !password.isEmpty || selection.link.metadata.passwordActive == true
    }

    private func saveChanges() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await save(selection, DocumentShareLinkUpdate(
                    active: accessMode != .disabled,
                    accessMode: accessMode,
                    accessLimit: hasAccessLimit ? accessLimit : nil,
                    expireAt: hasExpiry ? expiryDate.timeIntervalSince1970 * 1_000 : nil,
                    password: passwordProtected && !password.isEmpty ? password : nil,
                    passwordActive: passwordProtected
                ))
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
