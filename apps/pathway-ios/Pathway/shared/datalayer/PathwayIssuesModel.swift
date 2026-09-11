import Foundation
import Observation

@MainActor
@Observable
final class PathwayIssuesModel {
    typealias SendOperations = @MainActor (String, JSONValue) async throws -> JSONValue
    typealias EnvironmentRequest = @MainActor (String, String?, String, JSONValue) async throws -> JSONValue
    typealias CloudRequest = @MainActor (String, String, JSONValue) async throws -> JSONValue

    private(set) var records: [PathwayIssueRecord] = []
    private(set) var statuses: [PathwayIssueEntity] = []
    private(set) var labels: [PathwayIssueEntity] = []
    private(set) var milestones: [PathwayIssueEntity] = []
    private(set) var cycles: [PathwayIssueEntity] = []
    private(set) var views: [PathwayIssueEntity] = []
    private(set) var members: [PathwayIssueEntity] = []
    private(set) var isWriting = false
    private(set) var errorMessage: String?
    private(set) var pendingChangeCount = 0
    private(set) var entities: [PathwayIssueEntity] = []
    private var liveComments: [String: PathwayIssueEntity] = [:]
    private var liveRuns: [String: PathwayIssueEntity] = [:]
    private var liveEnvironmentSettings: [String: [String: JSONValue]] = [:]
    @ObservationIgnored private var observedIssues: [String: Int] = [:]
    @ObservationIgnored private let sendOperations: SendOperations?
    @ObservationIgnored let environmentRequest: EnvironmentRequest?
    @ObservationIgnored let cloudRequest: CloudRequest?
    @ObservationIgnored private var companies: [PathwayCompany] = []
    @ObservationIgnored private var versions: [String: Int] = [:]
    @ObservationIgnored private var writesInFlight = 0
    @ObservationIgnored private var overlays: [String: [PendingIssuePatch]] = [:]
    @ObservationIgnored private var replicaRecords: [PathwayIssueRecord] = []
    @ObservationIgnored private var createdDrafts: [String: PathwayIssueRecord] = [:]
    @ObservationIgnored private var lastProjectionVersions: [String: Int] = [:]
    @ObservationIgnored private let defaults: UserDefaults

    init(
        sendOperations: SendOperations? = nil,
        environmentRequest: EnvironmentRequest? = nil,
        cloudRequest: CloudRequest? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.sendOperations = sendOperations
        self.environmentRequest = environmentRequest
        self.cloudRequest = cloudRequest
        self.defaults = defaults
        pendingChangeCount = pendingOperations.count
    }

    func replaceReplica(
        _ changesByCompany: [String: [PathwaySyncChange]],
        companies: [PathwayCompany] = [], versions: [String: Int] = [:]
    ) {
        self.companies = companies
        let visibleCompanies = Set(changesByCompany.keys)
        liveComments = liveComments.filter { visibleCompanies.contains($0.value.companyId) }
        liveRuns = liveRuns.filter { visibleCompanies.contains($0.value.companyId) }
        liveEnvironmentSettings = liveEnvironmentSettings.filter { key, _ in
            visibleCompanies.contains(key.components(separatedBy: ":").first ?? "")
        }
        self.versions = versions
        var projectionVersions: [String: Int] = [:]
        for (companyID, changes) in changesByCompany {
            for change in changes where Self.includesEntityKind(change.entityKind) {
                projectionVersions["\(companyID):\(change.entityKind):\(change.entityId)"] = change.version
            }
        }
        guard projectionVersions != lastProjectionVersions else { return }
        lastProjectionVersions = projectionVersions
        var projected: [PathwayIssueEntity] = []
        for (companyID, changes) in changesByCompany {
            for change in changes where change.changeKind != "tombstone" {
                guard Self.includesEntityKind(change.entityKind),
                      var fields = change.payload?.objectValue else { continue }
                fields["id"] = fields["id"] ?? .string(change.entityId)
                projected.append(.init(companyId: companyID, kind: change.entityKind, fields: fields))
            }
        }
        let previouslySyncedComments = Set(entities.filter { $0.kind == "issueComment" }.map(\.identity))
        let currentComments = Set(projected.filter { $0.kind == "issueComment" }.map(\.identity))
        liveComments = liveComments.filter { _, comment in
            !previouslySyncedComments.contains(comment.identity) || currentComments.contains(comment.identity)
        }
        entities = projected
        replicaRecords = projected.filter { $0.kind == "issue" }.map {
            PathwayIssueRecord(companyId: $0.companyId, fields: $0.fields)
        }
        let liveIdentities = Set(replicaRecords.map(\.identity))
        createdDrafts = createdDrafts.filter { !liveIdentities.contains($0.key) && visibleCompanies.contains($0.value.companyId) }
        var deletedSnapshots: [String: PathwayIssueEntity] = [:]
        for event in projected where event.kind == "issueAuditEvent" && event.string("kind") == "deleted_snapshot" {
            let identity = "\(event.companyId):\(event.string("issueId") ?? "")"
            if let previous = deletedSnapshots[identity], previous.createdAt > event.createdAt { continue }
            deletedSnapshots[identity] = event
        }
        for (identity, event) in deletedSnapshots where !liveIdentities.contains(identity) {
            guard let fields = event.fields["payload"]?.objectValue?["deletedIssue"]?.objectValue else { continue }
            let issue = PathwayIssueRecord(companyId: event.companyId, fields: fields)
            if issue.isDeleted && issue.id == event.string("issueId") { replicaRecords.append(issue) }
        }
        let allowedCompanies = Set(changesByCompany.keys)
        overlays = overlays.filter { entry in
            allowedCompanies.contains(entry.key.components(separatedBy: ":").first ?? "")
        }
        reconcileOverlays()
        rebuildRecords()
        statuses = project("issueStatus").compactMap { status in
            guard status.fields["hidden"]?.boolValue != true else { return nil }
            guard let baseID = status.string("baseStatusId"),
                  let base = projected.first(where: {
                      $0.companyId == status.companyId && $0.kind == "issueStatus" && $0.id == baseID
                  }) else { return status }
            var fields = base.fields
            fields.merge(status.fields.filter { $0.value != .null }) { _, next in next }
            return PathwayIssueEntity(companyId: status.companyId, kind: status.kind, fields: fields)
        }
        labels = project("issueLabel")
        milestones = project("issueMilestone")
        cycles = project("issueCycle")
        views = project("issueView")
        members = project("membership")
    }

