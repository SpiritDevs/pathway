import SwiftUI

/// Routes the catalog-backed workspace, content, and advanced settings destinations.
///
/// Permission-denied destinations are intentionally absent from the catalog. This view
/// therefore fails closed when a route is not present instead of rendering a guessed state.
struct SettingsWorkspaceContentDestinationView: View {
    let route: SettingsRoute
    let catalog: MobileSettingsCatalog
    let locale: Locale
    let manageAddons: (String) -> Void

    var body: some View {
        Group {
            if let destination = destination {
                switch destination.availability {
                case .available:
                    availableDestination
                case let .addonRequired(code):
                    SettingsWCLockedDestinationView(
                        title: route.localizedTitle(locale: locale),
                        addonCode: code,
                        locale: locale,
                        manageAddons: manageAddons
                    )
                }
            } else {
                SettingsWCAccessUnavailableView(
                    title: route.localizedTitle(locale: locale),
                    locale: locale
                )
            }
        }
        .navigationTitle(route.localizedTitle(locale: locale))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var destination: MobileSettingsCatalog.Destination? {
        catalog.destinations.first { SettingsRoute(destination: $0) == route }
    }

    @ViewBuilder
    private var availableDestination: some View {
        switch route {
        case .company:
            SettingsWCCompanyView(catalog: catalog, locale: locale)
        case .security:
            SettingsWCSecurityView(catalog: catalog, locale: locale)
        case .users:
            SettingsWCUsersView(catalog: catalog, locale: locale)
        case .teams:
            SettingsWCTeamsView(catalog: catalog, locale: locale)
        case .roles:
            SettingsWCRolesView(catalog: catalog, locale: locale)
        case .fonts:
            SettingsWCFontsView(catalog: catalog, locale: locale)
        case .emailTemplates:
            SettingsWCEmailTemplatesView(catalog: catalog, locale: locale)
        case .emailSetup:
            SettingsWCEmailSetupView(catalog: catalog, locale: locale)
        case .deliveryRules:
            SettingsWCDeliveryRulesView(catalog: catalog, locale: locale)
        case .customDataItems:
            SettingsWCCustomDataItemsView(catalog: catalog, locale: locale)
        case .api:
            SettingsWCAPICredentialsView(catalog: catalog, locale: locale)
        case .integrations:
            SettingsWCIntegrationsView(catalog: catalog, locale: locale)
        case .salesforce:
            SettingsWCSalesforceView(catalog: catalog, locale: locale)
        default:
            SettingsWCUnsupportedDestinationView(
                title: route.localizedTitle(locale: locale),
                locale: locale
            )
        }
    }
}

struct SettingsWCValueRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let label: String
    let value: String
    let systemImage: String

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    SettingsIconLabel(label, systemName: systemImage)
                        .foregroundStyle(.primary)
                    Text(value)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                LabeledContent {
                    Text(value)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                } label: {
                    SettingsIconLabel(label, systemName: systemImage)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(value)")
    }
}

struct SettingsWCInformationRow: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            SettingsSymbol(systemName: systemImage)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct SettingsWCLockedDestinationView: View {
    let title: String
    let addonCode: String
    let locale: Locale
    let manageAddons: (String) -> Void

    var body: some View {
        ContentUnavailableView {
            Label(
                String(
                    localized: "settings.workspace_content.locked.title",
                    defaultValue: "Add-on required",
                    locale: locale
                ),
                systemImage: "lock.fill"
            )
        } description: {
            Text(
                String(
                    localized: "settings.workspace_content.locked.message",
                    defaultValue: "\(title) requires the \(displayAddonName) add-on for your company.",
                    locale: locale
                )
            )
        } actions: {
            Button {
                manageAddons(addonCode)
            } label: {
                Text(
                    String(
                        localized: "settings.workspace_content.locked.view_addons",
                        defaultValue: "View Add-ons",
                        locale: locale
                    )
                )
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint(
                String(
                    localized: "settings.workspace_content.locked.view_addons.hint",
                    defaultValue: "Opens the native Add-ons settings.",
                    locale: locale
                )
            )
        }
    }

    private var displayAddonName: String {
        addonCode
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

struct SettingsWCAccessUnavailableView: View {
    let title: String
    let locale: Locale

    var body: some View {
        ContentUnavailableView {
            Label(
                String(
                    localized: "settings.workspace_content.access_unavailable.title",
                    defaultValue: "Access unavailable",
                    locale: locale
                ),
                systemImage: "lock.shield"
            )
        } description: {
            Text(
                String(
                    localized: "settings.workspace_content.access_unavailable.message",
                    defaultValue: "\(title) is not available for your current company access.",
                    locale: locale
                )
            )
        }
    }
}

struct SettingsWCUnsupportedDestinationView: View {
    let title: String
    let locale: Locale

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "gearshape")
        } description: {
            Text(
                String(
                    localized: "settings.workspace_content.unsupported.message",
                    defaultValue: "This setting is handled by another part of Pathway.",
                    locale: locale
                )
            )
        }
    }
}
