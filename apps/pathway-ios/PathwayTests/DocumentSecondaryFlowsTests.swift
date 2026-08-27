import Foundation
import Testing
@testable import Pathway

@Suite("Document secondary flows")
struct DocumentSecondaryFlowsTests {
    @Test("Recipient parsing accepts comma semicolon and newline separators")
    func parsesRecipients() {
        #expect(DocumentSendValidation.emailAddresses(
            from: "one@example.com; two@example.com\nthree@example.com"
        ) == ["one@example.com", "two@example.com", "three@example.com"])
    }

    @Test("Send validation reports malformed recipients")
    func validatesRecipients() {
        let draft = DocumentSendDraft(
            to: ["not-an-email"],
            cc: [],
            subject: "Proposal",
            htmlBody: "<p>Hello</p>",
            attachPDF: true,
            attachments: [],
            expiredAt: nil,
            savePeriod: false,
            serviceId: nil
        )
        #expect(DocumentSendValidation.validationMessage(for: draft) == "Check the recipient email addresses.")
    }

    @Test("Send validation enforces the fifteen megabyte attachment limit")
    func validatesAttachmentLimit() {
        let attachment = DocumentEmailAttachment(
            fileName: "large.pdf",
            contentType: "application/pdf",
            size: DocumentSendValidation.maximumAttachmentBytes + 1,
            localURL: URL(fileURLWithPath: "/tmp/large.pdf")
        )
        let draft = DocumentSendDraft(
            to: ["recipient@example.com"],
            cc: [],
            subject: "Proposal",
            htmlBody: "<p>Hello</p>",
            attachPDF: false,
            attachments: [attachment],
            expiredAt: nil,
            savePeriod: false,
            serviceId: nil
        )
        #expect(DocumentSendValidation.validationMessage(for: draft) == "Attachments must total 15 MB or less.")
    }

    @Test("Scheduled sends enforce the server timing window")
    func validatesScheduledSendWindow() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var draft = DocumentSendDraft(
            to: ["recipient@example.com"],
            cc: [],
            subject: "Proposal",
            htmlBody: "<p>Hello</p>",
            attachPDF: true,
            attachments: [],
            expiredAt: nil,
            savePeriod: false,
            serviceId: nil,
            scheduledAt: now.addingTimeInterval(60).timeIntervalSince1970 * 1_000,
            timeZone: "Australia/Sydney"
        )
        #expect(DocumentSendValidation.validationMessage(for: draft, now: now) ==
            "Schedule the send for at least five minutes from now.")

        draft.scheduledAt = now.addingTimeInterval(10 * 60).timeIntervalSince1970 * 1_000
        #expect(DocumentSendValidation.validationMessage(for: draft, now: now) == nil)
    }

    @Test("Share link metadata decodes the backend expireDate contract")
    func decodesShareLink() throws {
        let data = Data(#"""
        {
          "success": true,
          "documentId": "doc-1",
          "documentTitle": "Proposal",
          "links": {
            "general": {
              "key": "secure-key",
              "active": true,
              "accessMode": "view_only",
              "metadata": {
                "accessLimit": 4,
                "currentAccessCount": 1,
                "expireDate": 1780000000000,
                "passwordActive": true
              }
            }
          }
        }
        """#.utf8)
        let result = try JSONDecoder().decode(DocumentShareLinksResult.self, from: data)
        #expect(result.links?["general"]?.accessMode == .viewOnly)
        #expect(result.links?["general"]?.metadata.expireDate == 1_780_000_000_000)
    }
}
