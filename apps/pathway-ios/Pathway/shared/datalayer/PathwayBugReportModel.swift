import Foundation
import Observation

struct PathwayBugReportDraft: Codable, Equatable {
    var id = UUID().uuidString.lowercased()
    var commentID = UUID().uuidString.lowercased()
    var companyID = ""
    var projectID = ""
    var description = ""
    var includeScreenshot = false
    var includeChat = false
    var investigate = false
    var modelSelection: JSONValue = .object([:])
    var createAttempted = false
    var taskSaved = false
    var evidenceSaved = false
    var investigationAttempted = false
    var investigationStarted = false
    var uploaded: [String: String] = [:]

    var title: String {
        let firstLine = description.split(whereSeparator: \.isNewline).first.map(String.init) ?? description
        return "Bug: " + String(firstLine.trimmingCharacters(in: .whitespacesAndNewlines).prefix(180))
    }
}

@MainActor @Observable
final class PathwayBugReportModel {
    var draft: PathwayBugReportDraft?
    var error: String?
    var notice: String?
    private(set) var busy = false
    private(set) var targetCompanyID = ""
    private(set) var targetProjectID = ""
    var shakeEnabled: Bool {
        didSet { defaults.set(!shakeEnabled, forKey: "pathway.bugReport.shakeDisabled") }
    }
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var directory: URL?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored var screen = ""
    @ObservationIgnored var threadContext: [String: String] = [:]
    @ObservationIgnored var taskContext: [String: String] = [:]
    @ObservationIgnored var chatSnapshot: (() -> String)?
    @ObservationIgnored var screenshot: Data?
    @ObservationIgnored private var chat: String?
    @ObservationIgnored private var diagnosticTextCache: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        shakeEnabled = !defaults.bool(forKey: "pathway.bugReport.shakeDisabled")
    }

    func configure(directory accountDirectory: URL?) {
        let next = accountDirectory?.appending(path: "BugReports", directoryHint: .isDirectory)
        guard directory != next else { return }
        generation = UUID()
        busy = false
        directory = next
        draft = nil; error = nil; notice = nil; screenshot = nil; chat = nil
        diagnosticTextCache = nil
        threadContext = [:]; taskContext = [:]; chatSnapshot = nil
        targetCompanyID = ""; targetProjectID = ""
        guard let next else { return }
        do {
            try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true)
            if let data = try? Data(contentsOf: next.appending(path: "destination.json")),
               let target = try? JSONDecoder().decode([String: String].self, from: data) {
                targetCompanyID = target["companyID"] ?? ""; targetProjectID = target["projectID"] ?? ""
            }
            let file = next.appending(path: "draft.json")
            if FileManager.default.fileExists(atPath: file.path) {
                draft = try JSONDecoder().decode(PathwayBugReportDraft.self, from: Data(contentsOf: file))
                screenshot = try? Data(contentsOf: next.appending(path: "screenshot.jpg"))
                chat = try? String(contentsOf: next.appending(path: "chat.txt"), encoding: .utf8)
            }
        } catch { self.error = "The saved bug report could not be read. Its files have been preserved. \(error.localizedDescription)" }
    }

    func setDestination(companyID: String, projectID: String) throws {
        try write(JSONEncoder().encode(["companyID": companyID, "projectID": projectID]), name: "destination.json")
        targetCompanyID = companyID; targetProjectID = projectID
        if draft?.createAttempted == false {
            if draft?.companyID != companyID || draft?.projectID != projectID { draft?.modelSelection = .object([:]) }
            draft?.companyID = companyID; draft?.projectID = projectID
            try persist()
        }
    }

    func begin(screenshot: Data?, device: String) {
        guard draft == nil, error == nil, directory != nil else { return }
        do {
            var context = threadContext
            context.merge(taskContext) { _, task in task }
            context["screen"] = screen; context["device"] = device
            try write(PathwayDiagnostics.shared.snapshot(context: context), name: "diagnostics.json")
            self.screenshot = screenshot
            chat = chatSnapshot.map {
                let full = $0()
                return String(full.prefix(60_000)) + (full.count > 60_000 ? "\n[Remaining conversation omitted]" : "")
            }
            var next = PathwayBugReportDraft()
            next.companyID = targetCompanyID; next.projectID = targetProjectID
            draft = next
            try persist()
        } catch { self.error = error.localizedDescription }
    }

    var hasChat: Bool { chat?.isEmpty == false }
    var diagnosticSummary: String { "Recent Pathway logs, app and device versions, connection failures, and screen context. Credentials and request bodies are excluded." }
    func diagnosticText() -> String {
        if let diagnosticTextCache { return diagnosticTextCache }
        let text = (try? read("diagnostics.json")).flatMap { String(data: $0, encoding: .utf8) } ?? "Diagnostics unavailable."
        diagnosticTextCache = text
        return text
    }
    func chatText() -> String { chat ?? "" }

    func persist() throws {
        guard let draft else { return }
        try write(JSONEncoder().encode(draft), name: "draft.json")
    }

    func retainAttachments() throws {
        if draft?.includeScreenshot == true, let screenshot { try write(screenshot, name: "screenshot.jpg") }
        if draft?.includeChat == true, let chat { try write(Data(chat.utf8), name: "chat.txt") }
        try persist()
    }

    func replaceScreenshot(_ data: Data) throws {
        guard !busy, draft?.createAttempted == false else { return }
        screenshot = data; draft?.includeScreenshot = true
        try retainAttachments()
    }

    func discard() throws {
        guard !busy else { return }
        for file in ["draft.json", "diagnostics.json", "screenshot.jpg", "chat.txt"] {
            if let url = directory?.appending(path: file), FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
        draft = nil; screenshot = nil; chat = nil; error = nil; notice = nil
        diagnosticTextCache = nil
    }

    func submit(using model: PathwayIssuesModel, project: PathwayCloudProject? = nil) async {
        guard !busy, var report = draft, !report.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !report.companyID.isEmpty, !report.projectID.isEmpty else { return }
        busy = true; error = nil; notice = nil
        let session = generation
        defer { if session == generation { busy = false } }
        do {
            try retainAttachments()
            var teamIDs = project?.teamIds ?? []
            if let owner = project?.defaultWorkflowOwner?.objectValue, owner["kind"]?.stringValue == "team",
               let teamID = owner["teamId"]?.stringValue, !teamIDs.contains(teamID) { teamIDs.append(teamID) }
            let fields: [String: JSONValue] = [
                "title": .string(report.title), "description": .string("\(report.description)\n\nReported from the Pathway Apple app. Diagnostic evidence is attached in the comments."),
                "projectId": .string(report.projectID), "priority": .string("none"),
                "teamIds": .array(teamIDs.map(JSONValue.string))
            ]
            if !report.taskSaved {
                report.createAttempted = true; draft = report; try persist()
                if !model.records.contains(where: { $0.companyId == report.companyID && $0.id == report.id }) {
                    _ = try await model.mutateOnce(companyID: report.companyID, kind: "issue.create", entityID: report.id, args: fields)
                }
                guard session == generation else { return }
                report.taskSaved = true; draft = report; try persist()
            }
            var issueFields = fields; issueFields["id"] = .string(report.id)
            let issue = PathwayIssueRecord(companyId: report.companyID, fields: issueFields)
            if !report.evidenceSaved {
                var files = [("pathway-diagnostics.json", "application/json", try read("diagnostics.json"))]
                if report.includeScreenshot { files.append(("screenshot.jpg", "image/jpeg", try read("screenshot.jpg"))) }
                if report.includeChat { files.append(("pathway-conversation.txt", "text/plain", try read("chat.txt"))) }
                for (name, mimeType, data) in files where report.uploaded[name] == nil {
                    let id = try await model.uploadAttachment(issue, data: data, mimeType: mimeType, fileName: name,
                                                              clientRequestID: "\(report.id):\(name)")
                    guard session == generation else { return }
                    report.uploaded[name] = id; draft = report; try persist()
                }
                if !model.detail(for: issue).comments.contains(where: { $0.id == report.commentID }) {
                    _ = try await model.mutateOnce(companyID: report.companyID, kind: "issueComment.create", entityID: report.commentID,
                        args: ["issueId": .string(report.id), "body": .string("Phone diagnostics captured when this report was opened. Optional attachments are included only when selected by the reporter."),
                               "attachmentIds": .array(report.uploaded.sorted { $0.key < $1.key }.map { .string($0.value) })])
                }
                guard session == generation else { return }
                report.evidenceSaved = true; draft = report; try persist()
            }
            if report.investigate && !report.investigationStarted {
                do {
                    if report.investigationAttempted {
                        let previous = try await model.request(issue, method: "issues.getEnrichmentRuns", payload: ["issueId": .string(report.id)])
                        if previous.objectValue?["runs"]?.arrayValue?.isEmpty == false {
                            report.investigationStarted = true
                        }
                    }
                    if !report.investigationStarted {
                        guard pathwayIssueModelSelectionIsValid(report.modelSelection) else {
                            throw PathwayIssueWriteError(message: "Choose an available investigation model from the task when its environment is connected.")
                        }
                        report.investigationAttempted = true; draft = report; try persist()
                        _ = try await model.request(issue, method: "issues.startEnrichment",
                            payload: ["issueId": .string(report.id), "modelSelection": report.modelSelection])
                        report.investigationStarted = true
                    }
                    guard session == generation else { return }
                    draft = report; try persist()
                } catch {
                    guard session == generation else { return }
                    notice = "Report saved. Investigation could not start: \(error.localizedDescription) Open the task to start or retry later."
                    return
                }
            }
            notice = report.investigationStarted ? "Report saved. Investigation started." : "Report saved."
        } catch {
            guard session == generation else { return }
            if !report.taskSaved, let code = (error as? PathwayIssueWriteError)?.rejectionCode,
               ["not-a-member", "permission-denied", "company-unavailable", "entity-not-found"].contains(code) {
                report.createAttempted = false; draft = report
                try? persist()
            }
            self.error = report.taskSaved ? "The task is saved, but its evidence is incomplete. Retry to finish this report. \(error.localizedDescription)" : error.localizedDescription
        }
    }

    private func write(_ data: Data, name: String) throws {
        guard let directory else { throw PathwayIssueWriteError(message: "Sign in before reporting a bug.") }
        try data.write(to: directory.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func read(_ name: String) throws -> Data {
        guard let directory else { throw PathwayIssueWriteError(message: "Sign in before reporting a bug.") }
        return try Data(contentsOf: directory.appending(path: name))
    }
}
