import Foundation
@testable import Pathway
import Testing

struct DocumentFoundationTests {
    @Test func decodesCanonicalDocumentInformation() throws {
        let data = Data(#"{"id":"document-id","displayId":42,"title":"Proposal","subtitle":null,"status":"creating","source":"blank","ownerUserId":"user-id","ownerName":"Corey Baines","createdByName":"Corey Baines","createdAt":1000,"updatedAt":2000,"sentAt":null,"acceptedAt":null,"expiredAt":null,"renewalAt":3000,"closedAt":null,"viewCount":7,"canEdit":true,"editToken":"edit-token","viewToken":"view-token"}"#.utf8)
        let information = try JSONDecoder().decode(DocumentInformation.self, from: data)

        #expect(information.id == "document-id")
        #expect(information.displayId == 42)
        #expect(information.renewalAt == 3000)
        #expect(information.canEdit)
        #expect(information.viewToken == "view-token")
    }

    @Test func decodesRecipientWithoutSortOrderForBackwardCompatibility() throws {
        let data = Data(#"{"documentId":"document-id","recipients":[{"id":"recipient-id","firstName":"Taylor","lastName":null,"email":"taylor@example.com","phone":null,"company":null,"address":null,"position":"toRecipient","linkedToContact":false,"viewToken":null}]}"#.utf8)
        let result = try JSONDecoder().decode(DocumentRecipientsResult.self, from: data)

        #expect(result.recipients.first?.displayName == "Taylor")
        #expect(result.recipients.first?.sortOrder == nil)
    }

    @Test func decodesDocumentPermissionsVerificationAndEmailServices() throws {
        let data = Data(#"{"userData":{"id":"user-id","email":"corey@example.com","emailVerified":"2026-07-16T00:00:00.000Z"},"companyData":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2"},"permissions":{"canDeleteDocuments":true,"canShareDocumentAccess":true,"canSendDocuments":true,"manageDocumentRecipients":true},"emailServices":[{"id":"service-id","type":"SMTP","email":"corey@example.com","sender":"Corey","defaultForDocument":true}]}"#.utf8)
        let bootstrap = try JSONDecoder().decode(MobileDashboardBootstrap.self, from: data)

        #expect(bootstrap.userData.isEmailVerified)
        #expect(bootstrap.permissions?.canSendDocuments == true)
        #expect(bootstrap.permissions?.canShareDocumentAccess == true)
        #expect(bootstrap.emailServices?.first?.isAvailableForDocuments == true)
    }

    @Test @MainActor func optimisticPinRollsBackWhenServiceFails() async throws {
        let service = DocumentServiceMock()
        service.error = DocumentServiceError.rejected("No access")
        let model = PathwayAppModel(documentService: service)
        let document = try makeDashboardDocument()

        await #expect(throws: DocumentServiceError.self) {
            try await model.setDocumentPinned(document, pinned: true)
        }
        #expect(!model.isDocumentPinned(document.id))
        #expect(model.pinnedDocuments.isEmpty)
    }

    @Test @MainActor func archiveCanBeRestoredFromUndoSnapshot() async throws {
        let service = DocumentServiceMock()
        let model = PathwayAppModel(documentService: service)
        let document = try makeDashboardDocument()
        try await model.setDocumentPinned(document, pinned: true)

        let undo = try await model.archiveDocument(document)
        #expect(model.pinnedDocuments.isEmpty)
        #expect(!model.isDocumentPinned(document.id))

        try await model.restoreArchivedDocument(undo)
        #expect(model.pinnedDocuments.map(\.id) == [document.id])
        #expect(model.isDocumentPinned(document.id))
        #expect(service.restoredDocumentIDs == [document.id])
    }

    private func makeDashboardDocument() throws -> DashboardDocument {
        let data = Data(#"{"id":"document-id","displayId":42,"title":"Proposal","subtitle":null,"status":"creating","modifiedDate":null,"mainRecipientFirstName":"Taylor","mainRecipientLastName":"","mainRecipientEmail":"taylor@example.com","currencySymbol":"$","totalValue":100,"flightStatus":"none"}"#.utf8)
        return try JSONDecoder().decode(DashboardDocument.self, from: data)
    }
}

@MainActor
private final class DocumentServiceMock: DocumentServicing {
    var error: Error?
    var pinnedDocumentIDs: [String] = []
    var restoredDocumentIDs: [String] = []

    func information(documentID: String) async throws -> DocumentInformation { fatalError() }
    func history(documentID: String) async throws -> DocumentHistoryResult { fatalError() }
    func versions(documentID: String) async throws -> DocumentVersionsResult { fatalError() }
    func recipients(documentID: String) async throws -> DocumentRecipientsResult { fatalError() }
    func updateInformation(documentID: String, title: String?, subtitle: String?, renewalAt: Double??) async throws {}
    func updateStatus(documentID: String, status: String, expiredAt: Double??) async throws {}

    func setPinned(documentID: String, pinned: Bool) async throws -> [String]? {
        if let error { throw error }
        if pinned {
            pinnedDocumentIDs = [documentID]
        } else {
            pinnedDocumentIDs = []
        }
        return pinnedDocumentIDs
    }

    func archive(documentID: String) async throws {
        if let error { throw error }
    }

    func restore(documentID: String) async throws {
        if let error { throw error }
        restoredDocumentIDs.append(documentID)
    }

    func transfer(documentID: String, ownerUserID: String) async throws {}
    func shareLinks(documentID: String) async throws -> DocumentShareLinksResult { fatalError() }
    func updateShareLink(documentID: String, key: String, update: DocumentShareLinkUpdate) async throws -> DocumentShareLinkUpdateResult { fatalError() }
    func addRecipient(documentID: String, draft: DocumentRecipientDraft) async throws {}
    func updateRecipient(documentID: String, recipientID: String, draft: DocumentRecipientDraft) async throws {}
    func removeRecipient(documentID: String, recipientID: String) async throws {}
    func reorderRecipients(documentID: String, recipientIDs: [String]) async throws {}
}
