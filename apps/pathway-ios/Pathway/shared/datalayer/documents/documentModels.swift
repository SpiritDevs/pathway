import Foundation

struct DocumentInformation: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let displayId: Int?
    var title: String
    var subtitle: String?
    var status: String
    let source: String?
    var ownerUserId: String
    var ownerName: String
    let createdByName: String
    let createdAt: Double
    var updatedAt: Double
    let sentAt: Double?
    let acceptedAt: Double?
    var expiredAt: Double?
    var renewalAt: Double?
    let closedAt: Double?
    let viewCount: Int?
    let canEdit: Bool
    let editToken: String?
    let viewToken: String
}

struct DocumentVersionsResult: Decodable, Equatable, Sendable {
    let documentId: String
    let versions: [DocumentVersion]
}

struct DocumentCloneResult: Decodable, Equatable, Sendable {
    let success: Bool
    let id: String?
    let editToken: String?
    let viewToken: String?
    let message: String?
}

struct DocumentVersion: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let displayId: Int?
    let title: String
    let subtitle: String?
    let status: String
    let createdAt: Double
    let updatedAt: Double
    let createdByName: String
    let versionNumber: Int
    let isSelected: Bool
    let viewToken: String
}

struct DocumentRecipientsResult: Decodable, Equatable, Sendable {
    let documentId: String
    let recipients: [DocumentRecipient]
}

struct DocumentRecipient: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    var firstName: String
    var lastName: String?
    var email: String?
    var phone: String?
    var company: String?
    var address: String?
    var position: String?
    let linkedToContact: Bool
    let viewToken: String?
    let sortOrder: Int?

    var displayName: String {
        let name = [firstName, lastName]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .joined(separator: " ")
        return name.isEmpty ? (email ?? "Recipient") : name
    }
}

struct DocumentHistoryResult: Decodable, Equatable, Sendable {
    let success: Bool
    let message: String?
    let document: Summary?
    let history: [DocumentHistoryEvent]

    struct Summary: Decodable, Equatable, Sendable {
        let id: String
        let displayId: Int?
        let title: String
    }
}

struct DocumentHistoryEvent: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let timeStamp: Double
    let documentId: String
    let relatedDocumentId: String?
    let revisionId: String?
    let eventCode: String
    let eventCategory: String?
    let eventSource: String?
    let userId: String?
    let userName: String?
    let actorUserId: String?
    let actorContactId: String?
    let actorDisplay: String?
    let actorRelationship: String?
    let channel: String?
    let createdBySystem: Bool?
    let vKey: String?
}

enum DocumentShareAccessMode: String, Codable, CaseIterable, Sendable {
    case disabled
    case preview
    case viewOnly = "view_only"
    case fullAccess = "full_access"
}

struct DocumentShareLinkMetadata: Decodable, Equatable, Sendable {
    let accessLimit: Int?
    let currentAccessCount: Int?
    let expireDate: Double?
    let passwordActive: Bool?
}

struct DocumentShareLink: Decodable, Equatable, Sendable {
    let key: String
    let active: Bool
    let accessMode: DocumentShareAccessMode
    let metadata: DocumentShareLinkMetadata
}

struct DocumentShareLinksResult: Decodable, Equatable, Sendable {
    let success: Bool
    let reason: String?
    let documentId: String?
    let documentTitle: String?
    let links: [String: DocumentShareLink]?
}

struct DocumentShareLinkUpdate: Sendable {
    let active: Bool
    let accessMode: DocumentShareAccessMode
    let accessLimit: Int?
    let expireAt: Double?
    let password: String?
    let passwordActive: Bool
}

struct DocumentShareLinkUpdateResult: Decodable, Equatable, Sendable {
    let success: Bool
    let reason: String?
    let key: String?
    let active: Bool?
    let accessMode: DocumentShareAccessMode?
    let documentId: String?
    let documentTitle: String?
    let metadata: DocumentShareLinkMetadata?
}

struct DocumentRecipientDraft: Equatable, Sendable {
    var contactId: String? = nil
    var firstName: String
    var lastName: String
    var email: String
    var phone: String
    var company: String
    var address: String
    var position: String
}

struct DocumentMutationResult: Decodable, Equatable, Sendable {
    let success: Bool
    let id: String?
    let pinnedDocumentIds: [String]?
    let message: String?
}

struct DocumentEmailAttachment: Identifiable, Equatable, Sendable {
    let id: UUID
    let fileName: String
    let contentType: String
    let size: Int
    let localURL: URL

    init(
        id: UUID = UUID(),
        fileName: String,
        contentType: String,
        size: Int,
        localURL: URL
    ) {
        self.id = id
        self.fileName = fileName
        self.contentType = contentType
        self.size = size
        self.localURL = localURL
    }
}

struct DocumentSendDraft: Equatable, Sendable {
    var to: [String]
    var cc: [String]
    var subject: String
    var htmlBody: String
    var attachPDF: Bool
    var attachments: [DocumentEmailAttachment]
    var expiredAt: Double?
    var savePeriod: Bool
    var serviceId: String?
    var scheduledAt: Double? = nil
    var timeZone: String? = nil
}

