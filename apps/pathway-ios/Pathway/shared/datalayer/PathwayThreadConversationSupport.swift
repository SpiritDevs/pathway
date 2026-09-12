import CryptoKit
import Foundation
import UniformTypeIdentifiers

enum PathwayThreadConversationError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case let .message(value): value } }
}

struct PathwayThreadRun: Equatable, Identifiable, Sendable {
    let id: String
    let fields: [String: JSONValue]
    var ordinal: Int { fields["ordinal"]?.intValue ?? 0 }
    var status: String { fields["status"]?.stringValue ?? "completed" }
    var isActive: Bool { ["preparing", "starting", "running", "waiting"].contains(status) }
    var isSettled: Bool { ["completed", "interrupted", "failed", "cancelled", "rolled_back"].contains(status) }
    var startedAt: Date? { fields["startedAt"]?.stringValue.flatMap(pathwayDate(from:)) }
    var completedAt: Date? { fields["completedAt"]?.stringValue.flatMap(pathwayDate(from:)) }
    var userMessageID: String? { fields["userMessageId"]?.stringValue }
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
        self.id = id; self.fields = fields
    }
}

struct PathwayThreadSubagent: Equatable, Identifiable, Sendable {
    let id: String
    let fields: [String: JSONValue]
    var childThreadID: String? { fields["childThreadId"]?.stringValue }
    var title: String { fields["title"]?.stringValue ?? "Subagent" }
    var model: String? { fields["model"]?.stringValue }
    var status: String { fields["status"]?.stringValue ?? "pending" }
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
        self.id = id; self.fields = fields
    }
}

struct PathwayThreadCachePendingWrite: Sendable {
    let items: [PathwayTimelineItem]
    let revision: UInt64
}

struct PathwayThreadPreparedSend: Codable, Sendable {
    let ids: [String]
    let messageID: String
    let text: String
    let requestedMode: String
    var attachments: [JSONValue]
    var attachmentsPrepared = false
    let dispatchMode: JSONValue
}

struct PathwayThreadPreparedNewSend: Codable, Sendable {
    let target: String
    let messageID: String
    let sideChat: Bool
    let ids: [String]
    let text: String
    let modelSelection: PathwayModelSelection
    let runtimeMode: String
    let interactionMode: String
    var attachments: [JSONValue]
    var attachmentsPrepared = false
    var forkCreated = false
}

struct PathwayThreadAttachmentDraft: Codable, Identifiable, Equatable, Sendable {
    enum State: Codable, Equatable, Sendable { case uploading, ready, failed(String) }
    let id: String
    let name: String
    let mimeType: String
    let type: String
    let sizeBytes: Int
    var state: State
    var attachment: PathwayMessageAttachment?
    var previewData: Data?
}

extension PathwayMessageAttachment {
    var json: JSONValue {
        var fields: [String: JSONValue] = ["id": .string(id), "type": .string(type), "name": .string(name), "mimeType": .string(mimeType), "sizeBytes": .number(Double(sizeBytes))]
        if let source { fields["source"] = source }
        return .object(fields)
    }
}

extension PathwayAgentThreadModel {
    func installServerConfig(_ value: JSONValue) {
        let object = value.objectValue ?? [:]
        serverConfig = object
        let capabilities = object["environment"]?.objectValue?["capabilities"]?.objectValue ?? [:]
        supportsAttachmentUploads = threadQueue != nil || capabilities["attachmentUploads"]?.boolValue == true
        maximumFileAttachmentBytes = threadQueue != nil ? 50 * 1024 * 1024 : (supportsAttachmentUploads ? capabilities["fileAttachments"]?.objectValue?["maxUploadBytes"]?.intValue : nil)
        let providerValues = object["providers"]?.arrayValue ?? []
        modelCatalog = providerValues.compactMap(Self.provider)
        providers = modelCatalog.filter { $0.unavailableReason == nil && !$0.models.isEmpty }
    }

