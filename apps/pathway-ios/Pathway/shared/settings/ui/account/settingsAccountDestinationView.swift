import SwiftUI

@MainActor
struct SettingsAccountDestinationView: View {
    let route: SettingsRoute
    let catalog: MobileSettingsCatalog
    let billingService: any SettingsBillingServicing
    let supportService: any SettingsSupportServicing
    let deviceAuth: @MainActor () async throws -> Void
    let logout: @MainActor () -> Void
    let onCompanyCancellation: @MainActor (SettingsCompanyCancellationResult) async -> Void
    let locale: Locale
    let supportInitialSection: String?
    let onSensitiveOperationStateChange: @MainActor (Bool) -> Void
    let onOpenWhatsNew: @MainActor () -> Void

    init(
        route: SettingsRoute,
        catalog: MobileSettingsCatalog,
        billingService: any SettingsBillingServicing,
        supportService: any SettingsSupportServicing,
        deviceAuth: @escaping @MainActor () async throws -> Void,
        logout: @escaping @MainActor () -> Void,
        onCompanyCancellation: @escaping @MainActor (SettingsCompanyCancellationResult) async -> Void,
        locale: Locale,
        supportInitialSection: String? = nil,
        onSensitiveOperationStateChange: @escaping @MainActor (Bool) -> Void = { _ in },
        onOpenWhatsNew: @escaping @MainActor () -> Void = {}
    ) {
        self.route = route
        self.catalog = catalog
        self.billingService = billingService
        self.supportService = supportService
        self.deviceAuth = deviceAuth
        self.logout = logout
        self.onCompanyCancellation = onCompanyCancellation
        self.locale = locale
        self.supportInitialSection = supportInitialSection
        self.onSensitiveOperationStateChange = onSensitiveOperationStateChange
        self.onOpenWhatsNew = onOpenWhatsNew
    }

    @ViewBuilder
    var body: some View {
        switch route {
        case .billing:
            SettingsBillingView(service: billingService, locale: locale)
        case .addons:
            SettingsAddonsView(
                service: billingService,
                locale: locale,
                deviceAuth: deviceAuth,
                onSensitiveOperationStateChange: onSensitiveOperationStateChange
            )
        case .support:
            SettingsSupportView(
                catalog: catalog,
                service: supportService,
                locale: locale,
                initialSection: supportInitialSection
            )
        case .about:
            SettingsAboutView(
                catalog: catalog,
                locale: locale,
                onOpenWhatsNew: onOpenWhatsNew
            )
        case .dataRetention:
            SettingsDataRetentionView(
                catalog: catalog,
                service: billingService,
                locale: locale,
                deviceAuth: deviceAuth,
                onCancellation: onCompanyCancellation,
                onSensitiveOperationStateChange: onSensitiveOperationStateChange
            )
        case .logout:
            SettingsLogoutView(logout: logout)
        default:
            ContentUnavailableView(
                "Destination Unavailable",
                systemImage: "gearshape",
                description: Text("\(route.localizedTitle(locale: locale)) is provided by another settings module.")
            )
            .navigationTitle(route.localizedTitle(locale: locale))
        }
    }
}

@MainActor
struct SettingsLogoutView: View {
    let logout: @MainActor () -> Void

    @State private var showsConfirmation = false

    var body: some View {
        Form {
            Section {
                SettingsIconLabel(
                    "End this session on this device",
                    systemName: "rectangle.portrait.and.arrow.right",
                    color: .red
                )
            } footer: {
                Text("Logging out does not change your company, subscription or retained data.")
            }
            Section {
                Button("Log Out", role: .destructive) {
                    showsConfirmation = true
                }
            }
        }
        .navigationTitle("Log Out")
        .confirmationDialog(
            "Log out of Pathway?",
            isPresented: $showsConfirmation,
            titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive, action: logout)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need to sign in again to access this account on this device.")
        }
    }
}
