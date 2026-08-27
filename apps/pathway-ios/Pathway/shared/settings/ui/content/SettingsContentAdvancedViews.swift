import SwiftUI

struct SettingsWCFontsView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.fonts.access.section", defaultValue: "Font book", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.fonts.access", defaultValue: "Font management", locale: locale),
                    value: catalog.permissions.manageFontBook
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "textformat"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.fonts.native.title", defaultValue: "Company fonts", locale: locale),
                    message: String(
                        localized: "settings.fonts.native.message",
                        defaultValue: "Font files and previews are not downloaded by mobile settings yet. Uploading, renaming and deleting fonts are therefore unavailable here.",
                        locale: locale
                    ),
                    systemImage: "textformat.abc"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCEmailTemplatesView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.email_templates.availability.section", defaultValue: "Templates", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.email_templates.company", defaultValue: "Company", locale: locale),
                    value: catalog.workspace.companyName,
                    systemImage: "building.2"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.email_templates.native.title", defaultValue: "Template editing unavailable", locale: locale),
                    message: String(
                        localized: "settings.email_templates.native.message",
                        defaultValue: "The app does not load reusable email content in settings yet. No template can be created, edited or removed from this screen.",
                        locale: locale
                    ),
                    systemImage: "envelope"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCEmailSetupView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.email_setup.identity.section", defaultValue: "Sending identity", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.email_setup.account", defaultValue: "Pathway account", locale: locale),
                    value: catalog.identity.email,
                    systemImage: "at"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.email_setup.status.title", defaultValue: "Provider status not loaded", locale: locale),
                    message: String(
                        localized: "settings.email_setup.status.message",
                        defaultValue: "Configured senders and domains are not included in the mobile settings catalog.",
                        locale: locale
                    ),
                    systemImage: "envelope.badge"
                )
            }

            Section {
                SettingsWCBrowserAuthorizationRow(
                    provider: "Google Workspace",
                    systemImage: "g.circle",
                    locale: locale
                )
                SettingsWCBrowserAuthorizationRow(
                    provider: "Microsoft Outlook",
                    systemImage: "m.circle",
                    locale: locale
                )
            } header: {
                Text(
                    String(localized: "settings.email_setup.providers.section", defaultValue: "Connected providers", locale: locale)
                )
            } footer: {
                Text(
                    String(
                        localized: "settings.email_setup.providers.footer",
                        defaultValue: "Connecting an email provider requires a secure browser sign-in that is not available in the app yet. No connection is started from this screen.",
                        locale: locale
                    )
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCDeliveryRulesView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.delivery_rules.status.section", defaultValue: "Delivery automation", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.delivery_rules.entitlement", defaultValue: "Availability", locale: locale),
                    value: String(localized: "settings.common.included", defaultValue: "Included", locale: locale),
                    systemImage: "paperplane"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.delivery_rules.native.title", defaultValue: "Rules not loaded", locale: locale),
                    message: String(
                        localized: "settings.delivery_rules.native.message",
                        defaultValue: "Scheduled delivery rules are not downloaded by mobile settings yet. This screen does not create, reorder or remove rules.",
                        locale: locale
                    ),
                    systemImage: "clock.arrow.circlepath"
                )
            }

            SettingsWCActiveAddonsSection(catalog: catalog, locale: locale)
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCCustomDataItemsView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.custom_data.access.section", defaultValue: "Custom data access", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.custom_data.permission", defaultValue: "Data item management", locale: locale),
                    value: catalog.permissions.manageDataItems
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "curlybraces.square"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.custom_data.native.title", defaultValue: "Read-only safety state", locale: locale),
                    message: String(
                        localized: "settings.custom_data.native.message",
                        defaultValue: "Custom data items are intentionally not fetched here because the current server contract is not bounded for mobile use. No data item is created or changed from this screen.",
                        locale: locale
                    ),
                    systemImage: "shield.lefthalf.filled"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCAPICredentialsView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.api.access.section", defaultValue: "Developer access", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.api.permission", defaultValue: "Developer Center", locale: locale),
                    value: catalog.permissions.canAccessDevCenter
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.unavailable", defaultValue: "Unavailable", locale: locale),
                    systemImage: "chevron.left.forwardslash.chevron.right"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.api.secrets.title", defaultValue: "Credentials stay protected", locale: locale),
                    message: String(
                        localized: "settings.api.secrets.message",
                        defaultValue: "API keys, test tokens and webhook secrets are never shown in mobile settings. The current API dashboard contract is also not bounded for a native list, so this screen makes no credential requests.",
                        locale: locale
                    ),
                    systemImage: "key.horizontal"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCIntegrationsView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.integrations.connections.section", defaultValue: "Connected services", locale: locale)
            ) {
                SettingsWCInformationRow(
                    title: String(localized: "settings.integrations.connections.title", defaultValue: "Connection list not loaded", locale: locale),
                    message: String(
                        localized: "settings.integrations.connections.message",
                        defaultValue: "Mobile settings does not currently request company OAuth grants, so it cannot confirm which services are connected.",
                        locale: locale
                    ),
                    systemImage: "puzzlepiece.extension"
                )
            }

            Section {
                SettingsWCBrowserAuthorizationRow(
                    provider: "Google",
                    systemImage: "g.circle",
                    locale: locale
                )
                SettingsWCBrowserAuthorizationRow(
                    provider: "Microsoft",
                    systemImage: "m.circle",
                    locale: locale
                )
                SettingsWCBrowserAuthorizationRow(
                    provider: "Salesforce",
                    systemImage: "cloud",
                    locale: locale
                )
            } header: {
                Text(
                    String(localized: "settings.integrations.oauth.section", defaultValue: "Browser authorisation", locale: locale)
                )
            } footer: {
                Text(
                    String(
                        localized: "settings.integrations.oauth.footer",
                        defaultValue: "New connections require a secure browser authorisation flow that is not available in the app yet.",
                        locale: locale
                    )
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCSalesforceView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.salesforce.addon.section", defaultValue: "Salesforce add-on", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.salesforce.entitlement", defaultValue: "Entitlement", locale: locale),
                    value: String(localized: "settings.common.active", defaultValue: "Active", locale: locale),
                    systemImage: "cloud"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.salesforce.connection", defaultValue: "Connection", locale: locale),
                    value: String(localized: "settings.common.not_loaded", defaultValue: "Not loaded", locale: locale),
                    systemImage: "link"
                )
            }

            Section(
                String(localized: "settings.salesforce.connection.section", defaultValue: "Connection setup", locale: locale)
            ) {
                SettingsWCInformationRow(
                    title: String(localized: "settings.salesforce.connection.title", defaultValue: "Secure browser sign-in required", locale: locale),
                    message: String(
                        localized: "settings.salesforce.connection.message",
                        defaultValue: "Connecting Salesforce uses browser OAuth and a signed callback that are not available in the app yet. No connection or automation setting is changed here.",
                        locale: locale
                    ),
                    systemImage: "arrow.up.forward.app"
                )
            }
        }
        .formStyle(.grouped)
    }
}