    /// Mirrors issueComment.update/delete: native writes are member-authored, and editing one's
    /// own comment still requires its explicit grant. Team grants apply through any issue team.
    func canEditComment(_ comment: PathwayIssueEntity, issue: PathwayIssueRecord) -> Bool {
        guard comment.companyId == issue.companyId, comment.string("issueId") == issue.id,
              let company = companies.first(where: { $0.id == issue.companyId }) else { return false }
        if company.isOwner { return true }
        let author = comment.fields["author"]?.objectValue
        let ownsComment = author?["kind"]?.stringValue == "member"
            && author?["membershipId"]?.stringValue == company.membershipId
        let permission = ownsComment ? "comments.updateOwn" : "comments.moderate"
        let teamIDs = Set(issue.fields["teamIds"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        let roles = entities.filter { $0.companyId == issue.companyId && $0.kind == "role" }
        for assignment in entities where assignment.companyId == issue.companyId
            && assignment.kind == "roleAssignment" && assignment.string("membershipId") == company.membershipId {
            guard let role = roles.first(where: { $0.id == assignment.string("roleId") }),
                  role.fields["permissions"]?.arrayValue?.contains(.string(permission)) == true,
                  let scope = assignment.fields["scope"]?.objectValue else { continue }
            if scope["kind"]?.stringValue == "company" { return true }
            if scope["kind"]?.stringValue == "team", let teamID = scope["teamId"]?.stringValue,
               teamIDs.contains(teamID) { return true }
        }
        return false
    }

    private static func includesEntityKind(_ kind: String) -> Bool {
        kind.hasPrefix("issue") || kind == "membership" || kind == "role" || kind == "roleAssignment"
    }

    func detail(for issue: PathwayIssueRecord) -> PathwayIssueDetail {
        let relevant = entities.filter {
            $0.companyId == issue.companyId && ($0.string("issueId") == issue.id
                || ($0.kind == "issueRelation" && $0.string("relatedIssueId") == issue.id))
        }
        func rows(_ kind: String) -> [PathwayIssueEntity] {
            relevant.filter { $0.kind == kind }.sorted {
                if kind == "issueTodo" {
                    return ($0.string("sortOrder") ?? "", $0.id) < ($1.string("sortOrder") ?? "", $1.id)
                }
                return ($0.createdAt, $0.id) < ($1.createdAt, $1.id)
            }
        }
        var comments = Dictionary(uniqueKeysWithValues: rows("issueComment").map { ($0.id, $0) })
        for comment in liveComments.values where comment.companyId == issue.companyId && comment.string("issueId") == issue.id {
            if let synced = comments[comment.id] {
                var fields = synced.fields
                // Cloud owns body/attachments/deletion; only environment run state is overlaid.
                if let run = comment.fields["agentRun"] { fields["agentRun"] = run }
                comments[comment.id] = PathwayIssueEntity(companyId: comment.companyId, kind: comment.kind, fields: fields)
            } else { comments[comment.id] = comment }
        }
        return PathwayIssueDetail(
            todos: rows("issueTodo"), comments: comments.values.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }, relations: rows("issueRelation"),
            attachments: rows("issueAttachment"), events: rows("issueAuditEvent"),
            threadLinks: rows("issueThreadLink")
        )
    }

    func create(companyID: String, fields: [String: JSONValue]) async throws -> String {
        let id = UUID().uuidString.lowercased()
        let defaultStatus = statuses.first { $0.companyId == companyID && $0.string("scope") != "team" }
        var draftFields: [String: JSONValue] = [
            "id": .string(id), "key": .string("Draft"), "description": .string(""),
            "statusId": .string(defaultStatus?.id ?? ""), "priority": .string("none"),
            "labelIds": .array([]), "triage": .bool(false),
            "createdAt": .number(Date().timeIntervalSince1970 * 1_000),
            "updatedAt": .number(Date().timeIntervalSince1970 * 1_000)
        ]
        draftFields.merge(fields) { _, next in next }
        let draft = PathwayIssueRecord(companyId: companyID, fields: draftFields)
        createdDrafts[draft.identity] = draft
        rebuildRecords()
        do {
            _ = try await mutate(companyID: companyID, kind: "issue.create", entityID: id, args: fields)
            return id
        } catch {
            createdDrafts.removeValue(forKey: draft.identity)
            rebuildRecords()
            throw error
        }
    }

    func update(_ issue: PathwayIssueRecord, patch: [String: JSONValue]) async throws {
        try await applyIssuePatch(issue, kind: "issue.update", patch: patch)
    }

    func setSortOrder(_ issue: PathwayIssueRecord, sortOrder: String, statusID: String? = nil) async throws {
        var patch: [String: JSONValue] = ["sortOrder": .string(sortOrder)]
        if let statusID { patch["statusId"] = .string(statusID) }
        try await applyIssuePatch(issue, kind: "issue.setSortOrder", patch: patch)
    }

    private func applyIssuePatch(_ issue: PathwayIssueRecord, kind: String, patch: [String: JSONValue]) async throws {
        let revision = UUID()
        overlays[issue.identity, default: []].append(PendingIssuePatch(revision: revision, fields: patch))
        rebuildRecords()
        do {
            _ = try await mutate(companyID: issue.companyId, kind: kind, entityID: issue.id, args: patch)
        } catch {
            if let pending = overlays[issue.identity] {
                let remaining = pending.filter { $0.revision != revision }
                if remaining.isEmpty { overlays.removeValue(forKey: issue.identity) }
                else { overlays[issue.identity] = remaining }
                reconcileOverlays()
                rebuildRecords()
            }
            throw error
        }
    }

    func remove(_ issue: PathwayIssueRecord) async throws {
        _ = try await mutate(companyID: issue.companyId, kind: "issue.delete", entityID: issue.id, args: [:])
    }

    func restore(_ issue: PathwayIssueRecord) async throws {
        _ = try await mutate(companyID: issue.companyId, kind: "issue.restore", entityID: issue.id, args: [:])
    }

    func bulkUpdate(_ issues: [PathwayIssueRecord], patch: [String: JSONValue]) async throws {
        guard issues.count <= 500 else { throw PathwayIssueWriteError(message: "Select at most 500 tasks.") }
        // Preflight every company before sending the first write.
        for issue in issues { _ = try membershipID(issue.companyId) }
        for issue in issues { try await update(issue, patch: patch) }
    }

    @discardableResult
    func mutate(companyID: String, kind: String, entityID: String, args: [String: JSONValue]) async throws -> JSONValue {
        guard sendOperations != nil else {
            throw PathwayIssueWriteError(message: "Connect to Pathway before changing tasks.")
        }
        if let data = defaults.data(forKey: "pathway.issues.pendingOperations"),
           (try? JSONDecoder().decode([JSONValue].self, from: data)) == nil {
            throw PathwayIssueWriteError(message: "Saved task changes could not be read. Your pending changes have been preserved; reconnect before making another change.")
        }
        let membership = try membershipID(companyID)
        let clientID: String
        if let existing = defaults.string(forKey: "pathway.issues.clientID") { clientID = existing }
        else {
            clientID = UUID().uuidString.lowercased()
            defaults.set(clientID, forKey: "pathway.issues.clientID")
        }
        let sequence = defaults.integer(forKey: "pathway.issues.sequence") + 1
        defaults.set(sequence, forKey: "pathway.issues.sequence")
        let operation = PathwayIssueOperations.envelope(
            companyID: companyID, membershipID: membership, clientID: clientID, sequence: sequence,
            baseVersion: versions[companyID] ?? 0, kind: kind, entityID: entityID, args: args
        )
        var pending = pendingOperations
        pending.append(operation)
        savePending(pending)
        return try await submit(operation)
    }

    /// Uncertain network writes keep their original operation identity for an explicit retry.
    func retryPendingChanges() async throws {
        for operation in pendingOperations {
            let companyID = operation.objectValue?["companyId"]?.stringValue ?? ""
            guard let company = companies.first(where: { $0.id == companyID }),
                  operation.objectValue?["actor"]?.objectValue?["membershipId"]?.stringValue == company.membershipId
            else { continue }
            _ = try await submit(operation)
        }
    }

    func request(
        _ issue: PathwayIssueRecord, method: String, payload: [String: JSONValue], environmentID: String? = nil
    ) async throws -> JSONValue {
        guard let environmentRequest else {
            throw PathwayIssueWriteError(message: "Connect an environment to use this action.")
        }
        var fields = payload
        if let environmentID { fields["_environmentId"] = .string(environmentID) }
        return try await environmentRequest(issue.companyId, issue.projectId, method, .object(fields))
    }


    /// Runs while a detail/work sheet is visible. Cancellation releases its environment cache.
    func observe(_ issue: PathwayIssueRecord, environmentID: String? = nil) async {
        guard environmentRequest != nil, issue.projectId != nil else { return }
        observedIssues[issue.identity, default: 0] += 1
        defer {
            let remaining = (observedIssues[issue.identity] ?? 1) - 1
            if remaining > 0 { observedIssues[issue.identity] = remaining }
            else {
                observedIssues.removeValue(forKey: issue.identity)
                liveComments = liveComments.filter { !($0.value.companyId == issue.companyId && $0.value.string("issueId") == issue.id) }
                liveRuns = liveRuns.filter { !($0.value.companyId == issue.companyId && $0.value.string("issueId") == issue.id) }
            }
        }
        do {
            let comments = try await request(issue, method: "issues.commentsList", payload: ["issueId": .string(issue.id)], environmentID: environmentID)
            for value in comments.objectValue?["comments"]?.arrayValue ?? [] {
                guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { continue }
                let key = "\(issue.companyId):\(id)"
                if liveComments[key] == nil {
                    liveComments[key] = .init(companyId: issue.companyId, kind: "issueComment", fields: fields)
                }
            }
            let runs = try await request(issue, method: "issues.getEnrichmentRuns", payload: ["issueId": .string(issue.id)], environmentID: environmentID)
            for value in runs.objectValue?["runs"]?.arrayValue ?? [] {
                guard var fields = value.objectValue, let id = fields["id"]?.stringValue else { continue }
                if let environmentID { fields["_environmentId"] = .string(environmentID) }
                let key = "\(issue.companyId):\(id)"
                if liveRuns[key] == nil {
                    liveRuns[key] = .init(companyId: issue.companyId, kind: "enrichmentRun", fields: fields)
                }
            }
        } catch is CancellationError { return }
        catch {
            // The company replica already supplies issue content. Optional environment updates
            // may be unavailable; explicit investigation/work requests report their own failures.
        }
        // AsyncStream suspends without polling and its iterator terminates on task cancellation.
        let lifetime = AsyncStream<Void> { _ in }
        for await _ in lifetime { }
    }

    func enrichmentRuns(for issue: PathwayIssueRecord, environmentID: String? = nil) -> [PathwayIssueEntity] {
        liveRuns.values.filter {
            $0.companyId == issue.companyId && $0.string("issueId") == issue.id
                && (environmentID == nil || $0.string("_environmentId") == nil || $0.string("_environmentId") == environmentID)
        }.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    }

    func environmentState(companyID: String, environmentID: String) -> [String: JSONValue] {
        liveEnvironmentSettings["\(companyID):\(environmentID)"] ?? [:]
    }

    func receiveEnvironmentEvent(companyID: String, environmentID: String, event: JSONValue) {
        guard let fields = event.objectValue, let tag = fields["_tag"]?.stringValue else { return }
        let settingField: String? = switch tag {
        case "SlackWatchesChanged": "slackWatches"
        case "SlackStatusChanged": "slackStatus"
        case "ConfigChanged": "config"
        default: nil
        }
        if let settingField {
            let payloadKey = tag == "SlackWatchesChanged" ? "watches" : (tag == "SlackStatusChanged" ? "status" : "config")
            liveEnvironmentSettings["\(companyID):\(environmentID)", default: [:]][settingField] = fields[payloadKey]
            return
        }
        let value = fields[tag == "EnrichmentRunChanged" ? "run" : "comment"]?.objectValue
        if tag == "IssueCommentDeleted", let commentID = fields["commentId"]?.stringValue {
            liveComments.removeValue(forKey: "\(companyID):\(commentID)")
            return
        }
        guard var value, let issueID = value["issueId"]?.stringValue,
              let id = value["id"]?.stringValue, observedIssues["\(companyID):\(issueID)"] != nil else { return }
        if tag == "EnrichmentRunChanged" {
            value["_environmentId"] = .string(environmentID)
            liveRuns["\(companyID):\(id)"] = .init(companyId: companyID, kind: "enrichmentRun", fields: value)
        } else if tag == "IssueCommentUpserted" {
            liveComments["\(companyID):\(id)"] = .init(companyId: companyID, kind: "issueComment", fields: value)
        }
    }

    func clearError() { errorMessage = nil }

    private func project(_ kind: String) -> [PathwayIssueEntity] {
        entities.filter { $0.kind == kind }.sorted {
            ($0.position, $0.name, $0.id) < ($1.position, $1.name, $1.id)
        }
    }

    /// A replica may confirm an earlier write while a newer edit is still pending. Retire only
    /// the confirmed prefix; retaining each write separately lets any failed write roll back alone.
    private func reconcileOverlays() {
        for record in replicaRecords {
            guard let pending = overlays[record.identity] else { continue }
            var combined: [String: JSONValue] = [:]
            var confirmedCount = 0
            for (index, patch) in pending.enumerated() {
                combined.merge(patch.fields) { _, next in next }
                if combined.allSatisfy({ record.fields[$0.key] == $0.value }) {
                    confirmedCount = index + 1
                }
            }
            if confirmedCount == pending.count { overlays.removeValue(forKey: record.identity) }
            else if confirmedCount > 0 { overlays[record.identity] = Array(pending.dropFirst(confirmedCount)) }
        }
    }

    private struct PendingIssuePatch {
        let revision: UUID
        let fields: [String: JSONValue]
    }

    private func rebuildRecords() {
        records = (replicaRecords + Array(createdDrafts.values)).map { record in
            guard let pending = overlays[record.identity] else { return record }
            var fields = record.fields
            for patch in pending { fields.merge(patch.fields) { _, next in next } }
            return PathwayIssueRecord(companyId: record.companyId, fields: fields)
        }.sorted { ($0.sortOrder, $0.identity) < ($1.sortOrder, $1.identity) }
    }

    private func membershipID(_ companyID: String) throws -> String {
        guard let company = companies.first(where: { $0.id == companyID }) else {
            throw PathwayIssueWriteError(message: "Choose a connected company before changing tasks.")
        }
        return company.membershipId
    }

    private var pendingOperations: [JSONValue] {
        guard let data = defaults.data(forKey: "pathway.issues.pendingOperations"),
              let value = try? JSONDecoder().decode([JSONValue].self, from: data) else { return [] }
        return value
    }

    private func savePending(_ values: [JSONValue]) {
        defaults.set(try? JSONEncoder().encode(values), forKey: "pathway.issues.pendingOperations")
        pendingChangeCount = values.count
    }

    private func submit(_ operation: JSONValue) async throws -> JSONValue {
        guard let sendOperations, let fields = operation.objectValue,
              let companyID = fields["companyId"]?.stringValue else {
            throw PathwayIssueWriteError(message: "Pathway cannot submit this change yet.")
        }
        writesInFlight += 1
        isWriting = true
        defer { writesInFlight -= 1; isWriting = writesInFlight > 0 }
        do {
            let response = try await sendOperations(companyID, .array([operation]))
            // A received receipt is terminal, including a rejection. Only uncertain transport
            // failures stay queued, so retries can never mint a second issue or comment.
            if response.objectValue?["receipts"]?.arrayValue?.count == 1 {
                savePending(pendingOperations.filter { $0.objectValue?["operationId"] != fields["operationId"] })
            }
            try PathwayIssueOperations.validateReceipts(response, expectedCount: 1)
            errorMessage = nil
            return response
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }
}
