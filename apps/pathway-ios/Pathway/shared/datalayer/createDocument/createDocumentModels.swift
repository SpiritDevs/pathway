@preconcurrency import ConvexMobile
import Foundation

struct CreateDocumentContext: Sendable {
    let currentUserID: String
    let companyID: String
    let storageLocation: String
    let locale: String
    let timezone: String
    let dateFormat: String
    let requireDocumentRecipient: Bool
    let canAssignOwner: Bool
    let canSearchContacts: Bool
    let canSaveContacts: Bool
    let assignableUsers: [MobileDashboardBootstrap.CompanyUser]
}

enum CreateDocumentStep: Int, CaseIterable, Identifiable, Sendable {
    case choose
    case details
    case fields
    case review

    var id: Int { rawValue }
}

enum CreateDocumentTemplateCollection: String, CaseIterable, Identifiable, Sendable {
    case suggested
    case myTemplates
    case gallery

    var id: String { rawValue }
}

enum CreateDocumentModalRequest: Hashable, Sendable {
    case quickAccess
    case category(String)
}

struct CreateDocumentModalData: Decodable, Sendable {
    let permissions: Permissions?
    let templates: [CreateDocumentTemplate]
    let systemTemplates: [CreateDocumentTemplate]
    let templateCategories: [CreateDocumentTemplateCategory]
    let templateDataItems: [CreateDocumentTemplateDataItem]
    let industryTemplateIds: [String]

    struct Permissions: Decodable, Sendable {
        let accessPublicDocumentTemplates: Bool?
    }
}

struct CreateDocumentTemplate: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let companyId: String
    let title: String
    let status: String
    let tags: [String]?
    let templateName: String?
    let templateDescription: String?
    let templateCategory: String?
    let templatePublished: Bool
    let generatedAssets: GeneratedAssets?
    let viewToken: String?
    let settings: Settings?

    struct GeneratedAssets: Decodable, Hashable, Sendable {
        let coverpage: String?
        let coverpageGenerationLastTriggered: Bool

        private enum CodingKeys: String, CodingKey {
            case coverpage
            case coverpageGenerationLastTriggered
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            coverpage = try values.decodeIfPresent(String.self, forKey: .coverpage)
            if let value = try? values.decode(Bool.self, forKey: .coverpageGenerationLastTriggered) {
                coverpageGenerationLastTriggered = value
            } else if let value = try? values.decode(
                String.self,
                forKey: .coverpageGenerationLastTriggered
            ) {
                coverpageGenerationLastTriggered = !value.isEmpty
            } else {
                coverpageGenerationLastTriggered = false
            }
        }
    }

    struct Settings: Decodable, Hashable, Sendable {
        let primaryRecipientCount: Double?

        private enum CodingKeys: String, CodingKey {
            case primaryRecipientCount
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            if let value = try? values.decodeIfPresent(
                Double.self,
                forKey: .primaryRecipientCount
            ) {
                primaryRecipientCount = value
            } else if let value = try? values.decode(
                ConvexFloat<Double>.self,
                forKey: .primaryRecipientCount
            ) {
                primaryRecipientCount = value.wrappedValue
            } else {
                primaryRecipientCount = nil
            }
        }
    }

    var displayName: String {
        let value = templateName?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value! : title
    }

    var isSystemTemplate: Bool {
        status == "system_template"
    }

    var primaryRecipientCount: Int {
        guard let count = settings?.primaryRecipientCount, count.isFinite else { return 1 }
        return min(10, max(1, Int(count)))
    }
}

struct CreateDocumentTemplateCategory: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
}

struct CreateDocumentTemplateDataItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let label: String
    let type: String
    let defaultValue: String?
    let mandatory: Bool
    let connection: String
    let connectionLinkId: String?
    let values: [String]
}

struct CreateDocumentDataItemValue: Identifiable, Hashable, Sendable {
    let item: CreateDocumentTemplateDataItem
    var value: String

    var id: String { item.id }
}

struct CreateDocumentRecipient: Identifiable, Hashable, Sendable {
    let id: UUID
    var contactId: String?
    var email: String
    var firstName: String
    var lastName: String
    var phoneNumber: String
    var address: String
    var companyName: String
    var accountRef: String
    var saveContact: Bool

    init(
        id: UUID = UUID(),
        contactId: String? = nil,
        email: String = "",
        firstName: String = "",
        lastName: String = "",
        phoneNumber: String = "",
        address: String = "",
        companyName: String = "",
        accountRef: String = "",
        saveContact: Bool = false
    ) {
        self.id = id
        self.contactId = contactId
        self.email = email
        self.firstName = firstName
        self.lastName = lastName
        self.phoneNumber = phoneNumber
        self.address = address
        self.companyName = companyName
        self.accountRef = accountRef
        self.saveContact = saveContact
    }

