@preconcurrency import ConvexMobile
import Foundation

struct SettingsSuccess: Decodable, Equatable, Sendable {
    let success: Bool
}

struct SettingsProfileSnapshot: Decodable, Equatable, Sendable {
    let user: User
    let profile: Profile
    let company: Company
    let notificationPreferences: [String: [String: NotificationPreference]]
    let companyList: [CompanyListItem]

    struct User: Decodable, Equatable, Sendable {
        let id: String
        let email: String
        let firstName: String?
        let lastName: String?
        let emailVerified: String?
        let pendingEmail: String?
        let sendMagicLinkEmail: Bool
    }

    struct Profile: Decodable, Equatable, Sendable {
        let profileImage: String?
        let profileColor: String?
        let officePhone: String?
        let phone: String?
        let address: String?
        let whatsapp: String?
        let slack: String?
        let microsoftTeams: String?
        let birthday: String?
        let workAnniversary: String?
        let timezone: String?
        let locale: String?
        let dateFormat: String?
        let workingStatus: String?
        let twentyFourHourTime: Bool
        let firstDayOfWeek: String?
        let disabledActivityIndicator: Bool
    }

    struct Company: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let storageLocation: String
        let locale: String?
        let timezone: String?
        let dateFormat: String?
    }

    struct NotificationPreference: Decodable, Equatable, Sendable {
        let allowSystemNotifications: Bool
        let allowEmailNotifications: Bool
        let allowSlackNotifications: Bool
    }

    struct CompanyListItem: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let name: String
        let active: Bool
    }
}

enum SettingsProfileContactField: String, CaseIterable, Sendable {
    case officePhone
    case phone
    case address
    case whatsapp
    case slack
    case microsoftTeams
}

enum SettingsNotificationCategory: String, CaseIterable, Sendable {
    case communication
    case workflow
    case collaboration
    case system
    case admin
    case digest
}

struct SettingsNotificationPreferenceUpdate: Equatable, Sendable {
    let category: SettingsNotificationCategory
    let notification: String
    let allowSystemNotifications: Bool?
    let allowEmailNotifications: Bool?
    let allowSlackNotifications: Bool?
}

struct SettingsCompanySwitchResult: Decodable, Equatable, Sendable {
    let success: Bool
    let redirect: String?
}

struct SettingsSessionList: Decodable, Equatable, Sendable {
    let sessions: [Session]

    struct Session: Decodable, Equatable, Identifiable, Sendable {
        let sessionId: String
        let createdAt: String
        let lastSeenAt: String
        let expires: String
        let revoked: Bool
        let deviceLabel: String?
        let userAgent: String?
        let ipAddress: String?
        let deviceType: String?
        let browser: String?
        let os: String?
        let isImpersonation: Bool
        let impersonatedByAdminId: String?
        let isCurrent: Bool

        var id: String { sessionId }
    }
}

struct SettingsPasskeyList: Decodable, Equatable, Sendable {
    let passkeys: [Passkey]

    struct Passkey: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let label: String?
        let createdAt: String
        let lastUsedAt: String?
        let signCount: Double
        let deviceType: String
        let authenticatorAttachment: String?
        let backedUp: Bool
        let transports: [String]
    }
}

@MainActor
protocol SettingsProfileServicing: AnyObject {
    func loadProfile(now: Date) async throws -> SettingsProfileSnapshot?
    func updateName(firstName: String, lastName: String) async throws
    func updateContact(_ field: SettingsProfileContactField, value: String) async throws
    func updateLocale(_ locale: String) async throws
    func updateTimezone(_ timezone: String) async throws
    func updateDateFormat(_ dateFormat: String) async throws
    func updateWorkingStatus(_ status: String) async throws
    func updateActivityIndicator(disabled: Bool) async throws
    func updateMagicLinkEmail(enabled: Bool) async throws
    func updateNotificationPreference(_ update: SettingsNotificationPreferenceUpdate) async throws
    func switchCompany(companyID: String?) async throws -> SettingsCompanySwitchResult
    func listSessions(now: Date) async throws -> SettingsSessionList
    func listPasskeys() async throws -> SettingsPasskeyList
}

@MainActor
final class SettingsProfileService: SettingsProfileServicing {
    private let transport: any SettingsRemoteTransporting

    init(transport: any SettingsRemoteTransporting) {
        self.transport = transport
    }

