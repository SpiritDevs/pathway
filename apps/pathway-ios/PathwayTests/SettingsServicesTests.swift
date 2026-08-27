@preconcurrency import ConvexMobile
import Foundation
@testable import Pathway
import Testing

struct SettingsServicesTests {
    @Test func decodesProfileBootstrap() throws {
        let snapshot = try JSONDecoder().decode(
            SettingsProfileSnapshot.self,
            from: Data(Self.profileJSON.utf8)
        )

        #expect(snapshot.user.firstName == "Corey")
        #expect(snapshot.profile.locale == "en")
        #expect(snapshot.company.name == "Pathway")
        #expect(snapshot.companyList.count == 2)
        #expect(
            snapshot.notificationPreferences["communication"]?["support_reply"]?
                .allowSystemNotifications == true
        )
    }

    @Test func decodesBillingAndLifecycleContracts() throws {
        let billing = try JSONDecoder().decode(
            SettingsBillingSnapshot.self,
            from: Data(Self.billingJSON.utf8)
        )
        let pause = try JSONDecoder().decode(
            SettingsAccountPauseState.self,
            from: Data(Self.pauseJSON.utf8)
        )

        #expect(billing.plan.planName == "Business")
        #expect(billing.permissions.manageSubscriptions)
        #expect(billing.companyData.details.billingEmails == ["billing@example.com"])
        #expect(pause.previewPauseMonths == 3)
        #expect(pause.status == "active")
    }

    @Test func decodesSupportAndNewsContracts() throws {
        let message = try JSONDecoder().decode(
            SettingsSupportMessage.self,
            from: Data(Self.messageJSON.utf8)
        )
        let news = try JSONDecoder().decode(
            SettingsNewsPost.self,
            from: Data(Self.newsJSON.utf8)
        )

        #expect(message.id == "message-id")
        #expect(message.ownerType == "admin")
        #expect(news.id == "news-id")
        #expect(news.category == "product")
    }

    @Test @MainActor func requestContractsUseVerifiedFunctionsAndServerValidatorKeys() throws {
        let notification = SettingsProfileService.notificationRequest(
            .init(
                category: .communication,
                notification: "support_reply",
                allowSystemNotifications: true,
                allowEmailNotifications: nil,
                allowSlackNotifications: false
            )
        )
        let unsubscribe = SettingsBillingService.unsubscribeRequest(
            code: "QCFONTBOOK",
            planVersionID: "plan-version-id"
        )
        let legacyUnsubscribe = SettingsBillingService.unsubscribeRequest(
            code: "QCFONTBOOK",
            planVersionID: nil
        )
        let support = SettingsSupportService.startConversationRequest(
            userID: "user-id",
            companyID: "company-id",
            message: "I need help"
        )
        let sessions = SettingsProfileService.sessionsRequest(
            now: Date(timeIntervalSince1970: 1_000)
        )

        #expect(notification.function == "functions/settings/myProfile:updateNotificationPreference")
        #expect(notification.method == .mutation)
        #expect(try Self.encoded("category", in: notification) == #""communication""#)
        #expect(notification.arguments?["allowEmailNotifications"] == nil)

        #expect(unsubscribe.function == "functions/addonsActions:unsubscribeAddon")
        #expect(unsubscribe.method == .action)
        #expect(try Self.encoded("planVersionId", in: unsubscribe) == #""plan-version-id""#)
        #expect(legacyUnsubscribe.arguments?["planVersionId"] == nil)

        #expect(support.function == "conversations:createConversationWithMessage")
        #expect(support.method == .action)
        #expect(try Self.encoded("companyId", in: support) == #""company-id""#)

        #expect(sessions.function == "functions/settings/myProfile:listSessions")
        #expect(sessions.method == .query)
        #expect(Double(try Self.encoded("nowMs", in: sessions)) == 1_000_000)

        #expect(
            SettingsEndpointCatalog.Salesforce.updateOpportunityAutomation ==
                "functions/addons:updateSalesforceOpportunityAutomationConfig"
        )
        #expect(
            SettingsEndpointCatalog.Salesforce.updateConnectedAppCredentials ==
                "functions/addonsActions:updateSalesforceConnectedAppCredentials"
        )
        #expect(
            SettingsEndpointCatalog.Fonts.upload ==
                "functions/settings/fontBookActions:uploadFont"
        )
        #expect(
            SettingsEndpointCatalog.EmailTemplates.delete ==
                "functions/settings/emailTemplateActions:deleteEmailTemplate"
        )
    }

    private static func encoded(_ key: String, in request: SettingsRemoteRequest) throws -> String {
        let arguments = try #require(request.arguments)
        let value = try #require(arguments[key] ?? nil)
        return try value.convexEncode()
    }

    private static let profileJSON = #"""
    {
      "user":{"id":"user-id","email":"corey@example.com","firstName":"Corey","lastName":"Baines","emailVerified":"2026-01-01T00:00:00.000Z","pendingEmail":null,"sendMagicLinkEmail":true},
      "profile":{"profileColor":"blue","birthday":null,"workAnniversary":null,"locale":"en","timezone":"Australia/Sydney","dateFormat":"dd/MM/yyyy","twentyFourHourTime":false,"disabledActivityIndicator":false},
      "company":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2","locale":"en","timezone":"Australia/Sydney","dateFormat":"dd/MM/yyyy"},
      "notificationPreferences":{"communication":{"support_reply":{"allowSystemNotifications":true,"allowEmailNotifications":true,"allowSlackNotifications":false}}},
      "companyList":[{"id":"company-id","name":"Pathway","active":true},{"id":"other-id","name":"Other","active":false}]
    }
    """#

    private static let billingJSON = #"""
    {
      "companyData":{"id":"company-id","name":"Pathway","accountStatus":"active","subscriptionPlan":"business","hasActivePaymentMethod":true,"hasPaidBillingHistory":true,"storageLocation":"ap-southeast-2","details":{"phone":"","abnacn":"","billingEmails":["billing@example.com"],"trialExpiryDate":null,"nextTrialReminderAt":null}},
      "plan":{"billingStatus":"active","currencyCode":"AUD","currencySymbol":"$","nextInvoiceDate":2000,"plan":"business","planId":"plan-id","planInterval":"month","planName":"Business"},
      "permissions":{"manageSubscriptions":true,"manageBillingConfiguration":true},
      "subscriptionDetails":[{"id":"subscription-id","planType":"main","subType":null,"planCode":"business","description":"Business","qty":1,"price":99,"currency":"AUD"}],
      "usersTotal":{"total":5}
    }
    """#

    private static let pauseJSON = #"""
    {"canManageSubscriptions":true,"companyName":"Pathway","nextChargeAt":1000,"pauseEndsAt":null,"pausePendingAt":null,"pausedAt":null,"previewPauseEndsAt":4000,"previewPauseMonths":3,"previewPausePendingAt":1000,"status":"active"}
    """#

    private static let messageJSON = #"""
    {"_id":"message-id","_creationTime":1,"conversationId":"conversation-id","type":"message","ownerId":"admin-id","ownerType":"admin","content":"Hello","attachmentIds":[],"tagIds":[],"createdAt":1,"sentAt":1,"deliveryStatusByUser":{"user-id":"pending"}}
    """#

    private static let newsJSON = #"""
    {"_id":"news-id","_creationTime":1,"title":"New settings","summary":"A summary","contentHtml":"<p>Details</p>","category":"product","publishedAt":1,"isPublished":true,"createdAt":1,"updatedAt":1}
    """#
}
