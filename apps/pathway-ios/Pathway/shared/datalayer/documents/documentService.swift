@preconcurrency import ConvexMobile
import Foundation

@MainActor
protocol DocumentServicing: AnyObject {
    func information(documentID: String) async throws -> DocumentInformation
    func history(documentID: String) async throws -> DocumentHistoryResult
    func versions(documentID: String) async throws -> DocumentVersionsResult
    func copyVersion(documentID: String) async throws -> CreatedDocument
    func recipients(documentID: String) async throws -> DocumentRecipientsResult
    func searchContacts(query: String) async throws -> [CreateDocumentContact]
    func updateInformation(
        documentID: String,
        title: String?,
        subtitle: String?,
        renewalAt: Double??
    ) async throws
    func updateStatus(documentID: String, status: String, expiredAt: Double??) async throws
    func setPinned(documentID: String, pinned: Bool) async throws -> [String]?
    func archive(documentID: String) async throws
    func restore(documentID: String) async throws
    func transfer(documentID: String, ownerUserID: String) async throws
    func shareLinks(documentID: String) async throws -> DocumentShareLinksResult
    func updateShareLink(
        documentID: String,
        key: String,
        update: DocumentShareLinkUpdate
    ) async throws -> DocumentShareLinkUpdateResult
    func addRecipient(documentID: String, draft: DocumentRecipientDraft) async throws
    func updateRecipient(
        documentID: String,
        recipientID: String,
        draft: DocumentRecipientDraft
    ) async throws
    func removeRecipient(documentID: String, recipientID: String) async throws
    func reorderRecipients(documentID: String, recipientIDs: [String]) async throws
    func schedulingCapability() async throws -> DocumentSchedulingCapability
    func send(documentID: String, draft: DocumentSendDraft) async throws
}

extension DocumentServicing {
    func searchContacts(query: String) async throws -> [CreateDocumentContact] {
        []
    }

    func copyVersion(documentID: String) async throws -> CreatedDocument {
        throw DocumentServiceError.rejected("Copying versions is unavailable from this document service.")
    }

    func schedulingCapability() async throws -> DocumentSchedulingCapability {
        DocumentSchedulingCapability(
            scheduledDocumentSend: false,
            canSchedule: false,
            canManageRules: false
        )
    }

    func send(documentID: String, draft: DocumentSendDraft) async throws {
        throw DocumentServiceError.rejected("Sending is unavailable from this document service.")
    }
}

@MainActor
final class ConvexDocumentService: DocumentServicing {
    private let convex: ConvexClientWithAuth<PathwayAuthSession>