    static func provider(_ value: JSONValue) -> PathwayServerProvider? {
        guard let object = value.objectValue, let id = object["instanceId"]?.stringValue,
              let driver = object["driver"]?.stringValue else { return nil }
        let reason: String?
        if object["availability"]?.stringValue == "unavailable" { reason = object["unavailableReason"]?.stringValue ?? "Not set up" }
        else if object["installed"]?.boolValue != true { reason = "Not installed" }
        else if object["enabled"]?.boolValue != true { reason = "Disabled" }
        else if object["auth"]?.objectValue?["status"]?.stringValue == "unauthenticated" { reason = "Sign in required" }
        else { reason = nil }
        let models = (object["models"]?.arrayValue ?? []).compactMap { value -> PathwayServerModel? in
            guard let model = value.objectValue, let id = model["slug"]?.stringValue, let name = model["name"]?.stringValue else { return nil }
            let options = (model["capabilities"]?.objectValue?["optionDescriptors"]?.arrayValue ?? []).compactMap { value -> PathwayProviderOptionDescriptor? in
                guard let option = value.objectValue, let id = option["id"]?.stringValue, let label = option["label"]?.stringValue, let type = option["type"]?.stringValue else { return nil }
                let choices = (option["options"]?.arrayValue ?? []).compactMap { value -> PathwayProviderOptionChoice? in
                    guard let choice = value.objectValue, let id = choice["id"]?.stringValue, let label = choice["label"]?.stringValue else { return nil }
                    return PathwayProviderOptionChoice(id: id, label: label, isDefault: choice["isDefault"]?.boolValue ?? false)
                }
                return PathwayProviderOptionDescriptor(id: id, label: label, type: type, choices: choices, currentValue: option["currentValue"])
            }
            return PathwayServerModel(id: id, name: name, isDefault: model["isDefault"]?.boolValue ?? false, optionDescriptors: options)
        }
        return PathwayServerProvider(id: id, driver: driver, name: object["displayName"]?.stringValue ?? driver, models: models,
                                     showsInteractionMode: object["showInteractionModeToggle"]?.boolValue ?? false, unavailableReason: reason)
    }

    func makeChildModel(threadID: String) async throws -> PathwayAgentThreadModel {
        let projection = try await request("orchestration.getThreadProjection", payload: .object(["threadId": .string(threadID)]))
        guard var raw = projection.objectValue?["thread"]?.objectValue, raw["id"]?.stringValue == threadID else {
            throw PathwayThreadConversationError.message("The thread could not be found in this environment.")
        }
        // AppThread has the full conversation state; older servers omit shell-only summaries.
        let defaults: [String: JSONValue] = ["hasActionableProposedPlan": .bool(false), "itemCount": .number(0), "visibleItemCount": .number(0), "status": .string("idle")]
        for (key, value) in defaults where raw[key] == nil { raw[key] = value }
        let shell = try JSONDecoder().decode(PathwayAgentThreadShell.self, from: JSONEncoder().encode(JSONValue.object(raw)))
        let child = PathwayAgentThread(companyId: thread.companyId, environmentId: thread.environmentId,
                                       cloudProjectId: thread.cloudProjectId, shell: shell, cloudUpdatedAt: thread.cloudUpdatedAt)
        let model: PathwayAgentThreadModel
        if let connect { model = PathwayAgentThreadModel(thread: child, environment: environment, connect: connect, cache: cache, storageDirectory: storageDirectory) }
        else if let injectedRequest { model = PathwayAgentThreadModel(thread: child, environment: environment, request: injectedRequest) }
        else { throw PathwayThreadConversationError.message("Connect to the environment to open this thread.") }
        model.threadQueue = threadQueue
        model.installSnapshot(projection)
        model.providers = providers
        model.supportsAttachmentUploads = supportsAttachmentUploads
        model.maximumFileAttachmentBytes = maximumFileAttachmentBytes
        model.isParentRosterLoading = false
        if let roster = subagents.first(where: { $0.childThreadID == threadID }) {
            model.childRoster = roster
            model.parentModelSelection = currentModelSelection
            model.isProviderNativeChild = roster.fields["origin"]?.stringValue == "provider_native"
            if shell.modelSelection == currentModelSelection {
                let options = roster.fields["options"].flatMap { try? JSONDecoder().decode([PathwayModelOption].self, from: JSONEncoder().encode($0)) }
                model.currentModelSelection = PathwayModelSelection(instanceId: shell.providerInstanceId,
                    model: roster.model ?? shell.modelSelection.model, options: options ?? shell.modelSelection.options)
            }
        }
        return model
    }

