import Foundation

extension PathwayAgentThreadModel {
    func queuedMessage(for run: PathwayThreadRun) -> PathwayTimelineItem? {
        items.first { $0.isUserMessage && ($0.runID == run.id || ($0.messageID != nil && $0.messageID == run.userMessageID)) }
    }

    func canRestoreQueuedMessage(_ run: PathwayThreadRun) -> Bool {
        guard let message = queuedMessage(for: run) else { return false }
        return !message.isGeneratedQuestionReply && message.fields["createdBy"]?.stringValue != "agent"
    }

    /// Pending messages live in the queue sheet until they start, rather than filling the transcript.
    var transcriptItems: [PathwayTimelineItem] {
        let queued = runs.filter { $0.status == "queued" }
        let cancelled = runs.filter { $0.status == "cancelled" }
        guard !queued.isEmpty || !cancelled.isEmpty else { return items }
        let queuedRunIDs = Set(queued.map(\.id))
        let queuedMessageIDs = Set(queued.compactMap(\.userMessageID))
        let cancelledRunIDs = Set(cancelled.map(\.id))
        let cancelledMessageIDs = Set(cancelled.compactMap(\.userMessageID))
        return items.filter { item in
            guard item.isUserMessage else { return true }
            if item.runID.map(queuedRunIDs.contains) == true || item.messageID.map(queuedMessageIDs.contains) == true { return false }
            let wasQueued = item.fields["inputIntent"]?.stringValue == "queued_turn"
            let isCancelled = item.runID.map(cancelledRunIDs.contains) == true || item.messageID.map(cancelledMessageIDs.contains) == true
            return !(wasQueued && isCancelled)
        }
    }

    /// Call only after the user acknowledges that the original message may still run.
    func keepQueuedEditAsNewDraft() async throws {
        guard !isRestoringQueuedMessage, let pending = pendingQueuedEditRunID, let store = draftStore else { return }
        isRestoringQueuedMessage = true
        defer { isRestoringQueuedMessage = false }
        pendingQueuedEditRunID = nil
        do { try await store.save(draftSnapshot()) }
        catch { pendingQueuedEditRunID = pending; throw error }
        for attachment in draftAttachments where attachment.state != .ready {
            await retryAttachment(id: attachment.id)
        }
    }

    /// A saved edit remains fenced until cancellation is acknowledged or observed in the snapshot.
    func reconcileQueuedEdit() async {
        guard !isRestoringQueuedMessage, let runID = pendingQueuedEditRunID,
              runs.first(where: { $0.id == runID })?.status == "cancelled" else { return }
        pendingQueuedEditRunID = nil
        await persistDraftNow()
        for attachment in draftAttachments where attachment.state != .ready {
            await retryAttachment(id: attachment.id)
        }
    }

    /// Download to disk and commit the recovery draft before sending the destructive cancellation.
    func restoreQueuedMessage(_ runID: String) async throws {
        guard !isRestoringQueuedMessage else { return }
        isRestoringQueuedMessage = true
        defer {
            isRestoringQueuedMessage = false
            Task { await reconcileQueuedEdit() }
        }
        if pendingQueuedEditRunID == runID {
            try await cancelQueuedRun(runID)
            pendingQueuedEditRunID = nil
            await persistDraftNow()
            for attachment in draftAttachments { await retryAttachment(id: attachment.id) }
            return
        }
        guard pendingQueuedEditRunID == nil,
              draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draftAttachments.isEmpty, !isSending else {
            throw PathwayThreadConversationError.message("Send or stash your current draft before editing a queued message.")
        }
        guard let store = draftStore,
              let run = queuedRuns.first(where: { $0.id == runID }), canRestoreQueuedMessage(run),
              let message = queuedMessage(for: run) else {
            throw PathwayThreadConversationError.message("This message is no longer available to edit or cannot be saved on this device.")
        }
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var restored: [PathwayThreadAttachmentDraft] = []
        for attachment in message.attachments {
            let url = try await attachmentURL(attachment)
            let (temporary, response) = try await URLSession.shared.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporary) }
            let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                  size == attachment.sizeBytes else {
                throw PathwayThreadConversationError.message("Could not load \(attachment.name). The message is still queued.")
            }
            let id = UUID().uuidString
            let local = directory.appending(path: id)
            try FileManager.default.moveItem(at: temporary, to: local)
            var attachmentDraft = PathwayThreadAttachmentDraft(id: id, name: attachment.name,
                mimeType: attachment.mimeType, type: attachment.type, sizeBytes: attachment.sizeBytes,
                state: .uploading, previewData: nil)
            attachmentDraft.source = attachment.source
            attachmentDraft.localFileURL = local
            restored.append(attachmentDraft)
        }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, draftAttachments.isEmpty, !isSending else {
            throw PathwayThreadConversationError.message("Send or stash your current draft before editing a queued message.")
        }
        // This throwing write is the cancellation prerequisite, unlike best-effort draft autosave.
        let saved = try await store.saveQueuedEdit(PathwayConversationDraftSnapshot(text: message.text ?? "", attachments: restored,
            data: [:], preparedSend: nil, preparedNewSend: nil, revision: DispatchTime.now().uptimeNanoseconds,
            pendingQueuedEditRunID: runID))
        pendingQueuedEditRunID = runID
        draft = draft.isEmpty ? saved.text : saved.text + "\n\n" + draft
        draftAttachments.append(contentsOf: saved.attachments)
        preparedSend = nil
        try await store.save(draftSnapshot())
        do { try await cancelQueuedRun(runID) }
        catch {
            actionError = "Your edit is saved. Waiting to confirm cancellation before it can be sent again."
            throw error
        }
        pendingQueuedEditRunID = nil
        await persistDraftNow()
        for attachment in restored { await retryAttachment(id: attachment.id) }
    }
}
