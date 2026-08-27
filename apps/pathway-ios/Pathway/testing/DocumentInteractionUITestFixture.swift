import SwiftUI

/// A deterministic, network-free host for document interaction UI tests.
/// It is reachable only when the UI-test launch argument is explicitly supplied.
@MainActor
struct DocumentInteractionUITestFixtureRoot: View {
    @State private var appModel: PathwayAppModel

    init() {
        _appModel = State(
            initialValue: PathwayAppModel(
                documentService: DocumentInteractionUITestService(),
                dashboardBootstrap: Self.bootstrap
            )
        )
    }

    var body: some View {
        NavigationStack {
            DocumentInteractiveList(documents: Self.documents)
                .navigationTitle("Documents")
        }
        .environment(appModel)
        .accessibilityIdentifier("document-interaction-test-fixture")
    }

    private static let documents: [DashboardDocument] = {
        let json = """
        [
          {
            "id": "ui-test-document-1",
            "displayId": 42,
            "title": "Quarterly Proposal",
            "subtitle": "Northwind renewal",
            "status": "creating",
            "modifiedDate": "2026-07-16T04:45:00.000Z",
            "mainRecipientFirstName": "Avery",
            "mainRecipientLastName": "Morgan",
            "mainRecipientEmail": "avery@example.com",
            "currencySymbol": "$",
            "totalValue": 12500,
            "flightStatus": "draft"
          },
          {
            "id": "ui-test-document-2",
            "displayId": 43,
            "title": "Service Agreement",
            "subtitle": "Annual support",
            "status": "sent",
            "modifiedDate": "2026-07-15T03:30:00.000Z",
            "mainRecipientFirstName": "Jordan",
            "mainRecipientLastName": "Lee",
            "mainRecipientEmail": "jordan@example.com",
            "currencySymbol": "$",
            "totalValue": 4800,
            "flightStatus": "sent"
          }
        ]
        """
        return (try? JSONDecoder().decode([DashboardDocument].self, from: Data(json.utf8))) ?? []
    }()

    private static let bootstrap: MobileDashboardBootstrap? = {
        let json = """
        {
          "userData": {
            "id": "ui-test-owner",
            "email": "owner@example.com",
            "firstName": "Corey",
            "lastName": "Baines",
            "profileImage": null,
            "profileColor": "#F15A24",
            "userType": "admin",
            "emailVerified": "2026-07-16T00:00:00.000Z",
            "isActive": true,
            "locale": "en-AU",
            "timezone": "Australia/Sydney",
            "dateFormat": "dd/MM/yyyy"
          },
          "companyData": {
            "id": "ui-test-company",
            "name": "Pathway Test Workspace",
            "isOwner": true,
            "storageLocation": "au",
            "subscriptionPlan": "business",
            "locale": "en-AU",
            "timezone": "Australia/Sydney",
            "dateFormat": "dd/MM/yyyy",
            "details": {
              "trialExpiryDate": null,
              "requireDocumentRecipient": false
            }
          },
          "permissions": {
            "manageAddressBookContacts": true,
            "searchAddressBookContacts": true,
            "manageDocumentRecipients": true,
            "canAssignDocumentOwnershipOutsideTeam": true,
            "canDeleteDocuments": true,
            "canShareDocumentAccess": true,
            "canSendDocuments": true
          },
          "companyUsers": [
            {
              "id": "ui-test-owner",
              "firstName": "Corey",
              "lastName": "Baines",
              "email": "owner@example.com",
              "profileImage": null,
              "profileColor": "#F15A24"
            },
            {
              "id": "ui-test-transferee",
              "firstName": "Alex",
              "lastName": "Morgan",
              "email": "alex@example.com",
              "profileImage": null,
              "profileColor": "#007AFF"
            }
          ],
          "assignableCompanyUsers": [
            {
              "id": "ui-test-transferee",
              "firstName": "Alex",
              "lastName": "Morgan",
              "email": "alex@example.com",
              "profileImage": null,
              "profileColor": "#007AFF"
            }
          ],
          "emailServices": [
            {
              "id": "ui-test-email-service",
              "type": "pathway",
              "email": "documents@example.com",
              "sender": "Pathway Test",
              "defaultForDocument": true
            }
          ],
          "features": {
            "userManagementAddonEnabled": true,
            "templateLibraryAddonEnabled": true,
            "contactAddressBookEnabled": true
          }
        }
        """
        return try? JSONDecoder().decode(MobileDashboardBootstrap.self, from: Data(json.utf8))
    }()
}

