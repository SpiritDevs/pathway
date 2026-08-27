import SwiftUI
import UIKit

@MainActor
struct SettingsAddonsView: View {
    private struct Content {
        let addons: [SettingsMarketplaceAddon]
        let snapshot: SettingsAddonSnapshot
    }

    let service: any SettingsBillingServicing
    let locale: Locale
    let deviceAuth: @MainActor () async throws -> Void
    let onSensitiveOperationStateChange: @MainActor (Bool) -> Void

    @State private var state: SettingsAccountLoadState<Content> = .loading
    @State private var reloadID = UUID()

    var body: some View {
        Group {
            switch state {
            case .loading:
                List { SettingsAccountLoadingRows(count: 4) }
            case let .failed(message):
                SettingsAccountErrorView(message: message) { reloadID = UUID() }
            case let .loaded(content):
                addonList(content)
            }
        }
        .navigationTitle("Add-ons")
        .task(id: reloadID) { await load() }
    }

    private func addonList(_ content: Content) -> some View {
        List {
            Section {
                if content.addons.isEmpty {
                    ContentUnavailableView(
                        "No Add-ons Installed",
                        systemImage: "puzzlepiece.extension",
                        description: Text("Add-ons can be discovered and purchased in Pathway on the web.")
                    )
                } else {
                    ForEach(content.addons) { addon in
                        NavigationLink {
                            SettingsAddonDetailView(
                                addon: addon,
                                subscription: content.snapshot.subscriptions.first {
                                    $0.addon.caseInsensitiveCompare(addon.addonCode) == .orderedSame
                                },
                                service: service,
                                deviceAuth: deviceAuth,
                                onSensitiveOperationStateChange: onSensitiveOperationStateChange,
                                onChanged: { reloadID = UUID() }
                            )
                        } label: {
                            SettingsAddonRow(addon: addon)
                        }
                    }
                }
            } header: {
                Text("Installed Add-ons")
            } footer: {
                Text("This app can manage current add-ons. New trials, purchases and upgrades remain available on the web.")
            }
        }
        .refreshable { await load() }
    }

    private func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            let addons = try await service.loadInstalledAddons(
                locale: locale.language.languageCode?.identifier
            )
            let snapshot = try await service.loadAddons()
            state = .loaded(Content(addons: addons, snapshot: snapshot))
        } catch is CancellationError {
            return
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}

private struct SettingsAddonRow: View {
    let addon: SettingsMarketplaceAddon

    private var status: String {
        if addon.suspended { return "suspended" }
        if addon.included { return "included" }
        return addon.subscribed ? "active" : "pending"
    }

    var body: some View {
        HStack(spacing: 12) {
            SettingsSymbol(
                systemName: addon.included ? "checkmark.seal.fill" : "puzzlepiece.extension.fill",
                color: addon.suspended ? .gray : .green
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(addon.name)
                    .font(.body.weight(.medium))
                Text(addon.currentTierLabel ?? addon.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            SettingsStatusLabel(status: status)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(addon.name), \(status)")
    }
}

@MainActor
private struct SettingsAddonDetailView: View {
    let addon: SettingsMarketplaceAddon
    let subscription: SettingsAddonSnapshot.Subscription?
    let service: any SettingsBillingServicing
    let deviceAuth: @MainActor () async throws -> Void
    let onSensitiveOperationStateChange: @MainActor (Bool) -> Void
    let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showConfirmation = false
    @State private var isUnsubscribing = false
    @State private var errorMessage: String?

    private var canUnsubscribe: Bool {
        addon.subscribed && !addon.included && !addon.suspended
    }

    var body: some View {
        Form {
            Section {
                SettingsAddonRow(addon: addon)
            }

            Section("Details") {
                if !addon.subtitle.isEmpty {
                    Text(addon.subtitle)
                }
                LabeledContent("Developer", value: addon.developer)
                LabeledContent("Price", value: addon.priceLabel)
                if let tier = addon.currentTierLabel {
                    LabeledContent("Current tier", value: tier)
                }
                if let pending = subscription?.pendingChange {
                    LabeledContent("Pending change") {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(pending.action.capitalized)
                            if let date = SettingsAccountFormatting.dateText(
                                pending.effectiveAt,
                                locale: .autoupdatingCurrent
                            ) {
                                Text(date).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }

            if canUnsubscribe {
                Section {
                    Button(role: .destructive) {
                        showConfirmation = true
                    } label: {
                        HStack {
                            Text("Unsubscribe from \(addon.name)")
                            Spacer()
                            if isUnsubscribing { ProgressView() }
                        }
                    }
                    .disabled(isUnsubscribing)
                    .accessibilityHint("Cancels renewal after device authentication")
                } footer: {
                    Text(unsubscribeConsequence)
                }
            } else if addon.included {
                Section {
                    SettingsIconLabel(
                        "Included with your current plan",
                        systemName: "checkmark.seal",
                        color: .green
                    )
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(addon.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isUnsubscribing)
        .interactiveDismissDisabled(isUnsubscribing)
        .confirmationDialog(
            "Unsubscribe from \(addon.name)?",
            isPresented: $showConfirmation,
            titleVisibility: .visible
        ) {
            Button("Unsubscribe", role: .destructive) {
                Task { await unsubscribe() }
            }
            Button("Keep Add-on", role: .cancel) {}
        } message: {
            Text(unsubscribeConsequence)
        }
    }

    private var unsubscribeConsequence: String {
        if let date = SettingsAccountFormatting.dateText(
            subscription?.pendingChange?.effectiveAt ?? subscription?.effectiveDate,
            locale: .autoupdatingCurrent
        ) {
            return "You'll keep access until \(date). After that, the add-on won't renew and its features will turn off."
        }
        return "This stops renewal of the add-on. Its features will turn off when the current access period ends."
    }

    private func unsubscribe() async {
        isUnsubscribing = true
        onSensitiveOperationStateChange(true)
        errorMessage = nil
        defer {
            isUnsubscribing = false
            onSensitiveOperationStateChange(false)
        }
        do {
            try await deviceAuth()
            let result = try await service.unsubscribeAddon(
                code: addon.addonCode,
                planVersionID: subscription?.planId
            )
            guard result.success else {
                errorMessage = "Pathway couldn't unsubscribe this add-on. Nothing changed."
                return
            }
            onChanged()
            UIAccessibility.post(notification: .announcement, argument: "Add-on unsubscribed")
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = SettingsAccountFormatting.displayError(error)
        }
    }
}
