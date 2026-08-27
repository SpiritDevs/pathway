import SwiftUI
import UIKit

@MainActor
struct SettingsSheet: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var selectedRoute: SettingsRoute?
    @State private var preferredCompactColumn: NavigationSplitViewColumn = .sidebar
    @State private var isLogoutConfirmationPresented = false
    @State private var isSensitiveOperationInFlight = false
    @State private var isProfileDirty = false
    @State private var supportInitialSection: String?

    var body: some View {
        @Bindable var store = appModel.settingsStore
        @Bindable var preferences = appModel.settingsDevicePreferences

        NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
            rootContent(store: store) { route in
                select(route)
            }
            .disabled(isSensitiveOperationInFlight || isProfileDirty)
            .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 420)
            .toolbar {
                if selectedRoute == nil {
                    doneToolbar
                }
            }
        } detail: {
            if let selectedRoute {
                NavigationStack {
                    destinationContent(for: selectedRoute)
                }
            } else {
                ContentUnavailableView(
                    "Choose a Setting",
                    systemImage: "gearshape",
                    description: Text("Select an item from the settings list.")
                )
            }
        }
        .environment(\.locale, preferences.locale)
        .preferredColorScheme(preferredColorScheme(for: preferences.appearance))
        .interactiveDismissDisabled(isSensitiveOperationInFlight || isProfileDirty)
        .confirmationDialog(
            "Log out of Pathway?",
            isPresented: $isLogoutConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive) {
                Task {
                    await appModel.signOut()
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You will need to sign in again on this device.")
        }
        .onAppear {
            appModel.settingsStore.start()
        }
        .onDisappear {
            appModel.settingsStore.stop()
        }
        .onChange(of: preferredCompactColumn) { _, column in
            guard column == .sidebar else { return }
            if isSensitiveOperationInFlight || isProfileDirty {
                preferredCompactColumn = .detail
            } else {
                selectedRoute = nil
            }
        }
    }

    private func preferredColorScheme(
        for appearance: SettingsAppearancePreference
    ) -> ColorScheme? {
        switch appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private func rootContent(
        store: SettingsFeatureStore,
        onSelect: @escaping (SettingsRoute) -> Void
    ) -> some View {
        SettingsRootContent(
            phase: store.phase,
            catalog: store.catalog,
            destinations: store.destinations,
            searchText: Binding(
                get: { store.searchText },
                set: { store.searchText = $0 }
            ),
            locale: appModel.settingsDevicePreferences.locale,
            cloudFrontSignature: appModel.companyAssetSignature,
            currentProfileColor: appModel.dashboardBootstrap?.userData.profileColor,
            onSelect: onSelect,
            onRetry: store.retry
        )
    }

    private func select(_ route: SettingsRoute) {
        guard !isSensitiveOperationInFlight, !isProfileDirty else { return }
        guard route != .logout else {
            isLogoutConfirmationPresented = true
            return
        }
        if route == .support {
            supportInitialSection = nil
        }
        selectedRoute = route
        preferredCompactColumn = .detail
    }

    @ViewBuilder
    private func destinationContent(for route: SettingsRoute) -> some View {
        if route == .profile {
            destination(for: route)
        } else {
            destination(for: route)
                .toolbar {
                    doneToolbar
                }
        }
    }

    @ViewBuilder
    private func destination(for route: SettingsRoute) -> some View {
        if let item = destinationItem(for: route), case .addonRequired = item.availability {
            SettingsLockedFeatureView(
                item: item,
                onOpenAddons: openAddonsAction
            )
        } else if route != .profile, destinationItem(for: route) == nil {
            ContentUnavailableView(
                "Access Unavailable",
                systemImage: "lock.shield",
                description: Text("This setting is not available for your current company access.")
            )
            .navigationTitle(route.localizedTitle(locale: appModel.settingsDevicePreferences.locale))
            .navigationBarTitleDisplayMode(.inline)
        } else if let catalog = appModel.settingsStore.catalog {
            switch route {
            case .profile:
                SettingsProfileView(
                    service: appModel.settingsProfileService,
                    roleNames: catalog.roleNames,
                    cloudFrontSignature: appModel.companyAssetSignature,
                    onRequestBack: returnToSettingsRoot,
                    onDirtyStateChange: setProfileDirty
                )
            case .device:
                SettingsDeviceView(
                    preferences: appModel.settingsDevicePreferences,
                    openNotificationSettings: openNotificationSettings
                )
            case .company, .security, .users, .teams, .roles, .fonts,
                    .emailTemplates, .salesforce, .emailSetup, .deliveryRules,
                    .customDataItems, .api, .integrations:
                SettingsWorkspaceContentDestinationView(
                    route: route,
                    catalog: catalog,
                    locale: appModel.settingsDevicePreferences.locale,
                    manageAddons: { _ in navigateToAddons() }
                )
            case .billing, .addons, .support, .about, .dataRetention, .logout:
                SettingsAccountDestinationView(
                    route: route,
                    catalog: catalog,
                    billingService: appModel.settingsBillingService,
                    supportService: appModel.settingsSupportService,
                    deviceAuth: authenticateSensitiveChange,
                    logout: { isLogoutConfirmationPresented = true },
                    onCompanyCancellation: finishCompanyCancellation,
                    locale: appModel.settingsDevicePreferences.locale,
                    supportInitialSection: supportInitialSection,
                    onSensitiveOperationStateChange: setSensitiveOperationInFlight,
                    onOpenWhatsNew: navigateToWhatsNew
                )
            }
        } else {
            ContentUnavailableView(
                "Settings Unavailable",
                systemImage: "exclamationmark.triangle",
                description: Text("Return to the settings list and try again.")
            )
        }
    }

    private func destinationItem(for route: SettingsRoute) -> SettingsDestinationSearchItem? {
        guard let destination = appModel.settingsStore.catalog?.destinations.first(where: {
            SettingsRoute(destination: $0) == route
        }) else {
            return nil
        }
        return SettingsDestinationSearchItem(
            route: route,
            title: route.localizedTitle(locale: appModel.settingsDevicePreferences.locale),
            section: destination.section,
            availability: destination.availability
        )
    }

    private var canOpenAddons: Bool {
        destinationItem(for: .addons) != nil
    }

    private var openAddonsAction: (() -> Void)? {
        guard canOpenAddons else { return nil }
        return { navigateToAddons() }
    }

    private func navigateToAddons() {
        guard canOpenAddons else { return }
        navigate(to: .addons)
    }

    private func returnToSettingsRoot() {
        guard !isSensitiveOperationInFlight, !isProfileDirty else { return }
        selectedRoute = nil
        preferredCompactColumn = .sidebar
    }

    private func navigate(to route: SettingsRoute) {
        guard !isSensitiveOperationInFlight, !isProfileDirty else { return }
        selectedRoute = route
        preferredCompactColumn = .detail
    }

    private func navigateToWhatsNew() {
        supportInitialSection = "news"
        navigate(to: .support)
    }

    private func setSensitiveOperationInFlight(_ isInFlight: Bool) {
        isSensitiveOperationInFlight = isInFlight
    }

    private func setProfileDirty(_ isDirty: Bool) {
        isProfileDirty = isDirty
    }

    private func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        openURL(url)
    }

    private func authenticateSensitiveChange() async throws {
        try await appModel.authenticateSensitiveSettingsChange(
            reason: "Confirm this sensitive Pathway settings change."
        )
    }

    private func finishCompanyCancellation(_ result: SettingsCompanyCancellationResult) async {
        await appModel.finishCompanyCancellation(
            hasAnotherSelectableCompany: result.hasAnotherSelectableCompany
        )
        dismiss()
    }

    private func requestDismiss() {
        guard !isSensitiveOperationInFlight, !isProfileDirty else { return }
        dismiss()
    }

    @ToolbarContentBuilder
    private var doneToolbar: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Done", action: requestDismiss)
                .disabled(isSensitiveOperationInFlight)
        }
    }
}