    func addAttachment(fileURL: URL) async {
        let reader = Task.detached(priority: .userInitiated) {
            let access = fileURL.startAccessingSecurityScopedResource()
            defer { if access { fileURL.stopAccessingSecurityScopedResource() } }
            try Task.checkCancellation()
            let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 50 * 1024 * 1024 else { throw PathwayThreadConversationError.message("Choose a file under 50 MB.") }
            let data = try Data(contentsOf: fileURL)
            try Task.checkCancellation()
            return data
        }
        do {
            let data = try await withTaskCancellationHandler { try await reader.value } onCancel: { reader.cancel() }
            await addAttachment(data: data, name: fileURL.lastPathComponent,
                mimeType: UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
        } catch is CancellationError { return }
        catch { actionError = error.localizedDescription }
    }

    func addAttachment(data: Data, name: String, mimeType: String) async {
        let type = mimeType.hasPrefix("image/") ? "image" : "file"
        guard supportsAttachmentUploads, type == "image" || maximumFileAttachmentBytes != nil else {
            actionError = "This environment does not support uploading this file type."; return
        }
        if type == "file", data.count > (maximumFileAttachmentBytes ?? 0) {
            actionError = "This file exceeds the environment's upload limit."; return
        }
        guard draftAttachments.count < 8 else { actionError = "You can attach up to 8 files."; return }
        guard !data.isEmpty, data.count <= (type == "image" ? 10 : 50) * 1024 * 1024 else {
            actionError = type == "image" ? "Choose an image under 10 MB." : "Choose a file under 50 MB."; return
        }
        let id = UUID().uuidString
        draftAttachments.append(PathwayThreadAttachmentDraft(id: id, name: String(name.prefix(255)), mimeType: mimeType,
            type: type, sizeBytes: data.count, state: threadQueue != nil ? .ready : .uploading, previewData: type == "image" ? data : nil))
        attachmentData[id] = data
        await persistDraftNow()
        if threadQueue == nil { await retryAttachment(id: id) }
    }

    func retryAttachment(id: String) async {
        preparedSend = nil
        guard let index = draftAttachments.firstIndex(where: { $0.id == id }), let data = attachmentData[id] else { return }
        if threadQueue != nil { draftAttachments[index].state = .ready; actionError = nil; await persistDraftNow(); return }
        draftAttachments[index].state = .uploading
        let draft = draftAttachments[index]
        var uploadedID: String?
        do {
            let value = try await request("attachments.createUploadUrl", payload: .object(["name": .string(draft.name),
                "type": .string(draft.type), "mimeType": .string(draft.mimeType), "sizeBytes": .number(Double(draft.sizeBytes))]))
            guard let object = value.objectValue, let attachmentID = object["attachmentId"]?.stringValue,
                  let relative = object["relativeUrl"]?.stringValue else { throw PathwayThreadConversationError.message("The upload URL was unavailable.") }
            uploadedID = attachmentID
            guard let connect else { throw PathwayRPCError.disconnected }
            var request = try await connect.authenticatedRequest(environment: environment, method: "PUT", path: relative)
            request.setValue(draft.mimeType, forHTTPHeaderField: "Content-Type")
            let (_, response) = try await URLSession.shared.upload(for: request, from: data)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                throw PathwayThreadConversationError.message("The file could not be uploaded. Try again.")
            }
            guard let index = draftAttachments.firstIndex(where: { $0.id == id }) else {
                _ = try? await self.request("attachments.delete", payload: .object(["attachmentId": .string(attachmentID)])); return
            }
            draftAttachments[index].attachment = PathwayMessageAttachment(id: attachmentID, type: draft.type, name: draft.name, mimeType: draft.mimeType, sizeBytes: data.count)
            draftAttachments[index].state = .ready
        } catch {
            if let uploadedID { _ = try? await request("attachments.delete", payload: .object(["attachmentId": .string(uploadedID)])) }
            if let index = draftAttachments.firstIndex(where: { $0.id == id }) { draftAttachments[index].state = .failed(error.localizedDescription) }
        }
        await persistDraftNow()
    }

    func removeAttachment(id: String) async {
        let attachmentID = draftAttachments.first(where: { $0.id == id })?.attachment?.id
        draftAttachments.removeAll { $0.id == id }; attachmentData.removeValue(forKey: id)
        await persistDraftNow()
        if let attachmentID { _ = try? await request("attachments.delete", payload: .object(["attachmentId": .string(attachmentID)])) }
    }

