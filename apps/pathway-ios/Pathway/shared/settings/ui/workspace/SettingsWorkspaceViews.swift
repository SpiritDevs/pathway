import SwiftUI

struct SettingsWCCompanyView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section {
                SettingsWCValueRow(
                    label: String(localized: "settings.company.name", defaultValue: "Company", locale: locale),
                    value: catalog.workspace.companyName,
                    systemImage: "building.2"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.company.status", defaultValue: "Account status", locale: locale),
                    value: SettingsWCWorkspaceFormatting.accountStatus(catalog.workspace.accountStatus, locale: locale),
                    systemImage: "checkmark.seal"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.company.storage", defaultValue: "Storage location", locale: locale),
                    value: SettingsWCWorkspaceFormatting.storageLocation(catalog.workspace.storageLocation, locale: locale),
                    systemImage: "externaldrive"
                )
            } header: {
                Text(
                    String(
                        localized: "settings.company.workspace.section",
                        defaultValue: "Workspace",
                        locale: locale
                    )
                )
            } footer: {
                Text(
                    String(
                        localized: "settings.company.workspace.footer",
                        defaultValue: "These details identify the workspace currently active on this device.",
                        locale: locale
                    )
                )
            }

            Section(
                String(
                    localized: "settings.company.access.section",
                    defaultValue: "Your access",
                    locale: locale
                )
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.company.scope", defaultValue: "Management scope", locale: locale),
                    value: SettingsWCWorkspaceFormatting.scope(catalog.workspace.effectiveCompanyScope, locale: locale),
                    systemImage: "scope"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.company.roles", defaultValue: "Roles", locale: locale),
                    value: SettingsWCWorkspaceFormatting.roles(catalog.roleNames, locale: locale),
                    systemImage: "person.badge.key"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.company.owner", defaultValue: "Company owner", locale: locale),
                    value: SettingsWCWorkspaceFormatting.yesNo(catalog.workspace.isOwner, locale: locale),
                    systemImage: "person.crop.circle.badge.checkmark"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.company.admin", defaultValue: "Organisation admin", locale: locale),
                    value: SettingsWCWorkspaceFormatting.yesNo(catalog.workspace.isOrganizationAdmin, locale: locale),
                    systemImage: "checkmark.shield"
                )
            }

            Section(
                String(
                    localized: "settings.company.editing.section",
                    defaultValue: "Company settings",
                    locale: locale
                )
            ) {
                SettingsWCInformationRow(
                    title: String(
                        localized: "settings.company.editing.title",
                        defaultValue: "Details shown safely",
                        locale: locale
                    ),
                    message: catalog.permissions.manageCompanySettings
                        ? String(
                            localized: "settings.company.editing.manager_message",
                            defaultValue: "You can manage this company. Native editing for branding, regional defaults and billing details is not available in this version, so no changes are made from this screen.",
                            locale: locale
                        )
                        : String(
                            localized: "settings.company.editing.viewer_message",
                            defaultValue: "Your current access lets you view these company details but not change them.",
                            locale: locale
                        ),
                    systemImage: "info.circle"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCSecurityView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.security.access.section", defaultValue: "Security access", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.security.permission", defaultValue: "Company security", locale: locale),
                    value: catalog.permissions.manageSecurityAndSessions
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "lock.shield"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.security.scope", defaultValue: "Scope", locale: locale),
                    value: SettingsWCWorkspaceFormatting.scope(catalog.workspace.effectiveCompanyScope, locale: locale),
                    systemImage: "scope"
                )
            }

            Section(
                String(localized: "settings.security.sessions.section", defaultValue: "Policies and sessions", locale: locale)
            ) {
                SettingsWCInformationRow(
                    title: String(localized: "settings.security.sessions.title", defaultValue: "Protected controls", locale: locale),
                    message: String(
                        localized: "settings.security.sessions.message",
                        defaultValue: "Company sign-in policies, login history and session revocation are not loaded in the app yet. This screen does not change or revoke any session.",
                        locale: locale
                    ),
                    systemImage: "person.badge.shield.checkmark"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCUsersView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.users.access.section", defaultValue: "Member access", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.users.management", defaultValue: "User management", locale: locale),
                    value: catalog.permissions.manageUserAccounts
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "person.2"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.users.scope", defaultValue: "Visible members", locale: locale),
                    value: catalog.permissions.restrictUserManageToTeam
                        ? String(localized: "settings.users.scope.team", defaultValue: "Primary team", locale: locale)
                        : String(localized: "settings.users.scope.company", defaultValue: "Entire company", locale: locale),
                    systemImage: "person.2.crop.square.stack"
                )
            }

            Section(
                String(localized: "settings.users.members.section", defaultValue: "Members", locale: locale)
            ) {
                SettingsWCInformationRow(
                    title: String(localized: "settings.users.members.title", defaultValue: "Member list not loaded", locale: locale),
                    message: String(
                        localized: "settings.users.members.message",
                        defaultValue: "The mobile settings catalog confirms your access without downloading the company directory. No user records are changed from this screen.",
                        locale: locale
                    ),
                    systemImage: "person.crop.circle.badge.questionmark"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCTeamsView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.teams.structure.section", defaultValue: "Company structure", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.teams.mode", defaultValue: "Team mode", locale: locale),
                    value: catalog.workspace.treatTeamsAsCompanies
                        ? String(localized: "settings.teams.mode.companies", defaultValue: "Teams act as companies", locale: locale)
                        : String(localized: "settings.teams.mode.standard", defaultValue: "Standard teams", locale: locale),
                    systemImage: "person.3"
                )
                SettingsWCValueRow(
                    label: String(localized: "settings.teams.management", defaultValue: "Team management", locale: locale),
                    value: catalog.permissions.manageTeams
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "person.3.sequence"
                )
                if catalog.workspace.primaryTeamId != nil {
                    SettingsWCValueRow(
                        label: String(localized: "settings.teams.primary", defaultValue: "Primary team", locale: locale),
                        value: String(localized: "settings.teams.primary.assigned", defaultValue: "Assigned", locale: locale),
                        systemImage: "checkmark.circle"
                    )
                }
            }

            Section(
                String(localized: "settings.teams.directory.section", defaultValue: "Teams", locale: locale)
            ) {
                SettingsWCInformationRow(
                    title: String(localized: "settings.teams.directory.title", defaultValue: "Team directory not loaded", locale: locale),
                    message: String(
                        localized: "settings.teams.directory.message",
                        defaultValue: "Team membership and editing are not available in the app yet. This view only reports the active company structure.",
                        locale: locale
                    ),
                    systemImage: "person.3.fill"
                )
            }
        }
        .formStyle(.grouped)
    }
}