private struct SettingsWCBrowserAuthorizationRow: View {
    let provider: String
    let systemImage: String
    let locale: Locale

    var body: some View {
        SettingsWCValueRow(
            label: provider,
            value: String(
                localized: "settings.integration.browser_required",
                defaultValue: "Browser sign-in required",
                locale: locale
            ),
            systemImage: systemImage
        )
    }
}

private struct SettingsWCActiveAddonsSection: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Section(
            String(localized: "settings.addons.active.section", defaultValue: "Active add-ons", locale: locale)
        ) {
            if catalog.entitlements.activeAddonCodes.isEmpty {
                SettingsWCInformationRow(
                    title: String(localized: "settings.addons.active.empty", defaultValue: "No active add-ons reported", locale: locale),
                    message: String(
                        localized: "settings.addons.active.empty_message",
                        defaultValue: "The mobile catalog did not report an active add-on for this company.",
                        locale: locale
                    ),
                    systemImage: "puzzlepiece.extension"
                )
            } else {
                ForEach(catalog.entitlements.activeAddonCodes.sorted(), id: \.self) { code in
                    SettingsWCValueRow(
                        label: String(localized: "settings.addons.active.item", defaultValue: "Add-on", locale: locale),
                        value: code
                            .replacingOccurrences(of: "_", with: " ")
                            .replacingOccurrences(of: "-", with: " ")
                            .split(separator: " ")
                            .map { $0.capitalized }
                            .joined(separator: " "),
                        systemImage: "checkmark.circle"
                    )
                }
            }
        }
    }
}