struct DocumentSchedulingCapability: Decodable, Equatable, Sendable {
    let scheduledDocumentSend: Bool
    let canSchedule: Bool
    let canManageRules: Bool
}

struct DocumentPreparedAttachment: Decodable, Equatable, Sendable {
    let assetID: String
    let attachmentId: String
    let clientId: String
    let fileName: String
    let url: String
}

struct DocumentPrepareAttachmentsResult: Decodable, Equatable, Sendable {
    let success: Bool
    let presignedUrls: [DocumentPreparedAttachment]?
    let message: String?
}

struct DocumentDeleteAttachmentsResult: Decodable, Equatable, Sendable {
    let success: Bool
    let deletedAttachmentIds: [String]?
    let message: String?
}

struct DocumentSendResult: Decodable, Equatable, Sendable {
    let success: Bool
    let message: String?
    let errorCode: String?
}

enum DocumentSendValidation {
    static let maximumRecipientCount = 10
    static let maximumAttachmentBytes = 15 * 1_024 * 1_024
    static let minimumScheduleDelay: TimeInterval = 5 * 60
    static let maximumScheduleDelay: TimeInterval = 365 * 24 * 60 * 60

    static func emailAddresses(from value: String) -> [String] {
        value
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func isValidEmail(_ value: String) -> Bool {
        let components = value.split(separator: "@", omittingEmptySubsequences: false)
        guard components.count == 2,
              !components[0].isEmpty,
              components[1].contains("."),
              !components[1].hasPrefix("."),
              !components[1].hasSuffix(".") else {
            return false
        }
        return !value.contains(where: { $0.isWhitespace })
    }

    static func validationMessage(for draft: DocumentSendDraft) -> String? {
        validationMessage(for: draft, now: .now)
    }

    static func validationMessage(for draft: DocumentSendDraft, now: Date) -> String? {
        guard !draft.to.isEmpty else { return "Add at least one recipient." }
        guard draft.to.count <= maximumRecipientCount else {
            return "You can send to at most \(maximumRecipientCount) recipients."
        }
        guard draft.cc.count <= maximumRecipientCount else {
            return "You can add at most \(maximumRecipientCount) CC recipients."
        }
        guard (draft.to + draft.cc).allSatisfy(isValidEmail) else {
            return "Check the recipient email addresses."
        }
        guard !draft.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "Add a subject."
        }
        let attachmentBytes = draft.attachments.reduce(0) { $0 + $1.size }
        guard attachmentBytes <= maximumAttachmentBytes else {
            return "Attachments must total 15 MB or less."
        }
        if let scheduledAt = draft.scheduledAt {
            let scheduledDate = Date(timeIntervalSince1970: scheduledAt / 1_000)
            guard scheduledDate >= now.addingTimeInterval(minimumScheduleDelay) else {
                return "Schedule the send for at least five minutes from now."
            }
            guard scheduledDate <= now.addingTimeInterval(maximumScheduleDelay) else {
                return "Scheduled sends can be up to one year from now."
            }
            guard let timeZone = draft.timeZone,
                  TimeZone(identifier: timeZone) != nil else {
                return "Choose a valid time zone for the scheduled send."
            }
        }
        return nil
    }
}

struct DocumentActionCapabilities: Equatable, Sendable {
    let canEdit: Bool
    let canDelete: Bool
    let canPin: Bool
    let canShare: Bool
    let canSend: Bool
    let canTransfer: Bool
    let canManageRecipients: Bool
    let emailIsVerified: Bool

    init(information: DocumentInformation, bootstrap: MobileDashboardBootstrap) {
        let permissions = bootstrap.permissions
        let isCompanyOwner = bootstrap.companyData.isOwner == true
        let accountIsActive = bootstrap.userData.isActive != false
        emailIsVerified = bootstrap.userData.isEmailVerified
        canEdit = information.canEdit
        canDelete = information.canEdit && accountIsActive &&
            (isCompanyOwner || (permissions?.canDeleteDocuments ?? false))
        canPin = true
        canShare = information.canEdit && emailIsVerified && accountIsActive &&
            (isCompanyOwner || (permissions?.canShareDocumentAccess ?? false))
        canSend = information.canEdit && emailIsVerified && accountIsActive &&
            (isCompanyOwner || (permissions?.canSendDocuments ?? false))
        canTransfer = information.canEdit && !(bootstrap.assignableCompanyUsers ?? []).isEmpty
        canManageRecipients = information.canEdit && accountIsActive &&
            (isCompanyOwner || (permissions?.manageDocumentRecipients ?? false))
    }
}

struct ArchivedDocumentUndo: Identifiable, Sendable {
    let document: DashboardDocument
    let documentIndex: Int?
    let pinnedDocumentIndex: Int?
    let wasPinned: Bool

    var id: String { document.id }
}

enum DocumentServiceError: LocalizedError, Sendable {
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case let .rejected(message): message
        }
    }
}
