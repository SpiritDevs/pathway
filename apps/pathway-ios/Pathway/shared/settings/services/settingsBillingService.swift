@preconcurrency import ConvexMobile
import Foundation

struct SettingsBillingSnapshot: Decodable, Equatable, Sendable {
    let companyData: Company
    let plan: Plan
    let permissions: Permissions
    let subscriptionDetails: [SubscriptionDetail]
    let usersTotal: UserTotal

    struct Company: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let accountStatus: String
        let subscriptionPlan: String
        let hasActivePaymentMethod: Bool
        let hasPaidBillingHistory: Bool
        let storageLocation: String
        let details: Details

        struct Details: Decodable, Equatable, Sendable {
            let phone: String
            let abnacn: String
            let billingEmails: [String]
            let trialExpiryDate: Double?
            let nextTrialReminderAt: Double?
        }
    }

    struct Plan: Decodable, Equatable, Sendable {
        let billingStatus: String?
        let currencyCode: String?
        let currencySymbol: String?
        let nextInvoiceDate: Double?
        let plan: String
        let planId: String?
        let planInterval: String?
        let planName: String
    }

    struct Permissions: Decodable, Equatable, Sendable {
        let manageSubscriptions: Bool
        let manageBillingConfiguration: Bool
    }

    struct SubscriptionDetail: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let planType: String
        let subType: String?
        let planCode: String?
        let description: String?
        let qty: Double
        let price: Double
        let currency: String?
    }

    struct UserTotal: Decodable, Equatable, Sendable {
        let total: Double
    }
}

struct SettingsBillingInvoice: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let invoiceNumber: String
    let billingMonthKey: String
    let currencyCode: String
    let amountDueMinorUnits: Double
    let subtotalMinorUnits: Double
    let taxMinorUnits: Double
    let totalMinorUnits: Double
    let status: String
    let dueAt: Double?
    let issuedAt: Double?
    let paidAt: Double?
}

struct SettingsAccountPauseState: Decodable, Equatable, Sendable {
    let canManageSubscriptions: Bool
    let companyName: String
    let nextChargeAt: Double?
    let pauseEndsAt: Double?
    let pausePendingAt: Double?
    let pausedAt: Double?
    let previewPauseEndsAt: Double?
    let previewPauseMonths: Double
    let previewPausePendingAt: Double?
    let status: String
}

struct SettingsCompanyCancellationResult: Decodable, Equatable, Sendable {
    let hasAnotherSelectableCompany: Bool
    let success: Bool
}

struct SettingsAddonSnapshot: Decodable, Equatable, Sendable {
    let availableAddonPlans: [Plan]
    let company: Company
    let subscriptions: [Subscription]
    let currentPlan: CurrentPlan

    struct Plan: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let addonCode: String
        let name: String
        let priceMinorUnits: Double
        let currencyCode: String
        let currencySymbol: String
        let description: String?
        let icon: String?
        let tierLabel: String
        let tierDescription: String?
        let customerFacingHighlights: [String]
    }

    struct Company: Decodable, Equatable, Sendable {
        let subscriptionPlan: String
        let trialExpiresAt: Double?
    }

    struct Subscription: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let addon: String
        let planId: String?
        let status: String
        let effectiveDate: Double?
        let tierLabel: String?
        let pendingChange: PendingChange?

        struct PendingChange: Decodable, Equatable, Sendable {
            let action: String
            let effectiveAt: Double?
            let planVersionId: String?
            let tierLabel: String?
        }
    }

    struct CurrentPlan: Decodable, Equatable, Sendable {
        let planId: String?
        let plan: String
        let planName: String
        let nextInvoiceDate: Double?
    }
}

struct SettingsMarketplaceAddon: Decodable, Equatable, Identifiable, Sendable {
    private let databaseID: String?
    let addonCode: String
    let name: String
    let subtitle: String
    let developer: String
    let categoryKey: String
    let categoryName: String
    let iconMode: String
    let iconKey: String?
    let iconUrl: String?
    let priceLabel: String
    let subscribed: Bool
    let suspended: Bool
    let included: Bool
    let tierCount: Double
    let currentTierLabel: String?
    let sortOrder: Double

    var id: String { databaseID ?? addonCode }

