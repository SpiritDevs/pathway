#if DEBUG
    import Foundation

    @MainActor
    final class SettingsPreviewBillingService: SettingsBillingServicing {
        func loadBilling() async throws -> SettingsBillingSnapshot? {
            SettingsPreviewFixtures.billing
        }

        func loadInvoices() async throws -> [SettingsBillingInvoice] {
            SettingsPreviewFixtures.invoices
        }

        func loadPauseState() async throws -> SettingsAccountPauseState? {
            SettingsPreviewFixtures.pauseState
        }

        func loadAddons() async throws -> SettingsAddonSnapshot {
            SettingsPreviewFixtures.addonSnapshot
        }

        func loadInstalledAddons(locale _: String?) async throws -> [SettingsMarketplaceAddon] {
            SettingsPreviewFixtures.installedAddons
        }

        func unsubscribeAddon(
            code _: String,
            planVersionID _: String?
        ) async throws -> SettingsAddonChangeResult {
            SettingsAddonChangeResult(success: true, id: "preview-change")
        }

        func requestCompanyCancellation(
            reason _: String?,
            details _: String?
        ) async throws -> SettingsCompanyCancellationResult {
            SettingsCompanyCancellationResult(hasAnotherSelectableCompany: true, success: true)
        }
    }

    @MainActor
    final class SettingsPreviewProfileService: SettingsProfileServicing {
        func loadProfile(now _: Date) async throws -> SettingsProfileSnapshot? {
            SettingsPreviewFixtures.profile
        }

        func updateName(firstName _: String, lastName _: String) async throws {}
        func updateContact(_: SettingsProfileContactField, value _: String) async throws {}
        func updateLocale(_: String) async throws {}
        func updateTimezone(_: String) async throws {}
        func updateDateFormat(_: String) async throws {}
        func updateWorkingStatus(_: String) async throws {}
        func updateActivityIndicator(disabled _: Bool) async throws {}
        func updateMagicLinkEmail(enabled _: Bool) async throws {}
        func updateNotificationPreference(_: SettingsNotificationPreferenceUpdate) async throws {}

        func switchCompany(companyID _: String?) async throws -> SettingsCompanySwitchResult {
            SettingsCompanySwitchResult(success: true, redirect: nil)
        }

        func listSessions(now _: Date) async throws -> SettingsSessionList {
            SettingsSessionList(sessions: [])
        }

        func listPasskeys() async throws -> SettingsPasskeyList {
            SettingsPasskeyList(passkeys: [])
        }
    }

    @MainActor
    final class SettingsPreviewSupportService: SettingsSupportServicing {
        func loadConversations(
            userID _: String,
            now _: Date,
            limit _: Int
        ) async throws -> [SettingsSupportConversation] {
            SettingsPreviewFixtures.conversations
        }

        func observeMessages(
            conversationID _: String,
            now _: Date,
            receiveValue: @MainActor @escaping ([SettingsSupportMessage]) -> Void
        ) async throws {
            receiveValue(SettingsPreviewFixtures.messages)
        }

        func startConversation(
            userID _: String,
            companyID _: String,
            message _: String
        ) async throws -> String {
            "preview-conversation"
        }

        func sendMessage(
            conversationID _: String,
            userID _: String,
            content _: String
        ) async throws -> String {
            "preview-message"
        }

        func markRead(
            conversationID _: String,
            userID _: String,
            messageIDs _: [String]
        ) async throws {}

        func loadTickets(
            userID _: String,
            companyID _: String,
            limit _: Int
        ) async throws -> [SettingsSupportTicket] {
            SettingsPreviewFixtures.tickets
        }

        func loadNews(
            now _: Date,
            category _: String?,
            limit _: Int
        ) async throws -> [SettingsNewsPost] {
            SettingsPreviewFixtures.news
        }

        func searchNews(
            _: String,
            now _: Date,
            limit _: Int
        ) async throws -> [SettingsNewsPost] {
            SettingsPreviewFixtures.news
        }
    }
#endif
