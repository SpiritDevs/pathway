import Foundation

/// Stable, app-owned routes for the native settings navigation stack.
///
/// Workflows intentionally has no route until it receives a dedicated mobile
/// interaction design. Unknown backend destination IDs are ignored by mapping.
enum SettingsRoute: String, CaseIterable, Hashable, Identifiable, Sendable {
    case profile
    case device
    case company
    case security
    case users
    case teams
    case roles
    case fonts
    case emailTemplates = "email_templates"
    case billing
    case addons
    case salesforce
    case emailSetup = "email_setup"
    case deliveryRules = "delivery_rules"
    case customDataItems = "custom_data_items"
    case api
    case integrations
    case support
    case about
    case dataRetention = "data_retention"
    case logout

    var id: String { rawValue }

    init?(destination: MobileSettingsCatalog.Destination) {
        self.init(rawValue: destination.id)
    }

    func localizedTitle(locale: Locale) -> String {
        switch self {
        case .profile: String(localized: "settings.route.profile.title", defaultValue: "My Profile", locale: locale)
        case .device: String(localized: "settings.route.device.title", defaultValue: "Device Settings", locale: locale)
        case .company: String(localized: "settings.route.company.title", defaultValue: "Company", locale: locale)
        case .security: String(localized: "settings.route.security.title", defaultValue: "Security", locale: locale)
        case .users: String(localized: "settings.route.users.title", defaultValue: "Users", locale: locale)
        case .teams: String(localized: "settings.route.teams.title", defaultValue: "Teams", locale: locale)
        case .roles: String(localized: "settings.route.roles.title", defaultValue: "Roles", locale: locale)
        case .fonts: String(localized: "settings.route.fonts.title", defaultValue: "Fonts", locale: locale)
        case .emailTemplates: String(localized: "settings.route.email_templates.title", defaultValue: "Email Templates", locale: locale)
        case .billing: String(localized: "settings.route.billing.title", defaultValue: "Billing", locale: locale)
        case .addons: String(localized: "settings.route.addons.title", defaultValue: "Add-ons", locale: locale)
        case .salesforce: String(localized: "settings.route.salesforce.title", defaultValue: "Salesforce", locale: locale)
        case .emailSetup: String(localized: "settings.route.email_setup.title", defaultValue: "Email Setup", locale: locale)
        case .deliveryRules: String(localized: "settings.route.delivery_rules.title", defaultValue: "Delivery Rules", locale: locale)
        case .customDataItems: String(localized: "settings.route.custom_data_items.title", defaultValue: "Custom Data Items", locale: locale)
        case .api: String(localized: "settings.route.api.title", defaultValue: "API Credentials", locale: locale)
        case .integrations: String(localized: "settings.route.integrations.title", defaultValue: "Integrations", locale: locale)
        case .support: String(localized: "settings.route.support.title", defaultValue: "Support", locale: locale)
        case .about: String(localized: "settings.route.about.title", defaultValue: "About", locale: locale)
        case .dataRetention: String(localized: "settings.route.data_retention.title", defaultValue: "Data Retention", locale: locale)
        case .logout: String(localized: "settings.route.logout.title", defaultValue: "Log Out", locale: locale)
        }
    }

    func localizedSearchKeywords(locale: Locale) -> [String] {
        let value = switch self {
        case .profile:
            String(localized: "settings.route.profile.keywords", defaultValue: "account;avatar;contact;signature;schedule;passkeys;sessions", locale: locale)
        case .device:
            String(localized: "settings.route.device.keywords", defaultValue: "appearance;language;notifications;biometrics;accessibility", locale: locale)
        case .company:
            String(localized: "settings.route.company.keywords", defaultValue: "workspace;branding;logo;details", locale: locale)
        case .security:
            String(localized: "settings.route.security.keywords", defaultValue: "company security;sessions;authentication", locale: locale)
        case .users:
            String(localized: "settings.route.users.keywords", defaultValue: "members;people;accounts", locale: locale)
        case .teams:
            String(localized: "settings.route.teams.keywords", defaultValue: "groups;members", locale: locale)
        case .roles:
            String(localized: "settings.route.roles.keywords", defaultValue: "permissions;access", locale: locale)
        case .fonts:
            String(localized: "settings.route.fonts.keywords", defaultValue: "font book;typeface;typography", locale: locale)
        case .emailTemplates:
            String(localized: "settings.route.email_templates.keywords", defaultValue: "mail;message templates", locale: locale)
        case .billing:
            String(localized: "settings.route.billing.keywords", defaultValue: "plan;usage;invoice;payment method", locale: locale)
        case .addons:
            String(localized: "settings.route.addons.keywords", defaultValue: "add ons;features;subscription", locale: locale)
        case .salesforce:
            String(localized: "settings.route.salesforce.keywords", defaultValue: "crm;integration", locale: locale)
        case .emailSetup:
            String(localized: "settings.route.email_setup.keywords", defaultValue: "sender;smtp;mail", locale: locale)
        case .deliveryRules:
            String(localized: "settings.route.delivery_rules.keywords", defaultValue: "scheduled send;rules;delivery", locale: locale)
        case .customDataItems:
            String(localized: "settings.route.custom_data_items.keywords", defaultValue: "fields;data items;custom data", locale: locale)
        case .api:
            String(localized: "settings.route.api.keywords", defaultValue: "developer;credentials;keys;tokens", locale: locale)
        case .integrations:
            String(localized: "settings.route.integrations.keywords", defaultValue: "connections;apps;oauth", locale: locale)
        case .support:
            String(localized: "settings.route.support.keywords", defaultValue: "help;chat;tickets;guides;feature requests", locale: locale)
        case .about:
            String(localized: "settings.route.about.keywords", defaultValue: "what's new;terms;privacy;version;build;status", locale: locale)
        case .dataRetention:
            String(localized: "settings.route.data_retention.keywords", defaultValue: "close account;close company;cancel;retention", locale: locale)
        case .logout:
            String(localized: "settings.route.logout.keywords", defaultValue: "sign out;session", locale: locale)
        }
        return value.split(separator: ";").map(String.init)
    }
}
