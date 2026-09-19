import Foundation
@testable import Pathway
import Testing

@MainActor struct PathwayBugReportTests {
    @Test func diagnosticsExcludePayloadsAndBoundHistory() throws {
        let diagnostics = PathwayDiagnostics()
        let now = Date()
        diagnostics.record("old", outcome: "failed", now: now.addingTimeInterval(-901))
        for _ in 0...PathwayDiagnostics.maximumEvents {
            diagnostics.record("tasks.read", outcome: "failed", error: NSError(domain: "NSURLErrorDomain", code: -1009,
                userInfo: [NSLocalizedDescriptionKey: "Bearer secret-token https://example.com/?token=secret"]), now: now)
        }
        let data = try diagnostics.snapshot(context: ["screen": "tasks"], now: now)
        let text = String(decoding: data, as: UTF8.self)
        let snapshot = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(data.count <= PathwayDiagnostics.maximumBytes)
        #expect((snapshot["events"] as? [Any])?.count == PathwayDiagnostics.maximumEvents)
        #expect(snapshot["truncated"] as? Bool == true)
        #expect(!text.contains("secret"))
        #expect(!text.contains("https"))
        #expect(!text.contains("\"old\""))
        #expect(PathwayDiagnostics.identifier("Bearer credential") == "omitted")
    }

