import Foundation

/// Existing server contracts for settings destinations that have not yet received a dedicated
/// Swift service. Keeping these names centralized prevents view code from inventing routes.
enum SettingsEndpointCatalog {
    enum Company {
        static let bootstrap = "functions/settings/companySettings:getCompanySettingsBootstrap"
        static let updateRegionalSetting =
            "functions/settings/companySettings:updateRegionalSetting"
        static let updatePreference = "functions/settings/companySettings:updatePreference"
        static let updateBrandingFlags = "functions/settings/companySettings:updateBrandingFlags"
        static let updateBillingInfo = "functions/settings/companySettings:updateBillingInfo"
    }

    enum Security {
        static let bootstrap = "functions/settings/security:getSecurityBootstrap"
        static let sessions = "functions/settings/security:listCompanySessions"
        static let loginAudit = "functions/settings/security:listLoginAudit"
        static let updatePolicies = "functions/settings/security:updateSecurityPolicies"
        static let revokeSession = "functions/settings/security:revokeCompanySession"
    }

    enum Users {
        static let bootstrap = "functions/settings/users:getUsersSettingsBootstrap"
        static let list = "functions/settings/users:listCompanyUsersTable"
        static let modal = "functions/settings/users:getCompanyUserModalData"
        static let save = "functions/settings/users:saveCompanyUser"
        static let delete = "functions/settings/users:deleteCompanyUsers"
    }

    enum Teams {
        static let bootstrap = "functions/settings/teams:getTeamsSettingsBootstrap"
        static let list = "functions/settings/teams:listCompanyTeamsTable"
        static let members = "functions/settings/teams:getTeamUsers"
        static let save = "functions/settings/teams:saveCompanyTeam"
        static let delete = "functions/settings/teams:deleteCompanyTeams"
    }

    enum Roles {
        static let bootstrap = "functions/settings/roles:getRolesSettingsBootstrap"
        static let list = "functions/settings/roles:listCompanyRolesTable"
        static let save = "functions/settings/roles:saveCompanyRole"
        static let delete = "functions/settings/roles:deleteCompanyRoles"
    }

    enum Fonts {
        static let list = "functions/settings/fontBook:listCompanyFonts"
        static let rename = "functions/settings/fontBook:renameFont"
        static let upload = "functions/settings/fontBookActions:uploadFont"
        static let delete = "functions/settings/fontBookActions:deleteFont"
    }

    enum EmailTemplates {
        static let bootstrap = "functions/settings/emailTemplates:getEmailTemplatesBootstrap"
        static let save = "functions/settings/emailTemplateActions:saveEmailTemplate"
        static let quickUpdate = "functions/settings/emailTemplates:quickUpdateEmailTemplate"
        static let delete = "functions/settings/emailTemplateActions:deleteEmailTemplate"
    }

    enum EmailSetup {
        static let bootstrap = "functions/settings/userEmail:getUserEmailSettingsBootstrap"
        static let list = "functions/settings/userEmail:listUserEmailSettingsTable"
        static let updateSender = "functions/settings/userEmail:updateEmailSender"
        static let delete = "functions/settings/userEmail:deleteEmailServices"
    }

    enum DeliveryRules {
        static let bootstrap = "functions/documents/delivery:getDeliveryRuleBuilderBootstrap"
        static let list = "functions/documents/delivery:listDeliveryRules"
        static let save = "functions/documents/delivery:saveDeliveryRule"
        static let delete = "functions/documents/delivery:deleteDeliveryRule"
    }

    enum CustomData {
        static let bootstrap = "functions/settings/dataItems:getCustomDataItemsBootstrap"
        static let save = "functions/settings/dataItems:saveCustomDataItems"
    }

    enum API {
        static let dashboard = "functions/settings/apiDashboard:getApiDashboardData"
        static let createWebhook = "functions/settings/apiDashboard:createWebhook"
        static let updateWebhook = "functions/settings/apiDashboard:updateWebhook"
        static let deleteWebhook = "functions/settings/apiDashboard:deleteWebhook"
        static let generateTestToken = "functions/settings/apiDashboard:generateTestToken"
        static let revokeTestToken = "functions/settings/apiDashboard:revokeTestToken"
    }

    enum Integrations {
        static let grants = "functions/settings/integrations:listCompanyGrants"
        static let revokeGrant = "functions/settings/integrations:revokeCompanyGrant"
        static let revokeService = "functions/settings/integrations:revokeCompanyServiceGrants"
    }

    enum Salesforce {
        /// Authenticated detail contract. Native connect/disconnect is intentionally absent until
        /// Salesforce OAuth has a signed ASWebAuthenticationSession callback contract.
        static let detail = "functions/addons:getAddonDetail"
        static let updateOpportunityAutomation =
            "functions/addons:updateSalesforceOpportunityAutomationConfig"
        static let updateDefaultDataSync =
            "functions/addons:updateSalesforceDefaultDataSyncConfig"
        static let updateConnectedAppCredentials =
            "functions/addonsActions:updateSalesforceConnectedAppCredentials"
    }
}