    func markdownImageURL(_ path: String, threadID: String) async throws -> URL {
        guard let connect else { throw PathwayThreadConversationError.message("Connect to the environment to access images.") }
        return try await PathwayEnvironmentHTTP.assetURL(path, threadID: threadID, environment: environment, connect: connect) { [self] method, payload in
            try await request(method, payload: payload, reportsErrors: false)
        }
    }

    func attachmentURL(_ attachment: PathwayMessageAttachment) async throws -> URL {
        if let url = cloudQueueAttachmentURLs[attachment.id] { return url }
        let value = try await request("assets.createUrl", payload: .object(["resource": .object([
            "_tag": .string("attachment"), "attachmentId": .string(attachment.id), "fileName": .string(attachment.name), "mimeType": .string(attachment.mimeType)
        ])]), reportsErrors: false)
        guard let relative = value.objectValue?["relativeUrl"]?.stringValue else { throw PathwayThreadConversationError.message("The attachment URL was unavailable.") }
        return try await resolveAssetURL(relative)
    }
    private func resolveAssetURL(_ relative: String) async throws -> URL {
        guard let connect else { throw PathwayThreadConversationError.message("Connect to the environment to access files.") }
        let base = try await connect.prepare(environment: environment).httpBaseURL
        guard let url = URL(string: relative, relativeTo: base)?.absoluteURL,
              url.scheme == base.scheme, url.host == base.host, url.port == base.port else {
            throw PathwayThreadConversationError.message("The environment returned an invalid file URL.")
        }
        return url
    }

    var queuedRuns: [PathwayThreadRun] { runs.filter { $0.status == "queued" }.sorted {
        ($0.fields["queuePosition"]?.intValue ?? $0.ordinal) < ($1.fields["queuePosition"]?.intValue ?? $1.ordinal)
    } }
    func cancelQueuedRun(_ runID: String) async throws { try await dispatch("queued-run.cancel", fields: ["runId": .string(runID)]) }
    func editQueuedRun(_ runID: String, text: String) async throws { try await dispatch("queued-run.edit", fields: ["runId": .string(runID), "text": .string(text)]) }
    func reorderQueuedRun(_ runID: String, beforeRunID: String?) async throws {
        try await dispatch("queued-run.reorder", fields: ["runId": .string(runID), "beforeRunId": beforeRunID.map(JSONValue.string) ?? .null])
    }
    func steerQueuedRun(_ runID: String) async throws {
        guard let activeRunID else { throw PathwayThreadConversationError.message("There is no active turn to steer.") }
        try await dispatch("queued-message.promote-to-steer", fields: ["queuedRunId": .string(runID), "targetRunId": .string(activeRunID)])
    }
    func rollbackCheckpoint(_ checkpointID: String, scopeID: String) async throws {
        guard checkpoints.contains(where: { $0.objectValue?["id"]?.stringValue == checkpointID && $0.objectValue?["scopeId"]?.stringValue == scopeID && $0.objectValue?["status"]?.stringValue == "ready" }) else {
            throw PathwayThreadConversationError.message("This checkpoint is not ready to restore.")
        }
        try await dispatch("checkpoint.rollback", fields: ["checkpointId": .string(checkpointID), "scopeId": .string(scopeID)])
    }
    func turnDiff(from: Int, to: Int) async throws -> String {
        let value = try await request("orchestration.getTurnDiff", payload: .object(["threadId": .string(threadID), "fromTurnCount": .number(Double(from)), "toTurnCount": .number(Double(to))]))
        return value.objectValue?["diff"]?.stringValue ?? ""
    }
}


extension PathwayAgentThreadModel {
    static func preservingMessageContext(original: String, edited: String) -> String {
        let pattern = #"\n*<(terminal_context|element_context|issue_context|preview_annotation|review_comment)\b"#
        guard let range = original.range(of: pattern, options: .regularExpression) else { return edited }
        let suffix = String(original[range.lowerBound...])
        return edited.hasSuffix(suffix) ? edited : edited + suffix
    }

