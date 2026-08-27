import Foundation

extension SettingsRoute {
    var settingsSymbolName: String {
        switch self {
        case .profile: "person.crop.circle"
        case .device: "iphone"
        case .company: "building.2"
        case .security: "lock.shield"
        case .users: "person.2"
        case .teams: "person.3"
        case .roles: "person.badge.key"
        case .fonts: "textformat"
        case .emailTemplates: "envelope.badge"
        case .billing: "creditcard"
        case .addons: "puzzlepiece.extension"
        case .salesforce: "cloud"
        case .emailSetup: "envelope.badge.shield.half.filled"
        case .deliveryRules: "paperplane"
        case .customDataItems: "list.bullet.rectangle"
        case .api: "chevron.left.forwardslash.chevron.right"
        case .integrations: "app.connected.to.app.below.fill"
        case .support: "questionmark.circle"
        case .about: "info.circle"
        case .dataRetention: "clock.arrow.circlepath"
        case .logout: "rectangle.portrait.and.arrow.right"
        }
    }

    func settingsSubtitle(locale: Locale) -> String? {
        switch self {
        case .profile:
            nil
        case .device:
            String(localized: "settings.route.device.subtitle", defaultValue: "Appearance, language, notifications, and device security", locale: locale)
        case .company:
            String(localized: "settings.route.company.subtitle", defaultValue: "Company details, branding, and defaults", locale: locale)
        case .security:
            String(localized: "settings.route.security.subtitle", defaultValue: "Authentication and active sessions", locale: locale)
        case .users:
            String(localized: "settings.route.users.subtitle", defaultValue: "Manage people in your workspace", locale: locale)
        case .teams:
            String(localized: "settings.route.teams.subtitle", defaultValue: "Organise members into teams", locale: locale)
        case .roles:
            String(localized: "settings.route.roles.subtitle", defaultValue: "Roles and access permissions", locale: locale)
        case .fonts:
            String(localized: "settings.route.fonts.subtitle", defaultValue: "Fonts available in documents", locale: locale)
        case .emailTemplates:
            String(localized: "settings.route.email_templates.subtitle", defaultValue: "Reusable email content", locale: locale)
        case .billing:
            String(localized: "settings.route.billing.subtitle", defaultValue: "Plan, usage, and payment details", locale: locale)
        case .addons:
            String(localized: "settings.route.addons.subtitle", defaultValue: "Manage enabled Pathway add-ons", locale: locale)
        case .salesforce:
            String(localized: "settings.route.salesforce.subtitle", defaultValue: "Salesforce connection settings", locale: locale)
        case .emailSetup:
            String(localized: "settings.route.email_setup.subtitle", defaultValue: "Sending domains and email providers", locale: locale)
        case .deliveryRules:
            String(localized: "settings.route.delivery_rules.subtitle", defaultValue: "Rules for sending documents", locale: locale)
        case .customDataItems:
            String(localized: "settings.route.custom_data_items.subtitle", defaultValue: "Reusable fields and company data", locale: locale)
        case .api:
            String(localized: "settings.route.api.subtitle", defaultValue: "Developer credentials and API access", locale: locale)
        case .integrations:
            String(localized: "settings.route.integrations.subtitle", defaultValue: "Connected apps and services", locale: locale)
        case .support:
            String(localized: "settings.route.support.subtitle", defaultValue: "Help, chat, guides, and requests", locale: locale)
        case .about:
            String(localized: "settings.route.about.subtitle", defaultValue: "What's new, legal, status, and app details", locale: locale)
        case .dataRetention:
            String(localized: "settings.route.data_retention.subtitle", defaultValue: "Data lifecycle and company closure", locale: locale)
        case .logout:
            nil
        }
    }
}

extension MobileSettingsCatalog.Section {
    func settingsTitle(locale: Locale) -> String {
        switch self {
        case .personal:
            String(localized: "settings.section.personal", defaultValue: "Personal", locale: locale)
        case .workspace:
            String(localized: "settings.section.workspace", defaultValue: "Company & Access", locale: locale)
        case .contentAndDelivery:
            String(localized: "settings.section.content_and_delivery", defaultValue: "Content & Delivery", locale: locale)
        case .billingAndAddons:
            String(localized: "settings.section.billing_and_addons", defaultValue: "Billing & Add-ons", locale: locale)
        case .advanced:
            String(localized: "settings.section.advanced", defaultValue: "Advanced", locale: locale)
        case .supportAndAbout:
            String(localized: "settings.section.support_and_about", defaultValue: "Support & About", locale: locale)
        case .dataAndSession:
            String(localized: "settings.section.data_and_session", defaultValue: "Data & Session", locale: locale)
        }
    }
}

extension MobileSettingsCatalog.Availability {
    var isLocked: Bool {
        if case .addonRequired = self { return true }
        return false
    }

    var requiredAddonCode: String? {
        guard case let .addonRequired(code) = self else { return nil }
        return code
    }
}
