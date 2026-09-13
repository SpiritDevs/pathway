import Foundation

extension PathwayQueuedThread {
    func conversationThread(detail: JSONValue) throws -> PathwayAgentThread {
        let saved = detail.objectValue?["thread"]?.objectValue ?? fields
        let first = detail.objectValue?["messages"]?.arrayValue?.first?.objectValue?["submission"]?.objectValue?["input"]?.objectValue ?? [:]
        let launch = saved["launch"]?.objectValue ?? first
        guard let selection = launch["modelSelection"] ?? first["modelSelection"] else {
            throw PathwayThreadConversationError.message("The saved conversation settings are unavailable. Try syncing again.")
        }
        let createdAt = saved["createdAt"]?.intValue.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? Date()
        let date = ISO8601DateFormatter().string(from: createdAt)
        let shell: JSONValue = .object([
            "id": .string(threadID), "projectId": saved["localProjectId"] ?? .null,
            "title": .string(title), "providerInstanceId": selection.objectValue?["instanceId"] ?? .string(""),
            "modelSelection": selection, "runtimeMode": launch["runtimeMode"] ?? .string("full-access"),
            "interactionMode": launch["interactionMode"] ?? .string("default"),
            "temporary": launch["temporary"] ?? .bool(false), "locations": launch["locations"] ?? .array([]),
            "status": .string("queued"), "hasActionableProposedPlan": .bool(false),
            "itemCount": .number(0), "visibleItemCount": .number(0),
            "createdAt": .string(date), "updatedAt": .string(date)
        ])
        return try PathwayAgentThread(companyId: companyID, environmentId: environmentID,
                                      cloudProjectId: saved["cloudProjectId"]?.stringValue,
                                      shell: JSONDecoder().decode(PathwayAgentThreadShell.self, from: JSONEncoder().encode(shell)),
                                      cloudUpdatedAt: saved["updatedAt"]?.intValue.map(Double.init) ?? createdAt.timeIntervalSince1970 * 1000)
    }
}

extension PathwayAgentThreadModel {
    /// The ordinary transcript joins cloud submissions to environment history by message identity.
    var conversationItems: [PathwayTimelineItem] {
        let received = Set(items.compactMap(\.messageID))
        let pending = cloudQueueMessages.compactMap { value -> PathwayTimelineItem? in
            guard let fields = value.objectValue,
                  let submission = fields["submission"]?.objectValue,
                  let input = submission["input"]?.objectValue else { return nil }
            let message = submission["kind"]?.stringValue == "launch" ? input["initialMessage"]?.objectValue ?? [:] : input
            guard let id = fields["messageId"]?.stringValue ?? message["messageId"]?.stringValue,
                  !received.contains(id) else { return nil }
            return PathwayTimelineItem(json: .object([
                "id": .string("queued-message:\(id)"), "messageId": .string(id), "type": .string("user_message"),
                "ordinal": .number(Double((items.last?.ordinal ?? 0) + 1)), "status": .string("completed"),
                "text": message["text"] ?? .string(""), "attachments": message["attachments"] ?? .array([]),
                "createdBy": .string("user"), "queueCommandId": fields["commandId"] ?? .null
            ]))
        }
        return items + pending
    }

    func cloudQueueMessage(for item: PathwayTimelineItem) -> [String: JSONValue]? {
        guard let id = item.fields["queueCommandId"]?.stringValue else { return nil }
        return cloudQueueMessages.first { $0.objectValue?["commandId"]?.stringValue == id }?.objectValue
    }

    func canEditCloudQueueMessage(_ item: PathwayTimelineItem) -> Bool {
        guard let message = cloudQueueMessage(for: item) else { return false }
        return message["editable"]?.boolValue == true ||
            (message["acceptedAt"] == .null && ["queued", "blocked", "canceled"].contains(message["state"]?.stringValue ?? ""))
    }

    func canCancelCloudQueueMessage(_ item: PathwayTimelineItem) -> Bool {
        guard let message = cloudQueueMessage(for: item), message["state"]?.stringValue != "canceled" else { return false }
        return canEditCloudQueueMessage(item) || (message["state"]?.stringValue == "blocked" && ["command", "initial-message"].contains(message["rejection"]?.stringValue ?? ""))
    }