    func implementPlan(_ item: PathwayTimelineItem) async throws {
        let planID = item.fields["planId"]?.stringValue
        guard activeRunID == nil, !isSending, let planID,
              let plan = plans.first(where: { $0.objectValue?["id"]?.stringValue == planID })?.objectValue,
              plan["kind"]?.stringValue == "proposed_plan", plan["status"]?.stringValue == "active",
              let markdown = plan["markdown"]?.stringValue else {
            throw PathwayThreadConversationError.message("This plan is no longer available to implement.")
        }
        isSending = true
        defer { isSending = false }
        if let threadQueue {
            // A plan has one implementation command, including after navigation or restart.
            let identity = try JSONEncoder().encode([thread.companyId, threadID, planID])
            let identifier = "implement-plan-" + SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
            var command = PathwayAgentThreadCommands.dispatchMessage(threadID: threadID,
                text: "PLEASE IMPLEMENT THIS PLAN:\n" + markdown.trimmingCharacters(in: .whitespacesAndNewlines),
                hasActiveRun: false, identifier: identifier).objectValue ?? [:]
            command["modelSelection"] = try Self.json(currentModelSelection)
            command["sourcePlanRef"] = .object(["threadId": .string(threadID), "planId": .string(planID)])
            try await threadQueue.enqueue(companyID: thread.companyId, environmentID: environment.environment.environmentId,
                threadID: threadID, submission: .object(["kind": .string("message"), "input": .object(command),
                    "runtimeMode": .string(runtimeMode), "interactionMode": .string("default")]))
            return
        }
        try await setInteractionMode("default")
        try await dispatch("message.dispatch", fields: ["createdBy": .string("user"), "creationSource": .string("mobile"),
            "messageId": .string(UUID().uuidString), "text": .string("PLEASE IMPLEMENT THIS PLAN:\n" + markdown.trimmingCharacters(in: .whitespacesAndNewlines)),
            "attachments": .array([]), "dispatchMode": .object(["type": .string("start_immediately")]),
            "sourcePlanRef": .object(["threadId": .string(threadID), "planId": .string(planID)])])
    }
    func canRecoverWorkspacePreparation(_ item: PathwayTimelineItem) -> Bool {
        guard item.type == "command_execution", item.status == "failed",
              item.fields["threadId"]?.stringValue == threadID,
              let runID = item.runID, let run = runs.max(by: { $0.ordinal < $1.ordinal }),
              run.id == runID, run.status == "failed",
              let preparation = item.fields["workspacePreparation"]?.objectValue else { return false }
        return preparation["workspaceKind"]?.stringValue == "worktree"
            && ["preparing", "worktree"].contains(preparation["phase"]?.stringValue ?? "")
    }

    func controlWorkspacePreparation(action: String, runID: String? = nil) async throws {
        guard let targetRunID = runID ?? activeRunID, ["cancel", "work_locally", "retry"].contains(action) else {
            throw PathwayThreadConversationError.message("This workspace preparation is unavailable.")
        }
        _ = try await request("orchestration.controlWorkspacePreparation", payload: .object([
            "commandId": .string(UUID().uuidString), "threadId": .string(threadID), "runId": .string(targetRunID), "action": .string(action)]), requiresSubscription: true)
    }
}