    init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.convex = convex
    }

    func information(documentID: String) async throws -> DocumentInformation {
        try await query(
            "functions/dashboard/documentActions:getDocumentInformation",
            documentID: documentID
        )
    }

    func history(documentID: String) async throws -> DocumentHistoryResult {
        try await query(
            "functions/dashboard/documentActions:getDocumentHistory",
            documentID: documentID
        )
    }

    func versions(documentID: String) async throws -> DocumentVersionsResult {
        try await query(
            "functions/dashboard/documentActions:getDocumentVersions",
            documentID: documentID
        )
    }

    func copyVersion(documentID: String) async throws -> CreatedDocument {
        let result: DocumentCloneResult = try await convex.action(
            "functions/dashboard/documentAssetActions:cloneDocument",
            with: ["documentId": documentID]
        )
        guard result.success, let id = result.id else {
            throw DocumentServiceError.rejected(result.message ?? "This version could not be copied.")
        }
        return CreatedDocument(
            id: id,
            editToken: result.editToken,
            viewToken: result.viewToken
        )
    }

    func recipients(documentID: String) async throws -> DocumentRecipientsResult {
        try await query(
            "functions/dashboard/documentActions:getDocumentRecipients",
            documentID: documentID
        )
    }

    func searchContacts(query: String) async throws -> [CreateDocumentContact] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count >= 2 else { return [] }

        let fields: [CreateDocumentContactSearchField] = normalized.contains("@")
            ? [.email]
            : [.firstName, .lastName, .email]
        var contacts: [CreateDocumentContact] = []
        var seen = Set<String>()
        for field in fields {
            let result: CreateDocumentContactSearchResult = try await queryOnce(
                "functions/addressBook/contacts:searchContacts",
                arguments: ["field": field.rawValue, "search": normalized]
            )
            contacts.append(contentsOf: result.contacts.filter { seen.insert($0.id).inserted })
        }
        return Array(contacts.prefix(10))
    }

    func updateInformation(
        documentID: String,
        title: String?,
        subtitle: String?,
        renewalAt: Double??
    ) async throws {
        var arguments: [String: ConvexEncodable?] = ["documentId": documentID]
        if let title { arguments["title"] = title }
        if let subtitle { arguments["subtitle"] = subtitle }
        encodeNullable(renewalAt, key: "renewalAt", into: &arguments)
        try await requireSuccess(
            "functions/dashboard/documentActions:updateDocumentInformation",
            arguments: arguments
        )
    }

    func updateStatus(documentID: String, status: String, expiredAt: Double??) async throws {
        var arguments: [String: ConvexEncodable?] = [
            "documentId": documentID,
            "status": status
        ]
        encodeNullable(expiredAt, key: "expiredAt", into: &arguments)
        try await requireSuccess(
            "functions/dashboard/documentActions:updateDocumentStatus",
            arguments: arguments
        )
    }

    func setPinned(documentID: String, pinned: Bool) async throws -> [String]? {
        let result: DocumentMutationResult = try await convex.mutation(
            "functions/dashboard/documentActions:pinDocument",
            with: ["documentId": documentID, "pinned": pinned]
        )
        try requireSuccess(result)
        return result.pinnedDocumentIds
    }

    func archive(documentID: String) async throws {
        try await documentListMutation(
            "functions/dashboard/documentActions:archiveDocuments",
            documentID: documentID
        )
    }

    func restore(documentID: String) async throws {
        try await documentListMutation(
            "functions/dashboard/documentActions:restoreDocuments",
            documentID: documentID
        )
    }

    func transfer(documentID: String, ownerUserID: String) async throws {
        try await requireSuccess(
            "functions/dashboard/documentActions:transferDocumentOwnership",
            arguments: ["documentId": documentID, "ownerUserId": ownerUserID]
        )
    }

    func shareLinks(documentID: String) async throws -> DocumentShareLinksResult {
        let result: DocumentShareLinksResult = try await convex.mutation(
            "functions/dashboard/documentActions:sendDocumentLink",
            with: ["documentId": documentID]
        )
        guard result.success else {
            throw DocumentServiceError.rejected(result.reason ?? "Share links could not be loaded.")
        }
        return result
    }

    func updateShareLink(
        documentID: String,
        key: String,
        update: DocumentShareLinkUpdate
    ) async throws -> DocumentShareLinkUpdateResult {
        var arguments: [String: ConvexEncodable?] = [
            "documentId": documentID,
            "key": key,
            "active": update.active,
            "accessMode": update.accessMode.rawValue,
            "passwordActive": update.passwordActive
        ]
        if let accessLimit = update.accessLimit { arguments["accessLimit"] = Double(accessLimit) }
        if let expireAt = update.expireAt { arguments["expireAt"] = expireAt }
        if let password = update.password, !password.isEmpty { arguments["password"] = password }
        let result: DocumentShareLinkUpdateResult = try await convex.mutation(
            "functions/dashboard/documentActions:updateDocumentShareLink",
            with: arguments
        )
        guard result.success else {
            throw DocumentServiceError.rejected(result.reason ?? "The share link could not be updated.")
        }
        return result
    }

    func addRecipient(documentID: String, draft: DocumentRecipientDraft) async throws {
        let arguments = recipientArguments(documentID: documentID, draft: draft)
        try await requireSuccess(
            "functions/dashboard/documentActions:addDocumentRecipient",
            arguments: arguments
        )
    }

    func updateRecipient(
        documentID: String,
        recipientID: String,
        draft: DocumentRecipientDraft
    ) async throws {
        var arguments = recipientArguments(documentID: documentID, draft: draft)
        arguments["recipientId"] = recipientID
        try await requireSuccess(
            "functions/dashboard/documentActions:updateDocumentRecipient",
            arguments: arguments
        )
    }

    func removeRecipient(documentID: String, recipientID: String) async throws {
        try await requireSuccess(
            "functions/dashboard/documentActions:removeDocumentRecipient",
            arguments: ["documentId": documentID, "recipientId": recipientID]
        )
    }

    func reorderRecipients(documentID: String, recipientIDs: [String]) async throws {
        let values: [ConvexEncodable?] = recipientIDs
        try await requireSuccess(
            "functions/dashboard/documentActions:reorderDocumentRecipients",
            arguments: ["documentId": documentID, "recipientIds": values]
        )
    }

    func send(documentID: String, draft: DocumentSendDraft) async throws {
        if let validationMessage = DocumentSendValidation.validationMessage(for: draft) {
            throw DocumentServiceError.rejected(validationMessage)
        }

        var stagedAttachmentIDs: [String] = []
        do {
            let attachments = try await prepareAndUploadAttachments(
                documentID: documentID,
                attachments: draft.attachments
            )
            stagedAttachmentIDs = attachments.map(\.assetID)

            var arguments: [String: ConvexEncodable?] = [
                "documentId": documentID,
                "to": draft.to.map { $0 as ConvexEncodable? },
                "cc": draft.cc.map { $0 as ConvexEncodable? },
                "subject": draft.subject,
                "body": draft.htmlBody.isEmpty ? "<p></p>" : draft.htmlBody,
                "attachPDF": draft.attachPDF,
                "attachments": attachments.map { attachment in
                    [
                        "attachmentId": attachment.assetID,
                        "fileName": attachment.fileName
                    ] as [String: ConvexEncodable?]
                } as [ConvexEncodable?],
                "savePeriod": draft.savePeriod
            ]
            if let expiredAt = draft.expiredAt { arguments["expiredAt"] = expiredAt }
            if let serviceId = draft.serviceId { arguments["serviceId"] = serviceId }

            let result: DocumentSendResult
            if let scheduledAt = draft.scheduledAt, let timeZone = draft.timeZone {
                arguments["sendAt"] = scheduledAt
                arguments["timeZone"] = timeZone
                arguments["bcc"] = [] as [ConvexEncodable?]
                result = try await convex.mutation(
                    "functions/documents/delivery:scheduleDocumentSend",
                    with: arguments
                )
            } else {
                result = try await convex.action(
                    "functions/dashboard/documentAssetActions:sendDashboardDocument",
                    with: arguments
                )
            }
            guard result.success else {
                throw DocumentServiceError.rejected(
                    result.message ?? (draft.scheduledAt == nil
                        ? "The document could not be sent."
                        : "The document could not be scheduled.")
                )
            }
        } catch {
            if !stagedAttachmentIDs.isEmpty {
                await deleteStagedAttachments(
                    documentID: documentID,
                    attachmentIDs: stagedAttachmentIDs
                )
            }
            throw error
        }
    }

    func schedulingCapability() async throws -> DocumentSchedulingCapability {
        try await queryOnce(
            "functions/documents/delivery:getSchedulingCapability",
            arguments: [:]
        )
    }

    private func prepareAndUploadAttachments(
        documentID: String,
        attachments: [DocumentEmailAttachment]
    ) async throws -> [DocumentPreparedAttachment] {
        guard !attachments.isEmpty else { return [] }
        let input: [ConvexEncodable?] = attachments.map { attachment in
            [
                "clientId": attachment.id.uuidString,
                "fileName": attachment.fileName,
                "size": Double(attachment.size),
                "mimeType": attachment.contentType
            ] as [String: ConvexEncodable?]
        }
        let result: DocumentPrepareAttachmentsResult = try await convex.action(
            "functions/dashboard/documentAssetActions:prepareDashboardSendEmailAttachments",
            with: ["documentId": documentID, "attachments": input]
        )
        guard result.success, let uploads = result.presignedUrls else {
            throw DocumentServiceError.rejected(result.message ?? "Attachments could not be prepared.")
        }

        let attachmentsByID = Dictionary(uniqueKeysWithValues: attachments.map { ($0.id.uuidString, $0) })
        do {
            for upload in uploads {
                guard let attachment = attachmentsByID[upload.clientId] else {
                    throw DocumentServiceError.rejected("An attachment was missing before upload.")
                }
                guard let url = URL(string: upload.url) else {
                    throw DocumentServiceError.rejected("Pathway returned an invalid attachment upload URL.")
                }
                try await uploadAttachment(attachment, to: url)
            }
            return uploads
        } catch {
            await deleteStagedAttachments(
                documentID: documentID,
                attachmentIDs: uploads.map(\.assetID)
            )
            throw error
        }
    }

    private func uploadAttachment(_ attachment: DocumentEmailAttachment, to url: URL) async throws {
        let accessed = attachment.localURL.startAccessingSecurityScopedResource()
        defer {
            if accessed { attachment.localURL.stopAccessingSecurityScopedResource() }
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(attachment.contentType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: request, fromFile: attachment.localURL)
        guard let response = response as? HTTPURLResponse,
              (200...299).contains(response.statusCode) else {
            throw DocumentServiceError.rejected("An attachment could not be uploaded.")
        }
    }

    private func deleteStagedAttachments(documentID: String, attachmentIDs: [String]) async {
        let values: [ConvexEncodable?] = attachmentIDs
        let _: DocumentDeleteAttachmentsResult? = try? await convex.action(
            "functions/dashboard/documentAssetActions:deleteStagedDashboardSendEmailAttachments",
            with: ["documentId": documentID, "attachmentIds": values]
        )
    }

    private func query<T: Decodable>(
        _ function: String,
        documentID: String
    ) async throws -> T {
        let publisher = convex.subscribe(
            to: function,
            with: ["documentId": documentID],
            yielding: T.self
        )
        for try await value in publisher.values {
            return value
        }
        throw CancellationError()
    }

    private func queryOnce<T: Decodable>(
        _ function: String,
        arguments: [String: ConvexEncodable?]
    ) async throws -> T {
        let publisher = convex.subscribe(to: function, with: arguments, yielding: T.self)
        for try await value in publisher.values {
            try Task.checkCancellation()
            return value
        }
        throw CancellationError()
    }

    private func documentListMutation(_ function: String, documentID: String) async throws {
        let ids: [ConvexEncodable?] = [documentID]
        try await requireSuccess(function, arguments: ["documentIds": ids])
    }

    private func requireSuccess(
        _ function: String,
        arguments: sending [String: ConvexEncodable?]
    ) async throws {
        let result: DocumentMutationResult = try await convex.mutation(function, with: arguments)
        try requireSuccess(result)
    }

    private func requireSuccess(_ result: DocumentMutationResult) throws {
        guard result.success else {
            throw DocumentServiceError.rejected(result.message ?? "Pathway could not complete this action.")
        }
    }

    private func recipientArguments(
        documentID: String,
        draft: DocumentRecipientDraft
    ) -> [String: ConvexEncodable?] {
        var arguments: [String: ConvexEncodable?] = [
            "documentId": documentID,
            "firstName": draft.firstName,
            "email": draft.email,
            "position": draft.position
        ]
        if let contactId = draft.contactId { arguments["contactId"] = contactId }
        add(draft.lastName, key: "lastName", to: &arguments)
        add(draft.phone, key: "phone", to: &arguments)
        add(draft.company, key: "company", to: &arguments)
        add(draft.address, key: "address", to: &arguments)
        return arguments
    }

    private func add(
        _ value: String,
        key: String,
        to arguments: inout [String: ConvexEncodable?]
    ) {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { arguments[key] = value }
    }

    private func encodeNullable(
        _ value: Double??,
        key: String,
        into arguments: inout [String: ConvexEncodable?]
    ) {
        guard let value else { return }
        arguments[key] = value
    }
}