    @Test func draftRestoresIdentityAndSeparatesAccounts() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let reports = PathwayBugReportModel()
        reports.configure(directory: directory)
        try reports.setDestination(companyID: "company", projectID: "project")
        reports.begin(screenshot: nil, device: "Test device")
        reports.draft?.description = "Composer stopped responding"
        try reports.persist()
        let restored = PathwayBugReportModel()
        restored.configure(directory: directory)
        #expect(restored.draft == reports.draft)
        #expect(restored.draft?.investigate == false)
        #expect(restored.draft?.includeChat == false)
        #expect(restored.targetProjectID == "project")
        restored.configure(directory: nil)
        #expect(restored.draft == nil)
        #expect(restored.targetProjectID.isEmpty)
    }

    @Test func retryAfterUncertainCreateReusesTaskAndOperation() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        var operations: [JSONValue] = []
        let issues = PathwayIssuesModel(sendOperations: { _, payload in
            operations.append(payload.arrayValue![0])
            if operations.count == 1 { throw URLError(.networkConnectionLost) }
            return .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, cloudRequest: { _, name, _ in
            #expect(name == "issueAttachments:prepareUpload")
            return .array([.object(["attachmentId": .string("diagnostics"), "state": .string("ready")])])
        }, defaults: defaults)
        issues.replaceReplica(["company": []], companies: [.init(id: "company", membershipId: "member", name: "Company",
            workspaceKind: "company", issueKeyPrefix: "PAT", lifecycleState: "active", syncVersion: 1, isOwner: true)])
        let reports = PathwayBugReportModel()
        reports.configure(directory: directory)
        try reports.setDestination(companyID: "company", projectID: "project")
        reports.begin(screenshot: nil, device: "Test")
        reports.draft?.description = "Connection dropped"
        let identity = reports.draft?.id
        await reports.submit(using: issues)
        #expect(reports.error != nil)
        let restored = PathwayBugReportModel()
        restored.configure(directory: directory)
        await restored.submit(using: issues)
        #expect(restored.draft?.id == identity)
        #expect(restored.draft?.evidenceSaved == true)
        #expect(operations.count == 3)
        #expect(operations[0] == operations[1])
        #expect(operations[2].objectValue?["kind"] == .string("issueComment.create"))
    }

    @Test func investigationFailurePreservesSavedReport() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let issues = PathwayIssuesModel(sendOperations: { _, _ in
            .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, environmentRequest: { _, _, _, _ in throw URLError(.notConnectedToInternet) }, cloudRequest: { _, _, _ in
            .array([.object(["attachmentId": .string("diagnostics"), "state": .string("ready")])])
        }, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        issues.replaceReplica(["company": []], companies: [.init(id: "company", membershipId: "member", name: "Company",
            workspaceKind: "company", issueKeyPrefix: "PAT", lifecycleState: "active", syncVersion: 1, isOwner: true)])
        let reports = PathwayBugReportModel()
        reports.configure(directory: directory)
        try reports.setDestination(companyID: "company", projectID: "project")
        reports.begin(screenshot: nil, device: "Test")
        reports.draft?.description = "Task list is empty"
        reports.draft?.investigate = true
        reports.draft?.modelSelection = .object(["instanceId": .string("codex"), "model": .string("example")])
        await reports.submit(using: issues)
        #expect(reports.draft?.evidenceSaved == true)
        #expect(reports.draft?.investigationStarted == false)
        #expect(reports.error == nil)
        #expect(reports.notice?.contains("Report saved") == true)
    }

    @Test func rejectedDestinationCanBeCorrectedAndUsesProjectTeams() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var operations: [JSONValue] = []
        let issues = PathwayIssuesModel(sendOperations: { _, payload in
            operations.append(payload.arrayValue![0])
            return .object(["receipts": .array([.object([
                "status": .string("rejected"), "code": .string("permission-denied"), "message": .string("Choose another project.")
            ])])])
        }, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        issues.replaceReplica(["company": []], companies: [.init(id: "company", membershipId: "member", name: "Company",
            workspaceKind: "company", issueKeyPrefix: "PAT", lifecycleState: "active", syncVersion: 1, isOwner: true)])
        let reports = PathwayBugReportModel()
        reports.configure(directory: directory)
        try reports.setDestination(companyID: "company", projectID: "project")
        reports.begin(screenshot: nil, device: "Test")
        reports.draft?.description = "Connection failed"
        await reports.submit(using: issues, project: .init(id: "project", name: "Pathway", description: "", archivedAt: nil,
            teamIds: ["team"], defaultWorkflowOwner: .object(["kind": .string("team"), "teamId": .string("workflow-team")])))
        #expect(operations[0].objectValue?["args"]?.objectValue?["teamIds"] == .array([.string("team"), .string("workflow-team")]))
        #expect(reports.draft?.createAttempted == false)
        #expect(reports.draft?.taskSaved == false)
        try reports.setDestination(companyID: "company", projectID: "accessible-project")
        #expect(reports.draft?.projectID == "accessible-project")
        #expect(reports.draft?.description == "Connection failed")
    }

    @Test func failedEvidenceUploadResumesWithoutAnotherTask() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var operations: [JSONValue] = []
        var uploads: [JSONValue] = []
        let issues = PathwayIssuesModel(sendOperations: { _, payload in
            operations.append(payload.arrayValue![0])
            return .object(["receipts": .array([.object(["status": .string("accepted")])])])
        }, cloudRequest: { _, _, args in
            uploads.append(args)
            if uploads.count == 1 { throw URLError(.networkConnectionLost) }
            return .array([.object(["attachmentId": .string("diagnostics"), "state": .string("ready")])])
        }, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        issues.replaceReplica(["company": []], companies: [.init(id: "company", membershipId: "member", name: "Company",
            workspaceKind: "company", issueKeyPrefix: "PAT", lifecycleState: "active", syncVersion: 1, isOwner: true)])
        let reports = PathwayBugReportModel()
        reports.configure(directory: directory)
        try reports.setDestination(companyID: "company", projectID: "project")
        reports.begin(screenshot: nil, device: "Test")
        reports.draft?.description = "Screen froze"
        await reports.submit(using: issues)
        #expect(reports.draft?.taskSaved == true)
        #expect(reports.draft?.evidenceSaved == false)
        let restored = PathwayBugReportModel()
        restored.configure(directory: directory)
        await restored.submit(using: issues)
        #expect(restored.draft?.evidenceSaved == true)
        #expect(operations.map { $0.objectValue?["kind"]?.stringValue } == ["issue.create", "issueComment.create"])
        #expect(uploads[0] == uploads[1])
    }
}