    func updateCloudQueue(_ queued: PathwayQueuedThread) async {
        guard let threadQueue else { return }
        installCloudQueueDetail(queued, detail: threadQueue.cachedDetail(queued), authoritative: false)
        do {
            let detail = try await threadQueue.detail(queued)
            guard !Task.isCancelled else { return }
            installCloudQueueDetail(queued, detail: detail)
        } catch { if !Task.isCancelled { cloudQueueError = error.localizedDescription } }
    }

    func installCloudQueueDetail(_ queued: PathwayQueuedThread, detail: JSONValue, authoritative: Bool = true) {
        cloudQueuedThread = queued
        cloudQueueError = nil
        let messages = detail.objectValue?["messages"]?.arrayValue ?? []
        let incoming = Dictionary(messages.compactMap { value -> (String, JSONValue)? in
            guard let command = value.objectValue?["commandId"]?.stringValue else { return nil }
            return (command, value)
        }, uniquingKeysWith: { _, latest in latest })
        let previous = Set(cloudQueueMessages.compactMap { $0.objectValue?["commandId"]?.stringValue })
        let received = Set(items.compactMap(\.messageID))
        // Keep the existing chronological position while replacing local copies with cloud
        // copies. A delayed cloud snapshot must not move a just-sent message above its parent.
        let retained = cloudQueueMessages.compactMap { value -> JSONValue? in
            var fields = value.objectValue ?? [:]
            if let command = fields["commandId"]?.stringValue, let replacement = incoming[command] { return replacement }
            let input = fields["submission"]?.objectValue?["input"]?.objectValue ?? [:]
            let messageID = fields["messageId"]?.stringValue ?? input["messageId"]?.stringValue ?? input["initialMessage"]?.objectValue?["messageId"]?.stringValue
            if let messageID, received.contains(messageID) { return nil }
            if authoritative { fields["state"] = .string("delivered"); fields["editable"] = .bool(false) }
            return .object(fields)
        }
        cloudQueueMessages = retained + messages.filter { !previous.contains($0.objectValue?["commandId"]?.stringValue ?? "") }
        for (id, value) in detail.objectValue?["attachmentUrls"]?.objectValue ?? [:] {
            if let text = value.stringValue, let url = URL(string: text) { cloudQueueAttachmentURLs[id] = url }
        }
    }

    func loadSavedQueueProviders(using queue: PathwayThreadQueueModel, companyID: String) async {
        guard let value = try? await queue.destinations(companyID: companyID, threadID: cloudQueuedThread == nil || cloudQueuedThread?.state == "local" ? nil : threadID, environmentID: environment.environment.environmentId, queueID: cloudQueuedThread?.queueID), !Task.isCancelled, providers.isEmpty else { return }
        let target = value.arrayValue?.first { $0.objectValue?["environmentId"]?.stringValue == environment.environment.environmentId }
        providers = (target?.objectValue?["providers"]?.arrayValue ?? []).compactMap { value in
            guard let fields = value.objectValue, fields["enabled"]?.boolValue == true,
                  let id = fields["instanceId"]?.stringValue, let driver = fields["driver"]?.stringValue else { return nil }
            let models = (fields["modelIds"]?.arrayValue ?? []).compactMap { value -> PathwayServerModel? in
                guard let id = value.stringValue else { return nil }
                return PathwayServerModel(id: id, name: id, isDefault: false, optionDescriptors: [])
            }
            return PathwayServerProvider(id: id, driver: driver, name: fields["displayName"]?.stringValue ?? driver,
                                         models: models, showsInteractionMode: false)
        }
        modelCatalog = providers
    }

    func mutateCloudQueueMessage(_ item: PathwayTimelineItem, action: String, text: String? = nil, deliveryFields: [String: JSONValue] = [:]) async throws {
        guard let threadQueue, let queued = cloudQueuedThread, let message = cloudQueueMessage(for: item),
              let command = message["commandId"] else { throw PathwayThreadConversationError.message("This message has changed. Refresh the conversation before trying again.") }
        var fields: [String: JSONValue] = ["commandId": command, "revision": message["revision"] ?? .number(0)]
        fields.merge(deliveryFields) { _, new in new }
        if let text { fields["text"] = .string(text) }
        try await threadQueue.mutate(action, thread: queued, fields: fields)
        await updateCloudQueue(queued)
    }
}
