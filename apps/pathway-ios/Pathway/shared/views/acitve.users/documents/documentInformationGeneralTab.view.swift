import SwiftUI

struct DocumentInformationGeneralTab: View {
    private enum FocusedField {
        case title
        case subtitle
    }

    let information: DocumentInformation
    let bootstrap: MobileDashboardBootstrap?
    let savingFields: Set<String>
    let saveTitle: (String) async -> Void
    let saveSubtitle: (String) async -> Void
    let saveStatus: (String) async -> Void
    let saveOwner: (MobileDashboardBootstrap.CompanyUser) async -> Void
    let saveExpiry: (Date?) async -> Void
    let saveRenewal: (Date?) async -> Void

    @State private var title: String
    @State private var subtitle: String
    @State private var hasExpiry: Bool
    @State private var expiry: Date
    @State private var hasRenewal: Bool
    @State private var renewal: Date
    @FocusState private var focusedField: FocusedField?

    init(
        information: DocumentInformation,
        bootstrap: MobileDashboardBootstrap?,
        savingFields: Set<String>,
        saveTitle: @escaping (String) async -> Void,
        saveSubtitle: @escaping (String) async -> Void,
        saveStatus: @escaping (String) async -> Void,
        saveOwner: @escaping (MobileDashboardBootstrap.CompanyUser) async -> Void,
        saveExpiry: @escaping (Date?) async -> Void,
        saveRenewal: @escaping (Date?) async -> Void
    ) {
        self.information = information
        self.bootstrap = bootstrap
        self.savingFields = savingFields
        self.saveTitle = saveTitle
        self.saveSubtitle = saveSubtitle
        self.saveStatus = saveStatus
        self.saveOwner = saveOwner
        self.saveExpiry = saveExpiry
        self.saveRenewal = saveRenewal
        _title = State(initialValue: information.title)
        _subtitle = State(initialValue: information.subtitle ?? "")
        let expiryDate = DocumentInformationSheetModel.date(information.expiredAt)
        _hasExpiry = State(initialValue: expiryDate != nil)
        _expiry = State(initialValue: expiryDate ?? .now)
        let renewalDate = DocumentInformationSheetModel.date(information.renewalAt)
        _hasRenewal = State(initialValue: renewalDate != nil)
        _renewal = State(initialValue: renewalDate ?? .now)
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 5) {
                    fieldLabel("Title", saving: "title")
                    TextField("Document title", text: $title)
                        .focused($focusedField, equals: .title)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .subtitle }
                        .disabled(!information.canEdit)
                        .accessibilityIdentifier("document-information-title")
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard information.canEdit else { return }
                    focusedField = .title
                }
                .listRowSeparator(.visible, edges: .bottom)
                .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 5, trailing: 20))

                VStack(alignment: .leading, spacing: 5) {
                    fieldLabel("Subtitle", saving: "subtitle")
                    TextField("Add a subtitle", text: $subtitle, axis: .vertical)
                        .focused($focusedField, equals: .subtitle)
                        .lineLimit(2 ... 4)
                        .submitLabel(.done)
                        .onSubmit { focusedField = nil }
                        .disabled(!information.canEdit)
                        .accessibilityIdentifier("document-information-subtitle")
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard information.canEdit else { return }
                    focusedField = .subtitle
                }
                .listRowSeparator(.visible, edges: .bottom)
                .listRowInsets(EdgeInsets(top: 5, leading: 20, bottom: 8, trailing: 20))

                Picker(
                    "Status",
                    selection: Binding(
                        get: { information.status },
                        set: { value in Task { await saveStatus(value) } }
                    )
                ) {
                    ForEach(statuses, id: \.self) { status in
                        Text(status.formattedDocumentStatus).tag(status)
                    }
                }
                .disabled(!information.canEdit || savingFields.contains("status"))

                ownerPicker
            } header: {
                Text("Document Details")
            } footer: {
                if !information.canEdit {
                    Text("You have view-only access.")
                }
            }

            Section("Dates") {
                optionalDateRow(
                    title: "Expiry date",
                    hasDate: $hasExpiry,
                    date: $expiry,
                    savingField: "expiry",
                    save: saveExpiry
                )
                optionalDateRow(
                    title: "Renewal date",
                    hasDate: $hasRenewal,
                    date: $renewal,
                    savingField: "renewal",
                    save: saveRenewal
                )
            }

            Section("System Information") {
                systemRow("Document ID", value: information.displayId.map { "#\($0)" } ?? information.id)
                systemRow("Created by", value: information.createdByName)
                systemRow("Created", date: information.createdAt)
                systemRow("Last modified", date: information.updatedAt)
                systemRow("Sent", date: information.sentAt)
                systemRow("Accepted", date: information.acceptedAt)
                systemRow("Closed", date: information.closedAt)
                systemRow("Views", value: information.viewCount.map(String.init) ?? "No views")
                if let source = information.source, !source.isEmpty {
                    systemRow("Source", value: source.formattedDocumentStatus)
                }
            }
        }
        .formStyle(.grouped)
        .onChange(of: focusedField) { oldValue, newValue in
            guard oldValue != newValue else { return }
            switch oldValue {
            case .title:
                Task { await saveTitle(title) }
            case .subtitle:
                Task { await saveSubtitle(subtitle) }
            case nil:
                break
            }
        }
        .onChange(of: information.title) { _, value in
            guard focusedField != .title else { return }
            title = value
        }
        .onChange(of: information.subtitle) { _, value in
            guard focusedField != .subtitle else { return }
            subtitle = value ?? ""
        }
    }

    @ViewBuilder
    private var ownerPicker: some View {
        let users = bootstrap?.assignableCompanyUsers ?? []
        if information.canEdit, !users.isEmpty {
            Picker(
                "Owner",
                selection: Binding(
                    get: { information.ownerUserId },
                    set: { userID in
                        guard let user = users.first(where: { $0.id == userID }) else { return }
                        Task { await saveOwner(user) }
                    }
                )
            ) {
                if !users.contains(where: { $0.id == information.ownerUserId }) {
                    Text(information.ownerName).tag(information.ownerUserId)
                }
                ForEach(users) { user in
                    Text(user.displayName).tag(user.id)
                }
            }
            .disabled(savingFields.contains("owner"))
        } else {
            systemRow("Owner", value: information.ownerName)
        }
    }

    private func fieldLabel(_ title: String, saving field: String) -> some View {
        HStack {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if savingFields.contains(field) {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Saving \(title.lowercased())")
            }
        }
    }

    private func optionalDateRow(
        title: String,
        hasDate: Binding<Bool>,
        date: Binding<Date>,
        savingField: String,
        save: @escaping (Date?) async -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(title, isOn: hasDate)
                .disabled(!information.canEdit || savingFields.contains(savingField))
                .onChange(of: hasDate.wrappedValue) { _, isEnabled in
                    Task { await save(isEnabled ? date.wrappedValue : nil) }
                }
            if hasDate.wrappedValue {
                DatePicker(
                    title,
                    selection: date,
                    displayedComponents: .date
                )
                .labelsHidden()
                .disabled(!information.canEdit || savingFields.contains(savingField))
                .onChange(of: date.wrappedValue) { _, value in
                    Task { await save(value) }
                }
            }
        }
    }

    private func systemRow(_ label: String, value: String) -> some View {
        LabeledContent(label) {
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func systemRow(_ label: String, date milliseconds: Double?) -> some View {
        systemRow(label, value: Self.formattedDate(milliseconds))
    }

    private static func formattedDate(_ milliseconds: Double?) -> String {
        guard let date = DocumentInformationSheetModel.date(milliseconds) else { return "Not set" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private static let statuses = [
        "creating",
        "sent",
        "opened",
        "signing",
        "signing_complete",
        "part_paid",
        "paid",
        "accepted",
        "lost",
        "expired"
    ]

    private var statuses: [String] {
        Self.statuses.contains(information.status)
            ? Self.statuses
            : [information.status] + Self.statuses
    }
}