    convenience init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.init(transport: SettingsRemoteTransport(convex: convex))
    }

    func loadProfile(now: Date = .now) async throws -> SettingsProfileSnapshot? {
        let request = Self.profileRequest(now: now)
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    func updateName(firstName: String, lastName: String) async throws {
        try await performSuccessMutation(Self.nameRequest(firstName: firstName, lastName: lastName))
    }

    func updateContact(_ field: SettingsProfileContactField, value: String) async throws {
        try await performSuccessMutation(Self.contactRequest(field: field, value: value))
    }

    func updateLocale(_ locale: String) async throws {
        try await performSuccessMutation(Self.stringMutation("updateLocale", key: "locale", value: locale))
    }

    func updateTimezone(_ timezone: String) async throws {
        try await performSuccessMutation(
            Self.stringMutation("updateTimezone", key: "timezone", value: timezone)
        )
    }

    func updateDateFormat(_ dateFormat: String) async throws {
        try await performSuccessMutation(
            Self.stringMutation("updateDateFormat", key: "dateFormat", value: dateFormat)
        )
    }

    func updateWorkingStatus(_ status: String) async throws {
        try await performSuccessMutation(
            Self.stringMutation("updateWorkingStatus", key: "status", value: status)
        )
    }

    func updateActivityIndicator(disabled: Bool) async throws {
        try await performSuccessMutation(
            SettingsRemoteRequest(
                .mutation,
                "functions/settings/myProfile:updateActivityIndicator",
                arguments: ["disabled": disabled]
            )
        )
    }

    func updateMagicLinkEmail(enabled: Bool) async throws {
        try await performSuccessMutation(
            SettingsRemoteRequest(
                .mutation,
                "functions/settings/myProfile:updateSendMagicLinkEmail",
                arguments: ["enabled": enabled]
            )
        )
    }

    func updateNotificationPreference(_ update: SettingsNotificationPreferenceUpdate) async throws {
        try await performSuccessMutation(Self.notificationRequest(update))
    }

    func switchCompany(companyID: String?) async throws -> SettingsCompanySwitchResult {
        let request = Self.switchCompanyRequest(companyID: companyID)
        return try await transport.mutate(request.function, arguments: request.arguments)
    }

    func listSessions(now: Date = .now) async throws -> SettingsSessionList {
        let request = Self.sessionsRequest(now: now)
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    func listPasskeys() async throws -> SettingsPasskeyList {
        let request = SettingsRemoteRequest(
            .query,
            "functions/settings/myProfile:listPasskeys"
        )
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    static func profileRequest(now: Date) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .query,
            "functions/settings/myProfile:getMyProfileBootstrap",
            arguments: ["nowMs": now.timeIntervalSince1970 * 1_000]
        )
    }

    static func nameRequest(firstName: String, lastName: String) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .mutation,
            "functions/settings/myProfile:updateName",
            arguments: ["firstName": firstName, "lastName": lastName]
        )
    }

    static func contactRequest(
        field: SettingsProfileContactField,
        value: String
    ) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .mutation,
            "functions/settings/myProfile:updateContactField",
            arguments: ["field": field.rawValue, "value": value]
        )
    }

    static func notificationRequest(
        _ update: SettingsNotificationPreferenceUpdate
    ) -> SettingsRemoteRequest {
        var arguments: [String: ConvexEncodable?] = [
            "category": update.category.rawValue,
            "notification": update.notification
        ]
        if let value = update.allowSystemNotifications {
            arguments["allowSystemNotifications"] = value
        }
        if let value = update.allowEmailNotifications {
            arguments["allowEmailNotifications"] = value
        }
        if let value = update.allowSlackNotifications {
            arguments["allowSlackNotifications"] = value
        }
        return SettingsRemoteRequest(
            .mutation,
            "functions/settings/myProfile:updateNotificationPreference",
            arguments: arguments
        )
    }

    static func switchCompanyRequest(companyID: String?) -> SettingsRemoteRequest {
        var arguments: [String: ConvexEncodable?] = [:]
        if let companyID {
            arguments["companyId"] = companyID
        }
        return SettingsRemoteRequest(
            .mutation,
            "functions/settings/myProfile:switchCompany",
            arguments: arguments
        )
    }

    static func sessionsRequest(now: Date) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .query,
            "functions/settings/myProfile:listSessions",
            arguments: ["nowMs": now.timeIntervalSince1970 * 1_000]
        )
    }

    private static func stringMutation(
        _ mutation: String,
        key: String,
        value: String
    ) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .mutation,
            "functions/settings/myProfile:\(mutation)",
            arguments: [key: value]
        )
    }

    private func performSuccessMutation(_ request: SettingsRemoteRequest) async throws {
        let result: SettingsSuccess = try await transport.mutate(
            request.function,
            arguments: request.arguments
        )
        guard result.success else { throw SettingsServiceError.operationRejected }
    }
}

enum SettingsServiceError: LocalizedError, Equatable {
    case operationRejected

    var errorDescription: String? {
        switch self {
        case .operationRejected:
            "Pathway did not accept this settings change."
        }
    }
}