@MainActor
private final class DocumentInteractionUITestService: DocumentServicing {
    private var pinnedDocumentIDs: Set<String> = []

    func information(documentID: String) async throws -> DocumentInformation {
        DocumentInformation(
            id: documentID,
            displayId: 42,
            title: "Quarterly Proposal",
            subtitle: "Northwind renewal",
            status: "creating",
            source: "ui_test",
            ownerUserId: "ui-test-owner",
            ownerName: "Corey Baines",
            createdByName: "Corey Baines",
            createdAt: 1_752_643_200_000,
            updatedAt: 1_752_681_900_000,
            sentAt: nil,
            acceptedAt: nil,
            expiredAt: nil,
            renewalAt: nil,
            closedAt: nil,
            viewCount: 3,
            canEdit: true,
            editToken: "ui-test-edit-token",
            viewToken: "ui-test-view-token"
        )
    }

    func history(documentID: String) async throws -> DocumentHistoryResult {
        DocumentHistoryResult(
            success: true,
            message: nil,
            document: .init(id: documentID, displayId: 42, title: "Quarterly Proposal"),
            history: []
        )
    }

    func versions(documentID: String) async throws -> DocumentVersionsResult {
        DocumentVersionsResult(documentId: documentID, versions: [])
    }

    func recipients(documentID: String) async throws -> DocumentRecipientsResult {
        DocumentRecipientsResult(documentId: documentID, recipients: [])
    }

    func updateInformation(
        documentID: String,
        title: String?,
        subtitle: String?,
        renewalAt: Double??
    ) async throws {}

    func updateStatus(documentID: String, status: String, expiredAt: Double??) async throws {}

    func setPinned(documentID: String, pinned: Bool) async throws -> [String]? {
        if pinned {
            pinnedDocumentIDs.insert(documentID)
        } else {
            pinnedDocumentIDs.remove(documentID)
        }
        return pinnedDocumentIDs.sorted()
    }

    func archive(documentID: String) async throws {}
    func restore(documentID: String) async throws {}
    func transfer(documentID: String, ownerUserID: String) async throws {}

    func shareLinks(documentID: String) async throws -> DocumentShareLinksResult {
        DocumentShareLinksResult(
            success: true,
            reason: nil,
            documentId: documentID,
            documentTitle: "Quarterly Proposal",
            links: [:]
        )
    }

    func updateShareLink(
        documentID: String,
        key: String,
        update: DocumentShareLinkUpdate
    ) async throws -> DocumentShareLinkUpdateResult {
        DocumentShareLinkUpdateResult(
            success: true,
            reason: nil,
            key: key,
            active: update.active,
            accessMode: update.accessMode,
            documentId: documentID,
            documentTitle: "Quarterly Proposal",
            metadata: .init(
                accessLimit: update.accessLimit,
                currentAccessCount: 0,
                expireDate: update.expireAt,
                passwordActive: update.passwordActive
            )
        )
    }

    func addRecipient(documentID: String, draft: DocumentRecipientDraft) async throws {}

    func updateRecipient(
        documentID: String,
        recipientID: String,
        draft: DocumentRecipientDraft
    ) async throws {}

    func removeRecipient(documentID: String, recipientID: String) async throws {}
    func reorderRecipients(documentID: String, recipientIDs: [String]) async throws {}
    func schedulingCapability() async throws -> DocumentSchedulingCapability {
        DocumentSchedulingCapability(
            scheduledDocumentSend: true,
            canSchedule: true,
            canManageRules: true
        )
    }
    func send(documentID: String, draft: DocumentSendDraft) async throws {}
}