    var isBlank: Bool {
        contactId == nil && [
            email, firstName, lastName, phoneNumber, address, companyName, accountRef
        ].allSatisfy { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var normalized: CreateDocumentRecipient {
        var result = self
        result.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        result.firstName = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        result.lastName = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        result.phoneNumber = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        result.address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        result.companyName = companyName.trimmingCharacters(in: .whitespacesAndNewlines)
        result.accountRef = accountRef.trimmingCharacters(in: .whitespacesAndNewlines)
        return result
    }
}

struct CreateDocumentContact: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let email: String
    let firstName: String
    let lastName: String?
    let address: String?
    let phone: String?
    let company: String?
    let account: String?
    let color: String?
    let profileImage: String?

    var displayName: String {
        [firstName, lastName ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    var recipient: CreateDocumentRecipient {
        CreateDocumentRecipient(
            contactId: id,
            email: email,
            firstName: firstName,
            lastName: lastName ?? "",
            phoneNumber: phone ?? "",
            address: address ?? "",
            companyName: company ?? "",
            accountRef: account ?? ""
        )
    }
}

struct CreateDocumentContactSearchResult: Decodable, Sendable {
    let contacts: [CreateDocumentContact]
}

enum CreateDocumentContactSearchField: String, Sendable {
    case email
    case firstName
    case lastName
}

enum CreateDocumentImportKind: String, Sendable {
    case pdf
    case image
}

struct CreateDocumentImport: Hashable, Sendable {
    let fileURL: URL
    let fileName: String
    let kind: CreateDocumentImportKind
    let size: Int
}

enum CreateDocumentSelection: Hashable, Sendable {
    case blank
    case template(CreateDocumentTemplate)
    case imported(CreateDocumentImport)
}

struct CreateDocumentActionInput: Sendable {
    let title: String
    let ownerUserID: String?
    let recipients: [CreateDocumentRecipient]
    let dataItems: [CreateDocumentDataItemValue]
}

struct CreateDocumentActionResult: Decodable, Sendable {
    let success: Bool
    let id: String?
    let editToken: String?
    let viewToken: String?
    let message: String?
}

struct CreateDocumentUploadRequest: Sendable {
    let fileName: String
    let type: CreateDocumentImportKind
    let size: Int
}

struct CreateDocumentPresignedUpload: Decodable, Sendable {
    let fileName: String
    let url: String
    let assetID: String
    let type: String
    let clientId: String?
}

struct CreateDocumentPresignedUploadResult: Decodable, Sendable {
    let success: Bool
    let presignedUrls: [CreateDocumentPresignedUpload]?
    let error: String?
}

struct SaveCreateDocumentContactsResult: Decodable, Sendable {
    let success: Bool
    let contacts: [SavedContact]

    struct SavedContact: Decodable, Sendable {
        let id: String
        let email: String
    }
}

struct CreatedDocument: Identifiable, Hashable, Sendable {
    let id: String
    let editToken: String?
    let viewToken: String?
}

enum CreateDocumentLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

enum CreateDocumentOperation: Equatable, Sendable {
    case idle
    case preparing
    case uploading(Double)
    case processing
    case openingEditor
    case failed(String)

    var isRunning: Bool {
        switch self {
        case .preparing, .uploading, .processing, .openingEditor:
            true
        case .idle, .failed:
            false
        }
    }
}

enum CreateDocumentValidationError: LocalizedError, Equatable, Sendable {
    case chooseSource
    case recipientRequired
    case invalidRecipient
    case requiredDataItem(String)

    var errorDescription: String? {
        switch self {
        case .chooseSource:
            "Choose a template, a blank document, or a file to continue."
        case .recipientRequired:
            "Add at least one recipient to continue."
        case .invalidRecipient:
            "Each recipient needs a first name and a valid email address."
        case let .requiredDataItem(label):
            "Enter a value for \(label)."
        }
    }
}

enum CreateDocumentServiceError: LocalizedError, Sendable {
    case invalidResponse(String)
    case invalidUploadURL
    case uploadFailed(Int)

    var errorDescription: String? {
        switch self {
        case let .invalidResponse(message): message
        case .invalidUploadURL: "Pathway returned an invalid upload URL."
        case let .uploadFailed(status): "The file upload failed (HTTP \(status))."
        }
    }
}
