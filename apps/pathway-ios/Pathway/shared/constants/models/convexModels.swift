@preconcurrency import ConvexMobile
import Foundation

struct PathwayAuthSession: Sendable {
    let idToken: String
    let sessionToken: String
    let companyIDs: [String]
}

struct LoginActionResult: Decodable, Sendable {
    let success: Bool
    let message: String?
    let companyIds: [String]?
    let sessionToken: String?
}

struct PasswordResetRequestResult: Decodable, Sendable {
    let success: Bool
    let reason: String
}

struct ConvexAuthTokenResponse: Decodable, Sendable {
    let token: String
}

struct MutationSuccess: Decodable, Sendable {
    let success: Bool
    let message: String?
}

struct CompanyAssetCloudFrontSignature: Decodable, Sendable {
    let baseUrl: String
    let keyPairId: String
    let policy: String
    let signature: String

    var isUsable: Bool {
        !baseUrl.isEmpty && !keyPairId.isEmpty && !policy.isEmpty && !signature.isEmpty
    }
}

struct NativeCompanyPickerContext: Decodable, Sendable {
    let companies: [NativeCompanyPickerCompany]
    let email: String
}

struct NativeCompanyPickerCompany: Decodable, Identifiable, Sendable {
    let accountStatus: String
    let companyId: String
    let lastSelectedAt: Double?
    let name: String
    let primaryTeamName: String?
    let roleNames: [String]

    var id: String { companyId }

    var isSelectable: Bool {
        accountStatus == "active" || accountStatus == "payment_due"
    }

    var metadata: String {
        let values = ([primaryTeamName] + roleNames.map(Optional.some))
            .compactMap(\.self)
            .prefix(3)
        return values.isEmpty ? "Workspace" : values.joined(separator: " · ")
    }

    var statusLabel: String? {
        switch accountStatus {
        case "paused":
            "Account paused"
        case "suspended":
            "Account suspended"
        case "cancelled":
            "Account cancelled"
        default:
            nil
        }
    }
}

struct MobileDashboardBootstrap: Decodable, Sendable {
    let userData: UserData
    let companyData: CompanyData
    let permissions: Permissions?
    let companyUsers: [CompanyUser]?
    let assignableCompanyUsers: [CompanyUser]?
    let emailServices: [EmailService]?
    let features: Features?

    struct UserData: Decodable, Sendable {
        let id: String
        let email: String
        let firstName: String?
        let lastName: String?
        let profileImage: String?
        let profileColor: String?
        /// Optional so a newer app can continue to work briefly with an older backend deployment.
        let userType: String?
        let emailVerified: String?
        let isActive: Bool?
        let locale: String?
        let timezone: String?
        let dateFormat: String?

        init(
            id: String,
            email: String,
            firstName: String?,
            lastName: String?,
            profileImage: String?,
            profileColor: String?,
            userType: String?,
            emailVerified: String? = nil,
            isActive: Bool? = nil,
            locale: String? = nil,
            timezone: String? = nil,
            dateFormat: String? = nil
        ) {
            self.id = id
            self.email = email
            self.firstName = firstName
            self.lastName = lastName
            self.profileImage = profileImage
            self.profileColor = profileColor
            self.userType = userType
            self.emailVerified = emailVerified
            self.isActive = isActive
            self.locale = locale
            self.timezone = timezone
            self.dateFormat = dateFormat
        }

        var canApproveAdminAuthorization: Bool {
            guard let userType else { return false }
            return ["admin", "system_admin", "super_admin"].contains(userType)
        }

        var isEmailVerified: Bool {
            guard let emailVerified else { return false }
            return !emailVerified.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    struct CompanyData: Decodable, Sendable {
        let id: String
        let name: String
        let isOwner: Bool?
        let storageLocation: String
        let subscriptionPlan: String?
        let locale: String?
        let timezone: String?
        let dateFormat: String?
        let details: Details?

        struct Details: Decodable, Sendable {
            let trialExpiryDate: String?
            let requireDocumentRecipient: Bool?
        }
    }

    struct Permissions: Decodable, Sendable {
        let manageAddressBookContacts: Bool?
        let searchAddressBookContacts: Bool?
        let manageDocumentRecipients: Bool?
        let canAssignDocumentOwnershipOutsideTeam: Bool?
        let canDeleteDocuments: Bool?
        let canShareDocumentAccess: Bool?
        let canSendDocuments: Bool?
    }

    struct EmailService: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let type: String
        let email: String
        let sender: String
        let defaultForDocument: Bool

        var title: String {
            sender.isEmpty ? email : "\(sender) · \(email)"
        }

        var isAvailableForDocuments: Bool {
            true
        }
    }

    struct Features: Decodable, Sendable {
        let userManagementAddonEnabled: Bool?
        let templateLibraryAddonEnabled: Bool?
        let contactAddressBookEnabled: Bool?
    }

    struct CompanyUser: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let firstName: String?
        let lastName: String?
        let email: String?
        let profileImage: String?
        let profileColor: String?

        var displayName: String {
            let name = [firstName, lastName]
                .compactMap { value in
                    guard let value, !value.isEmpty else { return nil }
                    return value
                }
                .joined(separator: " ")
            return name.isEmpty ? (email ?? "Pathway user") : name
        }
    }
}

