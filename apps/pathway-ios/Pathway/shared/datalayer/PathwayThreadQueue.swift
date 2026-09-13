import Foundation

extension PathwayAgentThreadModel {
    func queuedMessage(for run: PathwayThreadRun) -> PathwayTimelineItem? {
        items.first { $0.isUserMessage && ($0.runID == run.id || ($0.messageID != nil && $0.messageID == run.userMessageID)) }
    }

    func canRestoreQueuedMessage(_ run: PathwayThreadRun) -> Bool {
        guard let message = queuedMessage(for: run) else { return false }
        return !message.isGeneratedQuestionReply && message.fields["createdBy"]?.stringValue != "agent"
    }

    var cloudQueuedItems: [PathwayTimelineItem] {
        conversationItems.filter { item in
            guard let message = cloudQueueMessage(for: item) else { return false }
            return !["canceled", "delivered"].contains(message["state"]?.stringValue ?? "")
        }
    }

    var queuedMessageCount: Int { queuedRuns.count + cloudQueuedItems.count }

    /// Pending messages live in the queue sheet until they start, rather than filling the transcript.
    var transcriptItems: [PathwayTimelineItem] {
        let pending = runs.filter { $0.status == "queued" || $0.status == "cancelled" }
        let runIDs = Set(pending.map(\.id))
        let messageIDs = Set(pending.compactMap(\.userMessageID))
        return conversationItems.filter { item in
            item.fields["queueCommandId"] == nil && (!item.isUserMessage || !(item.runID.map(runIDs.contains) == true || item.messageID.map(messageIDs.contains) == true))
        }
    }

    /// Load attachments before cancelling so a failed download leaves the queued message intact.
    func restoreQueuedMessage(_ runID: String) async throws {
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draftAttachments.isEmpty, !isSending else {
            throw PathwayThreadConversationError.message("Send or stash your current draft before editing a queued message.")
        }
        guard let run = queuedRuns.first(where: { $0.id == runID }), canRestoreQueuedMessage(run),
              let message = queuedMessage(for: run) else {
            throw PathwayThreadConversationError.message("This message is no longer available to edit.")
        }
        try await restoreQueueDraft(message) { try await self.cancelQueuedRun(runID) }
    }

    func restoreCloudQueuedMessage(_ message: PathwayTimelineItem) async throws {
        guard canEditCloudQueueMessage(message), canCancelCloudQueueMessage(message) else {
            throw PathwayThreadConversationError.message("This message is no longer available to edit.")
        }
        try await restoreQueueDraft(message) { try await self.mutateCloudQueueMessage(message, action: "cancel") }
    }

    private func restoreQueueDraft(_ message: PathwayTimelineItem, cancel: () async throws -> Void) async throws {
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draftAttachments.isEmpty, !isSending else {
            throw PathwayThreadConversationError.message("Send or stash your current draft before editing a queued message.")
        }
        var restored: [(PathwayThreadAttachmentDraft, Data)] = []
        for attachment in message.attachments {
            let url = try await attachmentURL(attachment)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                  data.count == attachment.sizeBytes else {
                throw PathwayThreadConversationError.message("Could not load \(attachment.name). The message is still queued.")
            }
            var draft = PathwayThreadAttachmentDraft(id: UUID().uuidString, name: attachment.name,
                mimeType: attachment.mimeType, type: attachment.type, sizeBytes: data.count,
                state: .uploading, previewData: attachment.type == "image" ? data : nil)
            draft.source = attachment.source
            restored.append((draft, data))
        }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draftAttachments.isEmpty, !isSending else {
            throw PathwayThreadConversationError.message("Send or stash your current draft before editing a queued message.")
        }
        try await cancel()
        // Keep content typed on another task while cancellation was in flight.
        draft = draft.isEmpty ? message.text ?? "" : (message.text ?? "") + "\n\n" + draft
        preparedSend = nil
        for (attachment, bytes) in restored {
            attachmentData[attachment.id] = bytes
            draftAttachments.append(attachment)
        }
        await persistDraftNow()
        Task {
            for (attachment, _) in restored { await retryAttachment(id: attachment.id) }
        }
    }
}
