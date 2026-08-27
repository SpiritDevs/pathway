import SwiftUI

@MainActor
struct SettingsDataRetentionView: View {
    let catalog: MobileSettingsCatalog
    let service: any SettingsBillingServicing
    let locale: Locale
    let deviceAuth: @MainActor () async throws -> Void
    let onCancellation: @MainActor (SettingsCompanyCancellationResult) async -> Void
    let onSensitiveOperationStateChange: @MainActor (Bool) -> Void

    @State private var addonState: SettingsAccountLoadState<[SettingsMarketplaceAddon]> = .loading
    @State private var reloadID = UUID()

    var body: some View {
        Form {
            Section {
                SettingsIconLabel("Company data", systemName: "building.2", color: .indigo)
                SettingsIconLabel("Documents and activity", systemName: "doc.on.doc", color: .blue)
                SettingsIconLabel("Billing records", systemName: "creditcard", color: .green)
            } header: {
                Text("Data Lifecycle")
            } footer: {
                Text("Company data follows Pathway's contractual, legal and operational retention requirements. Closing a company is not the same as deleting your personal login.")
            }

            Section("Current Company") {
                LabeledContent("Company", value: catalog.workspace.companyName)
                LabeledContent("Account status") {
                    SettingsStatusLabel(status: catalog.workspace.accountStatus.rawValue)
                }
                LabeledContent("Storage region", value: catalog.workspace.storageLocation)
            }

            Section {
                addonContent
            } header: {
                Text("Installed Add-ons")
            } footer: {
                Text("Installed add-ons are shown before a company closure request so you can understand the subscriptions affected.")
            }

            Section {
                if catalog.lifecycle.canCloseCompany {
                    NavigationLink {
                        SettingsCompanyClosureConfirmationView(
                            catalog: catalog,
                            addons: loadedAddons,
                            service: service,
                            deviceAuth: deviceAuth,
                            onCancellation: onCancellation,
                            onSensitiveOperationStateChange: onSensitiveOperationStateChange
                        )
                    } label: {
                        SettingsIconLabel("Close Company Account", systemName: "xmark.octagon", color: .red)
                            .foregroundStyle(.red)
                    }
                    .accessibilityHint("Opens a separate confirmation screen")
                } else {
                    SettingsIconLabel(
                        "You don't have permission to request company closure",
                        systemName: "lock",
                        color: .gray
                    )
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Company Closure")
            } footer: {
                Text("This requests closure of the company and its subscription for everyone. It does not delete your personal Pathway user account.")
            }
        }
        .navigationTitle("Data Retention")
        .task(id: reloadID) { await loadAddons() }
    }

    @ViewBuilder
    private var addonContent: some View {
        switch addonState {
        case .loading:
            SettingsAccountLoadingRows(count: 2)
        case let .failed(message):
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                Button("Try Again") { reloadID = UUID() }
            }
        case let .loaded(addons):
            if addons.isEmpty {
                Text("No installed add-ons")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(addons) { addon in
                    HStack {
                        Text(addon.name)
                        Spacer()
                        Text(addon.currentTierLabel ?? addon.priceLabel)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var loadedAddons: [SettingsMarketplaceAddon] {
        guard case let .loaded(addons) = addonState else { return [] }
        return addons
    }

    private func loadAddons() async {
        do {
            let addons = try await service.loadInstalledAddons(
                locale: locale.language.languageCode?.identifier
            )
            try Task.checkCancellation()
            addonState = .loaded(addons)
        } catch is CancellationError {
            return
        } catch {
            addonState = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}

@MainActor
private struct SettingsCompanyClosureConfirmationView: View {
    private enum SubmissionState {
        case idle
        case closing
        case failed(String)
    }

    let catalog: MobileSettingsCatalog
    let addons: [SettingsMarketplaceAddon]
    let service: any SettingsBillingServicing
    let deviceAuth: @MainActor () async throws -> Void
    let onCancellation: @MainActor (SettingsCompanyCancellationResult) async -> Void
    let onSensitiveOperationStateChange: @MainActor (Bool) -> Void

    @FocusState private var isConfirmationFocused: Bool
    @State private var confirmation = ""
    @State private var state: SubmissionState = .idle

    private var matchesCompanyName: Bool {
        confirmation.trimmingCharacters(in: .whitespacesAndNewlines) == catalog.workspace.companyName
    }

    private var isClosing: Bool {
        if case .closing = state { return true }
        return false
    }

    var body: some View {
        Form {
            Section {
                SettingsIconLabel(
                    "This affects everyone in the company",
                    systemName: "exclamationmark.triangle.fill",
                    color: .red
                )
                    .font(.headline)
                    .foregroundStyle(.red)
                Text("Closing \(catalog.workspace.companyName) requests cancellation of its Pathway subscription. Company access changes when the request is processed.")
            }

            Section("Before You Continue") {
                SettingsIconLabel(
                    "The closure applies to the company, not only your login",
                    systemName: "person.3",
                    color: .indigo
                )
                SettingsIconLabel(
                    "Subscription billing will be scheduled for cancellation",
                    systemName: "creditcard",
                    color: .orange
                )
                SettingsIconLabel(
                    "Retention remains governed by your agreement and applicable obligations",
                    systemName: "archivebox",
                    color: .blue
                )
                if !addons.isEmpty {
                    SettingsIconLabel(
                        "\(addons.count) installed add-on\(addons.count == 1 ? "" : "s") will be affected",
                        systemName: "puzzlepiece.extension",
                        color: .purple
                    )
                }
            }

            Section {
                TextField("Company name", text: $confirmation)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .focused($isConfirmationFocused)
                    .accessibilityLabel("Type \(catalog.workspace.companyName) to confirm")
                    .accessibilityHint("The Close Account button becomes available when the company name matches exactly")
                if !confirmation.isEmpty {
                    Label(
                        matchesCompanyName ? "Company name matches" : "Company name doesn't match",
                        systemImage: matchesCompanyName ? "checkmark.circle.fill" : "xmark.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(matchesCompanyName ? .green : .secondary)
                }
            } header: {
                Text("Type \(catalog.workspace.companyName) to confirm")
            }

            if case let .failed(message) = state {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    Text("Your company account has not been closed.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button(role: .destructive) {
                    Task { await closeCompany() }
                } label: {
                    HStack {
                        Text("Close Account")
                        Spacer()
                        if isClosing { ProgressView() }
                    }
                }
                .disabled(!matchesCompanyName || isClosing)
                .accessibilityHint("Authenticates this device, then requests company closure. This affects the whole company.")
            } footer: {
                Text("This is a company and subscription closure request. It is not personal user deletion or an immediate data-erasure request.")
            }
        }
        .navigationTitle("Close Company")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .navigationBarBackButtonHidden(isClosing)
        .interactiveDismissDisabled(isClosing)
    }

    private func closeCompany() async {
        guard matchesCompanyName else { return }
        state = .closing
        onSensitiveOperationStateChange(true)
        defer { onSensitiveOperationStateChange(false) }
        do {
            try await deviceAuth()
            let result = try await service.requestCompanyCancellation(
                reason: "Company closure requested from iOS settings",
                details: nil
            )
            guard result.success else {
                state = .failed("Pathway couldn't submit the closure request.")
                return
            }
            await onCancellation(result)
        } catch is CancellationError {
            state = .idle
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}