extension MobileDashboardBootstrap {
    var createDocumentContext: CreateDocumentContext {
        let owners = assignableCompanyUsers ?? []
        return CreateDocumentContext(
            currentUserID: userData.id,
            companyID: companyData.id,
            storageLocation: companyData.storageLocation,
            locale: companyData.locale ?? userData.locale ?? "en",
            timezone: companyData.timezone ?? userData.timezone ?? "UTC",
            dateFormat: companyData.dateFormat ?? userData.dateFormat ?? "dd/MM/yyyy",
            requireDocumentRecipient: companyData.details?.requireDocumentRecipient ?? false,
            canAssignOwner: (features?.userManagementAddonEnabled ?? false) && owners.count > 1,
            canSearchContacts: (features?.contactAddressBookEnabled ?? false) &&
                ((permissions?.searchAddressBookContacts ?? false) ||
                    (permissions?.manageAddressBookContacts ?? false)),
            canSaveContacts: (features?.contactAddressBookEnabled ?? false) &&
                (permissions?.manageAddressBookContacts ?? false),
            assignableUsers: owners
        )
    }
}

extension MobileDashboardBootstrap.UserData {
    var displayName: String {
        let name = [firstName, lastName]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " ")
        return name.isEmpty ? email : name
    }

    var initials: String {
        let value = [firstName, lastName]
            .compactMap { $0?.first }
            .map(String.init)
            .joined()
            .uppercased()
        return value.isEmpty ? "QC" : value
    }

    func profileImageURL(
        companyID: String,
        cloudFrontSignature: CompanyAssetCloudFrontSignature?
    ) -> URL? {
        guard
            let profileImage = profileImage?.trimmingCharacters(in: .whitespacesAndNewlines),
            !profileImage.isEmpty,
            !profileImage.hasPrefix("data:image/")
        else {
            return nil
        }

        if profileImage.hasPrefix("https://") || profileImage.hasPrefix("http://") {
            return URL(string: profileImage)
        }

        guard
            let cloudFrontSignature,
            cloudFrontSignature.isUsable,
            var url = URL(string: cloudFrontSignature.baseUrl)
        else {
            return nil
        }

        url.append(path: "company")
        url.append(path: companyID)
        url.append(path: "user")
        url.append(path: id)
        url.append(path: "profile")
        url.append(path: profileImage)

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "Policy", value: cloudFrontSignature.policy),
            URLQueryItem(name: "Key-Pair-Id", value: cloudFrontSignature.keyPairId),
            URLQueryItem(name: "Signature", value: cloudFrontSignature.signature)
        ]
        return components?.url
    }
}

enum APNsEnvironment: String, Decodable, Sendable {
    case development
    case production
}

enum AdminAuthorizationPurpose: String, Decodable, Sendable {
    case adminDashboard = "admin_dashboard"
    case impersonationRenewal = "impersonation_renewal"
}

struct AdminAuthorizationRequest: Decodable, Identifiable, Hashable, Sendable {
    let requestId: String
    let purpose: AdminAuthorizationPurpose?
    let targetUserName: String?
    let targetUserEmail: String?
    let browser: String?
    let os: String?
    let ipAddress: String?
    let requestedAt: Double
    let expiresAt: Double

    var id: String { requestId }

    var isImpersonationRenewal: Bool {
        purpose == .impersonationRenewal
    }

    var requestedDate: Date {
        Date(timeIntervalSince1970: requestedAt / 1_000)
    }

    var expiresDate: Date {
        Date(timeIntervalSince1970: expiresAt / 1_000)
    }
}

extension Collection where Element == AdminAuthorizationRequest {
    func selectedAdminAuthorizationRequest(
        preferredRequestID: String?,
        now: Date = .now
    ) -> AdminAuthorizationRequest? {
        let validRequests = filter { $0.expiresDate > now }
            .sorted { $0.requestedAt < $1.requestedAt }
        if let preferredRequestID {
            return validRequests.first(where: { $0.requestId == preferredRequestID })
        }
        return validRequests.first
    }
}

enum AdminAuthorizationRequestStatus: String, Decodable, Sendable {
    case approved
    case denied
    case expired
    case cancelled
    case closed
}

struct AdminAuthorizationDecisionResult: Decodable, Sendable {
    let accepted: Bool
    let status: AdminAuthorizationRequestStatus
}

enum AdminAuthorizationDecisionState: Equatable, Sendable {
    case idle
    case deciding(requestID: String, decision: AdminAuthorizationDecision)
    case failed(requestID: String, message: String)
}

enum AdminAuthorizationDecision: String, Equatable, Sendable {
    case approved
    case denied
}

struct DashboardTableResult: Decodable, Sendable {
    let success: Bool
    let documents: [DashboardDocument]
    let documentsCount: Int
    let pinnedDocumentIds: [String]
}

struct DashboardDocument: Decodable, Identifiable, Sendable {
    let id: String
    let displayId: Int
    let title: String
    let subtitle: String?
    let status: String
    let modifiedDate: String?
    let mainRecipientFirstName: String
    let mainRecipientLastName: String
    let mainRecipientEmail: String
    let currencySymbol: String
    @OptionalConvexFloat var totalValue: Double?
    let flightStatus: String

    var recipientName: String {
        [mainRecipientFirstName, mainRecipientLastName]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
