import CryptoKit
import Foundation

extension PathwayIssuesModel {
    func uploadAttachment(
        _ issue: PathwayIssueRecord, data: Data, mimeType: String, fileName: String
    ) async throws -> String {
        guard let cloudRequest else {
            throw PathwayIssueWriteError(message: "Connect to Pathway to upload attachments.")
        }
        let checksum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let result = try await cloudRequest("action", "issueAttachments:prepareUpload", .object([
            "companyId": .string(issue.companyId), "issueId": .string(issue.id),
            "uploads": .array([.object([
                "clientRequestId": .string(UUID().uuidString.lowercased()),
                "fileName": .string(fileName), "mimeType": .string(mimeType),
                "byteSize": .number(Double(data.count)), "checksum": .string(checksum)
            ])])
        ]))
        guard let prepared = result.arrayValue?.first?.objectValue,
              let attachmentID = prepared["attachmentId"]?.stringValue else {
            throw PathwayIssueWriteError(message: "Pathway could not prepare this attachment.")
        }
        if prepared["state"]?.stringValue == "upload-required" {
            guard let rawURL = prepared["uploadUrl"]?.stringValue, let url = URL(string: rawURL),
                  url.scheme == "https" else {
                throw PathwayIssueWriteError(message: "Pathway returned an invalid attachment upload URL.")
            }
            let boundary = UUID().uuidString
            let safeName = fileName.replacingOccurrences(of: "\"", with: "_")
                .replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
            let safeType = mimeType.contains("\r") || mimeType.contains("\n") ? "application/octet-stream" : mimeType
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(safeType)\r\n\r\n".utf8)
            body.append(data)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            let (_, response) = try await URLSession.shared.upload(for: request, from: body)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw PathwayIssueWriteError(message: "The attachment upload failed. Please try again.")
            }
            _ = try await cloudRequest("action", "issueAttachments:finalizeUpload", .object([
                "companyId": .string(issue.companyId), "attachmentId": .string(attachmentID)
            ]))
        }
        return attachmentID
    }

    func attachmentURL(_ issue: PathwayIssueRecord, attachmentID: String) async throws -> URL {
        guard let cloudRequest else {
            throw PathwayIssueWriteError(message: "Connect to Pathway to open attachments.")
        }
        let result = try await cloudRequest("query", "issueAttachments:urls", .object([
            "companyId": .string(issue.companyId), "issueId": .string(issue.id),
            "attachmentIds": .array([.string(attachmentID)])
        ]))
        guard let value = result.arrayValue?.first?.objectValue?["url"]?.stringValue,
              let url = URL(string: value), url.scheme == "https" else {
            throw PathwayIssueWriteError(message: "This attachment is not available yet.")
        }
        return url
    }
}
