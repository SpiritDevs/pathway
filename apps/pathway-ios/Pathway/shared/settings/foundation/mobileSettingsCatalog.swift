import Foundation

struct MobileSettingsCatalog: Decodable, Equatable, Sendable {
    static let supportedSchemaVersion = 1

    let schemaVersion: Int
    let identity: Identity
    let workspace: Workspace
    let roleNames: [String]
    let permissions: Permissions
    let entitlements: Entitlements
    let lifecycle: Lifecycle
    let destinations: [Destination]

    struct Identity: Decodable, Equatable, Sendable {
        let userId: String
        let email: String
        let firstName: String?
        let lastName: String?
        let displayName: String
        let profileImage: String?
        let profileColor: String?

        var initials: String {
            let value = [firstName, lastName]
                .compactMap { $0?.first }
                .map(String.init)
                .joined()
                .uppercased()
            return value.isEmpty ? "QC" : value
        }
    }

    struct Workspace: Decodable, Equatable, Sendable {
        let companyId: String
        let companyName: String
        let membershipId: String
        let ownerUserId: String
        let accountStatus: AccountStatus
        let storageLocation: String
        let effectiveCompanyScope: EffectiveCompanyScope
        let isOrganizationAdmin: Bool
        let isOwner: Bool
        let primaryTeamId: String?
        let treatTeamsAsCompanies: Bool
    }

    enum AccountStatus: String, Decodable, Equatable, Sendable {
        case active
        case paymentDue = "payment_due"
        case paused
        case suspended
        case cancelled
    }

    enum EffectiveCompanyScope: String, Decodable, Equatable, Sendable {
        case organization
        case team
        case blocked
    }

    struct Permissions: Decodable, Equatable, Sendable {
        let manageSecurityAndSessions: Bool
        let manageUserAccounts: Bool
        let manageTeams: Bool
        let manageRoles: Bool
        let organizationAdmin: Bool
        let restrictUserManageToTeam: Bool
        let manageSubscriptions: Bool
        let manageBillingConfiguration: Bool
        let manageAddressBookContacts: Bool
        let manageDataItems: Bool
        let manageFontBook: Bool
        let manageCompanySettings: Bool
        let manageWorkflows: Bool
        let canAccessDevCenter: Bool
    }

    struct Entitlements: Decodable, Equatable, Sendable {
        let activeAddonCodes: [String]
        let planCode: String?
        let planName: String?
        let subscriptionStatus: String?
    }

    struct Lifecycle: Decodable, Equatable, Sendable {
        let canManage: Bool
        let canCloseCompany: Bool
        let isOwner: Bool
    }

    struct Destination: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let section: Section
        let availability: Availability
    }

    enum Section: String, CaseIterable, Decodable, Equatable, Sendable {
        case personal
        case workspace
        case contentAndDelivery = "content_and_delivery"
        case billingAndAddons = "billing_and_addons"
        case advanced
        case supportAndAbout = "support_and_about"
        case dataAndSession = "data_and_session"
    }

    enum Availability: Decodable, Equatable, Sendable {
        case available
        case addonRequired(code: String)

        private enum CodingKeys: String, CodingKey {
            case status
            case reason
            case addonCode
        }

        private enum Status: String, Decodable {
            case available
            case locked
        }

        private enum LockedReason: String, Decodable {
            case addonRequired = "addon_required"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(Status.self, forKey: .status) {
            case .available:
                self = .available
            case .locked:
                let reason = try container.decode(LockedReason.self, forKey: .reason)
                switch reason {
                case .addonRequired:
                    self = .addonRequired(
                        code: try container.decode(String.self, forKey: .addonCode)
                    )
                }
            }
        }
    }
}