extension PathwayAgentThreadModel {
    func applyChildRosterSelection() {
        guard let roster = childRoster, roster.childThreadID == threadID, currentModelSelection == parentModelSelection else { return }
        let options = roster.fields["options"].flatMap { try? JSONDecoder().decode([PathwayModelOption].self, from: JSONEncoder().encode($0)) }
        currentModelSelection = PathwayModelSelection(instanceId: currentModelSelection.instanceId,
            model: roster.model ?? currentModelSelection.model, options: options ?? currentModelSelection.options)
    }
    var canStartSideChat: Bool { !thread.shell.isTemporary && runs.contains { $0.status == "completed" } }
    func startDraftInNewThread(sideChat: Bool) async throws -> String {
        guard !thread.shell.isTemporary else {
            throw PathwayThreadConversationError.message("Keep conversation before starting another chat from this workspace.")
        }
        guard canSend else { throw PathwayThreadConversationError.message("Finish preparing the message before starting a chat.") }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = draftAttachments
        isSending = true
        defer { isSending = false }
        let ids = selected.map(\.id)
        let sameAttempt = preparedNewSend?.ids == ids && preparedNewSend?.sideChat == sideChat
            && preparedNewSend?.text == text && preparedNewSend?.modelSelection == currentModelSelection
            && preparedNewSend?.runtimeMode == runtimeMode && preparedNewSend?.interactionMode == interactionMode
        if !sameAttempt {
            preparedNewSend = PathwayThreadPreparedNewSend(target: UUID().uuidString, messageID: UUID().uuidString,
                sideChat: sideChat, ids: ids, text: text, modelSelection: currentModelSelection,
                runtimeMode: runtimeMode, interactionMode: interactionMode, attachments: [])
        }
        guard let transaction = preparedNewSend else { throw PathwayThreadConversationError.message("The message could not be prepared.") }
        await persistDraftNow()
        if let threadQueue {
            let files = try selected.map { try PathwayQueueFile.capture($0, bytes: attachmentData[$0.id]) }
            var submission: JSONValue
            if sideChat {
                guard let run = runs.filter({ $0.status == "completed" }).max(by: { $0.ordinal < $1.ordinal }) else {
                    throw PathwayThreadConversationError.message("Finish a turn before starting a side chat.")
                }
                if !transaction.forkCreated {
                    try await dispatch("thread.fork", fields: ["commandId": .string(transaction.target),
                        "sourceThreadId": .string(threadID), "targetThreadId": .string(transaction.target),
                        "sourcePoint": .object(["type": .string("run"), "runId": .string(run.id)]), "forkKind": .string("side_chat"),
                        "title": .string(threadTitle + " side chat"), "createdBy": .string("user"), "creationSource": .string("mobile")])
                    preparedNewSend?.forkCreated = true
                    await persistDraftNow()
                }
                var command = PathwayAgentThreadCommands.dispatchMessage(threadID: transaction.target,
                    text: text, hasActiveRun: false, identifier: transaction.messageID).objectValue ?? [:]
                command["modelSelection"] = try Self.json(transaction.modelSelection)
                submission = .object(["kind": .string("message"), "input": .object(command),
                    "runtimeMode": .string(transaction.runtimeMode), "interactionMode": .string(transaction.interactionMode)])
            } else {
                var workspace: [String: JSONValue] = ["type": .string("root")]
                if let path = thread.shell.worktreePath { workspace = ["type": .string("existing_worktree"), "worktreePath": .string(path)] }
                if let branch = thread.shell.branch { workspace["branch"] = .string(branch) }
                submission = .object(["kind": .string("launch"), "input": .object([
                    "commandId": .string(transaction.target), "creationSource": .string("mobile"),
                    "threadId": .string(transaction.target), "projectId": thread.shell.projectId.map(JSONValue.string) ?? .null,
                    "conversationCompanyId": thread.shell.conversationCompanyId.map(JSONValue.string) ?? .null,
                    "title": .string(String(text.prefix(100)).isEmpty ? "New chat" : String(text.prefix(100))), "generateTitle": .bool(true),
                    "modelSelection": try Self.json(transaction.modelSelection), "runtimeMode": .string(transaction.runtimeMode),
                    "interactionMode": .string(transaction.interactionMode), "locations": .array([.string("agents")]),
                    "workspaceStrategy": .object(workspace), "initialMessage": .object(["messageId": .string(transaction.messageID),
                        "text": .string(text), "attachments": .array([])])])])
            }
            try await threadQueue.enqueue(companyID: thread.companyId, environmentID: environment.environment.environmentId,
                threadID: transaction.target, submission: submission, files: files)
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            preparedNewSend = nil
            let sentIDs = Set(ids)
            draftAttachments.removeAll { sentIDs.contains($0.id) }
            for id in sentIDs { attachmentData.removeValue(forKey: id) }
            await persistDraftNow()
            return transaction.target
        }
        if !transaction.attachmentsPrepared {
            var attachments: [JSONValue] = []
            if !selected.isEmpty {
                let pending = draftAttachments.filter { ids.contains($0.id) }
                guard pending.count == ids.count, pending.allSatisfy({ $0.state == .ready }) else {
                    throw PathwayThreadConversationError.message("Finish uploading the attachments before starting a chat.")
                }
                let result = try await request("assets.persistChatAttachments", payload: .object([
                    "threadId": .string(transaction.target), "messageId": .string(transaction.messageID),
                    "attachments": .array(pending.compactMap { $0.attachment?.json })]))
                attachments = result.objectValue?["attachments"]?.arrayValue ?? []
                guard attachments.count == selected.count else { throw PathwayThreadConversationError.message("The attachments could not be prepared.") }
            }
            preparedNewSend?.attachments = attachments
            preparedNewSend?.attachmentsPrepared = true
            await persistDraftNow()
        }
        guard let prepared = preparedNewSend else { throw PathwayThreadConversationError.message("The message could not be prepared.") }
        let target = prepared.target
        let messageID = prepared.messageID
        let attachments = prepared.attachments
        if sideChat {
            guard let run = runs.filter({ $0.status == "completed" }).max(by: { $0.ordinal < $1.ordinal }) else {
                throw PathwayThreadConversationError.message("Finish a turn before starting a side chat.")
            }
            if !prepared.forkCreated {
                try await dispatch("thread.fork", fields: ["commandId": .string(target), "sourceThreadId": .string(threadID), "targetThreadId": .string(target),
                "sourcePoint": .object(["type": .string("run"), "runId": .string(run.id)]), "forkKind": .string("side_chat"),
                "title": .string(threadTitle + " side chat"), "createdBy": .string("user"), "creationSource": .string("mobile")])
                preparedNewSend?.forkCreated = true
                await persistDraftNow()
            }
            try await dispatch("thread.model-selection.set", fields: ["threadId": .string(target), "modelSelection": try Self.json(currentModelSelection)])
            try await dispatch("message.dispatch", fields: ["commandId": .string(messageID), "threadId": .string(target), "createdBy": .string("user"), "creationSource": .string("mobile"),
                "messageId": .string(messageID), "text": .string(text), "attachments": .array(attachments), "dispatchMode": .object(["type": .string("start_immediately")])])
        } else {
            var workspace: [String: JSONValue] = ["type": .string("root")]
            if let path = thread.shell.worktreePath { workspace = ["type": .string("existing_worktree"), "worktreePath": .string(path)] }
            if let branch = thread.shell.branch { workspace["branch"] = .string(branch) }
            _ = try await request("orchestration.launchThread", payload: .object(["commandId": .string(target), "creationSource": .string("mobile"),
                "threadId": .string(target), "reuseExistingThread": .bool(false), "projectId": thread.shell.projectId.map(JSONValue.string) ?? .null,
                "conversationCompanyId": thread.shell.conversationCompanyId.map(JSONValue.string) ?? .null,
                "title": .string(String(text.prefix(100)).isEmpty ? "New chat" : String(text.prefix(100))), "generateTitle": .bool(true),
                "modelSelection": try Self.json(currentModelSelection), "runtimeMode": .string(runtimeMode), "interactionMode": .string(interactionMode),
                "locations": .array([.string("agents")]), "workspaceStrategy": .object(workspace),
                "initialMessage": .object(["messageId": .string(messageID), "text": .string(text), "attachments": .array(attachments)])]), requiresSubscription: true)
        }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
        preparedNewSend = nil
        let sentIDs = Set(selected.map(\.id))
        draftAttachments.removeAll { sentIDs.contains($0.id) }
        for id in sentIDs { attachmentData.removeValue(forKey: id) }
        await persistDraftNow()
        return target
    }
}