    private enum CodingKeys: String, CodingKey {
        case databaseID = "id"
        case addonCode
        case name
        case subtitle
        case developer
        case categoryKey
        case categoryName
        case iconMode
        case iconKey
        case iconUrl
        case priceLabel
        case subscribed
        case suspended
        case included
        case tierCount
        case currentTierLabel
        case sortOrder
    }
}

struct SettingsAddonChangeResult: Decodable, Equatable, Sendable {
    let success: Bool
    let id: String?
}

@MainActor
protocol SettingsBillingServicing: AnyObject {
    func loadBilling() async throws -> SettingsBillingSnapshot?
    func loadInvoices() async throws -> [SettingsBillingInvoice]
    func loadPauseState() async throws -> SettingsAccountPauseState?
    func loadAddons() async throws -> SettingsAddonSnapshot
    func loadInstalledAddons(locale: String?) async throws -> [SettingsMarketplaceAddon]
    func unsubscribeAddon(code: String, planVersionID: String?) async throws
        -> SettingsAddonChangeResult
    func requestCompanyCancellation(reason: String?, details: String?) async throws
        -> SettingsCompanyCancellationResult
}

@MainActor
final class SettingsBillingService: SettingsBillingServicing {
    private let transport: any SettingsRemoteTransporting

    init(transport: any SettingsRemoteTransporting) {
        self.transport = transport
    }

    convenience init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.init(transport: SettingsRemoteTransport(convex: convex))
    }

    func loadBilling() async throws -> SettingsBillingSnapshot? {
        try await transport.queryOnce(
            "functions/settings/billing:getBillingDashboardBootstrap",
            arguments: nil
        )
    }

    func loadInvoices() async throws -> [SettingsBillingInvoice] {
        try await transport.queryOnce(
            "functions/settings/billing:getBillingDashboardInvoiceHistory",
            arguments: nil
        )
    }

    func loadPauseState() async throws -> SettingsAccountPauseState? {
        try await transport.queryOnce(
            "functions/settings/billing:getAccountPauseState",
            arguments: nil
        )
    }

    func loadAddons() async throws -> SettingsAddonSnapshot {
        try await transport.queryOnce(
            "functions/addons:getAddonsBootstrap",
            arguments: nil
        )
    }

    func loadInstalledAddons(locale: String? = nil) async throws -> [SettingsMarketplaceAddon] {
        let request = Self.installedAddonsRequest(locale: locale)
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    /// Intentionally exposes only the existing-subscription removal path. The native settings
    /// release does not start trials, subscribe, upgrade, or purchase add-ons.
    func unsubscribeAddon(
        code: String,
        planVersionID: String?
    ) async throws -> SettingsAddonChangeResult {
        let request = Self.unsubscribeRequest(code: code, planVersionID: planVersionID)
        return try await transport.act(request.function, arguments: request.arguments)
    }

    /// The caller must complete device-owner authentication before invoking this sensitive action.
    func requestCompanyCancellation(
        reason: String?,
        details: String?
    ) async throws -> SettingsCompanyCancellationResult {
        let request = Self.cancellationRequest(reason: reason, details: details)
        return try await transport.act(request.function, arguments: request.arguments)
    }

    static func installedAddonsRequest(locale: String?) -> SettingsRemoteRequest {
        var arguments: [String: ConvexEncodable?] = ["filter": "installed"]
        if let locale { arguments["locale"] = locale }
        return SettingsRemoteRequest(
            .query,
            "functions/addons:listMarketplaceAddons",
            arguments: arguments
        )
    }

    static func unsubscribeRequest(
        code: String,
        planVersionID: String?
    ) -> SettingsRemoteRequest {
        var arguments: [String: ConvexEncodable?] = ["addonCode": code]
        if let planVersionID {
            arguments["planVersionId"] = planVersionID
        }
        return SettingsRemoteRequest(
            .action,
            "functions/addonsActions:unsubscribeAddon",
            arguments: arguments
        )
    }

    static func cancellationRequest(reason: String?, details: String?) -> SettingsRemoteRequest {
        var arguments: [String: ConvexEncodable?] = [:]
        if let reason { arguments["reason"] = reason }
        if let details { arguments["reasonDetails"] = details }
        return SettingsRemoteRequest(
            .action,
            "functions/settings/billingActions:cancelAccount",
            arguments: arguments
        )
    }
}