struct SettingsWCRolesView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale

    var body: some View {
        Form {
            Section(
                String(localized: "settings.roles.yours.section", defaultValue: "Your roles", locale: locale)
            ) {
                if catalog.roleNames.isEmpty {
                    SettingsWCInformationRow(
                        title: String(localized: "settings.roles.yours.empty", defaultValue: "No named role", locale: locale),
                        message: String(
                            localized: "settings.roles.yours.empty_message",
                            defaultValue: "Your access is provided by the company membership defaults.",
                            locale: locale
                        ),
                        systemImage: "person.badge.key"
                    )
                } else {
                    ForEach(catalog.roleNames, id: \.self) { role in
                        SettingsWCValueRow(
                            label: String(localized: "settings.roles.role", defaultValue: "Role", locale: locale),
                            value: role,
                            systemImage: "checkmark.shield"
                        )
                    }
                }
            }

            Section(
                String(localized: "settings.roles.management.section", defaultValue: "Role management", locale: locale)
            ) {
                SettingsWCValueRow(
                    label: String(localized: "settings.roles.management.access", defaultValue: "Permission", locale: locale),
                    value: catalog.permissions.manageRoles
                        ? String(localized: "settings.common.authorized", defaultValue: "Authorised", locale: locale)
                        : String(localized: "settings.common.read_only", defaultValue: "Read only", locale: locale),
                    systemImage: "person.badge.key"
                )
                SettingsWCInformationRow(
                    title: String(localized: "settings.roles.management.title", defaultValue: "Permission details not loaded", locale: locale),
                    message: String(
                        localized: "settings.roles.management.message",
                        defaultValue: "The app does not download or edit the company role matrix from this screen.",
                        locale: locale
                    ),
                    systemImage: "list.bullet.clipboard"
                )
            }
        }
        .formStyle(.grouped)
    }
}

enum SettingsWCWorkspaceFormatting {
    static func yesNo(_ value: Bool, locale: Locale) -> String {
        value
            ? String(localized: "settings.common.yes", defaultValue: "Yes", locale: locale)
            : String(localized: "settings.common.no", defaultValue: "No", locale: locale)
    }

    static func roles(_ roleNames: [String], locale: Locale) -> String {
        roleNames.isEmpty
            ? String(localized: "settings.company.roles.default", defaultValue: "Standard member", locale: locale)
            : roleNames.joined(separator: ", ")
    }

    static func accountStatus(
        _ status: MobileSettingsCatalog.AccountStatus,
        locale: Locale
    ) -> String {
        switch status {
        case .active:
            String(localized: "settings.account_status.active", defaultValue: "Active", locale: locale)
        case .paymentDue:
            String(localized: "settings.account_status.payment_due", defaultValue: "Payment due", locale: locale)
        case .paused:
            String(localized: "settings.account_status.paused", defaultValue: "Paused", locale: locale)
        case .suspended:
            String(localized: "settings.account_status.suspended", defaultValue: "Suspended", locale: locale)
        case .cancelled:
            String(localized: "settings.account_status.cancelled", defaultValue: "Cancelled", locale: locale)
        }
    }

    static func scope(
        _ scope: MobileSettingsCatalog.EffectiveCompanyScope,
        locale: Locale
    ) -> String {
        switch scope {
        case .organization:
            String(localized: "settings.scope.organization", defaultValue: "Entire organisation", locale: locale)
        case .team:
            String(localized: "settings.scope.team", defaultValue: "Primary team", locale: locale)
        case .blocked:
            String(localized: "settings.scope.blocked", defaultValue: "Blocked", locale: locale)
        }
    }

    static func storageLocation(_ value: String, locale: Locale) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return String(localized: "settings.company.storage.default", defaultValue: "Company default", locale: locale)
        }
        return trimmed
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}