extension PathwayAgentThreadModel {
    func refreshServerConfig() async {
        do { installServerConfig(try await request("server.getConfig", payload: .object([:]), reportsErrors: false)) }
        catch { /* Keep the last usable provider list while temporarily disconnected. */ }
    }
    func refreshParentRoster() async {
        guard thread.shell.lineage?.relationshipToParent == "subagent", let parentID = thread.shell.lineage?.parentThreadId else {
            isParentRosterLoading = false; return
        }
        do {
            let projection = try await request("orchestration.getThreadProjection", payload: .object(["threadId": .string(parentID)]), reportsErrors: false)
            installParentProjection(projection)
        } catch { isParentRosterLoading = false }
    }
    func installParentProjection(_ value: JSONValue) {
        isParentRosterLoading = false
        guard let object = value.objectValue else { return }
        let roster = (object["subagents"]?.arrayValue ?? []).compactMap(PathwayThreadSubagent.init).first { $0.childThreadID == threadID }
        childRoster = roster
        isProviderNativeChild = roster?.fields["origin"]?.stringValue == "provider_native"
        parentModelSelection = object["thread"]?.objectValue?["modelSelection"].flatMap {
            try? JSONDecoder().decode(PathwayModelSelection.self, from: JSONEncoder().encode($0))
        }
        applyChildRosterSelection()
    }
}
