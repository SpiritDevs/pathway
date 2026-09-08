import Foundation
import Observation
import UniformTypeIdentifiers

enum PathwayThreadConnectionState: Equatable, Sendable {
    case idle
    case connecting
    case live
    case cached
    case failed(String)
}

struct PathwayThreadQuestion: Codable, Equatable, Identifiable, Sendable {
    struct Option: Codable, Equatable, Sendable {
        let label: String
        let description: String
    }

    let id: String
    let header: String
    let question: String
    let options: [Option]
    var isOther: Bool? = nil
    var isSecret: Bool? = nil
    var multiSelect: Bool? = nil
}

struct PathwayQuestionDraft {
    var selected: [String: Set<String>] = [:]
    var custom: [String: String] = [:]
    var questionIndex = 0
}

struct PathwayMessageAttachment: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let type: String
    let name: String
    let mimeType: String
    let sizeBytes: Int
}

struct PathwayTimelineItem: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let ordinal: Int
    let type: String
    let status: String
    let title: String?
    let text: String?
    let streaming: Bool
    let requestID: String?
    let requestKind: String?
    let fileName: String?
    let additions: Int?
    let deletions: Int?
    let exitCode: Int?
    let attachments: [PathwayMessageAttachment]
    let questions: [PathwayThreadQuestion]
    var rawFields: [String: JSONValue]? = nil
    var fields: [String: JSONValue] { rawFields ?? [:] }
    var runID: String? { fields["runId"]?.stringValue }
    var messageID: String? { fields["messageId"]?.stringValue }
    var parentItemID: String? { fields["parentItemId"]?.stringValue }
    var childThreadID: String? { fields["childThreadId"]?.stringValue ?? fields["targetThreadId"]?.stringValue }
    var startedAt: Date? { fields["startedAt"]?.stringValue.flatMap(pathwayDate(from:)) }
    var completedAt: Date? { fields["completedAt"]?.stringValue.flatMap(pathwayDate(from:)) }
    var updatedAt: Date? { fields["updatedAt"]?.stringValue.flatMap(pathwayDate(from:)) }

    var isConversation: Bool {
        type == "user_message" || type == "assistant_message"
    }

    var isUserMessage: Bool { type == "user_message" }
    var isGeneratedQuestionReply: Bool {
        isUserMessage && PathwayQuestionReply.isGenerated(messageID: messageID, creationSource: fields["creationSource"]?.stringValue)
    }
    var questionReply: PathwayQuestionReply? {
        guard isUserMessage else { return nil }
        return PathwayQuestionReply(text: text, messageID: messageID, creationSource: fields["creationSource"]?.stringValue)
    }
    var requiresResponse: Bool {
        status == "waiting" && (type == "approval_request" || type == "user_input_request")
    }

    init?(json: JSONValue) {
        guard
            let object = json.objectValue,
            let id = object["id"]?.stringValue,
            let type = object["type"]?.stringValue
        else { return nil }
        self.id = id
        rawFields = object
        ordinal = object["ordinal"]?.intValue ?? 0
        self.type = type
        status = object["status"]?.stringValue ?? "completed"
        title = object["title"]?.stringValue
        streaming = object["streaming"]?.boolValue ?? false
        requestID = object["requestId"]?.stringValue
        requestKind = object["requestKind"]?.stringValue
        fileName = object["fileName"]?.stringValue
        additions = object["additions"]?.intValue
        deletions = object["deletions"]?.intValue
        exitCode = object["exitCode"]?.intValue
        text = Self.text(from: object)
        attachments = (object["attachments"]?.arrayValue ?? []).compactMap(Self.attachment)
        questions = (object["questions"]?.arrayValue ?? []).compactMap(Self.question)
    }

    private static func text(from object: [String: JSONValue]) -> String? {
        for key in [
            "text", "markdown", "prompt", "input", "output",
            "message", "summary", "progress", "result"
        ] {
            if let text = object[key]?.stringValue {
                return text
            }
        }
        return object["failure"]?.objectValue?["message"]?.stringValue
    }

    static func attachment(_ value: JSONValue) -> PathwayMessageAttachment? {
        guard
            let object = value.objectValue,
            let id = object["id"]?.stringValue,
            let type = object["type"]?.stringValue,
            let name = object["name"]?.stringValue
        else { return nil }
        return PathwayMessageAttachment(
            id: id,
            type: type,
            name: name,
            mimeType: object["mimeType"]?.stringValue ?? "application/octet-stream",
            sizeBytes: object["sizeBytes"]?.intValue ?? 0
        )
    }

    private static func question(_ value: JSONValue) -> PathwayThreadQuestion? {
        guard
            let object = value.objectValue,
            let id = object["id"]?.stringValue,
            let header = object["header"]?.stringValue,
            let question = object["question"]?.stringValue
        else { return nil }
        let options: [PathwayThreadQuestion.Option] = (object["options"]?.arrayValue ?? [])
            .compactMap { value in
                guard
                    let option = value.objectValue,
                    let label = option["label"]?.stringValue,
                    let description = option["description"]?.stringValue
                else { return nil }
                return PathwayThreadQuestion.Option(label: label, description: description)
            }
        return PathwayThreadQuestion(id: id, header: header, question: question, options: options, isOther: object["isOther"]?.boolValue, isSecret: object["isSecret"]?.boolValue, multiSelect: object["multiSelect"]?.boolValue)
    }
}

actor PathwayThreadCache {
    private struct Snapshot: Codable, Sendable {
        let items: [PathwayTimelineItem]
        let updatedAt: Date
    }

    private let directory: URL
    private let maximumEntries = 50
    private let maximumFileBytes: Int
    private let maximumTotalBytes: Int
    private let maximumAge: TimeInterval = 30 * 24 * 60 * 60
    private var lastSavedRevision: [String: UInt64] = [:]

    init(directory: URL? = nil, maximumFileBytes: Int = 16 * 1024 * 1024, maximumTotalBytes: Int = 128 * 1024 * 1024) {
        self.maximumFileBytes = maximumFileBytes
        self.maximumTotalBytes = maximumTotalBytes
        self.directory = directory ?? URL.applicationSupportDirectory
            .appending(path: "Pathway", directoryHint: .isDirectory)
            .appending(path: "AgentThreads", directoryHint: .isDirectory)
    }

    func load(threadID: String) -> [PathwayTimelineItem]? {
        let url = fileURL(threadID: threadID)
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= maximumFileBytes,
              let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              Date().timeIntervalSince(snapshot.updatedAt) <= maximumAge else { return nil }
        return snapshot.items
    }

    func save(items: [PathwayTimelineItem], threadID: String, revision: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        guard revision >= (lastSavedRevision[threadID] ?? 0) else { return }
        lastSavedRevision[threadID] = revision
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(Snapshot(items: items, updatedAt: Date()))
            let url = fileURL(threadID: threadID)
            guard data.count <= maximumFileBytes, data.count <= maximumTotalBytes else {
                try? FileManager.default.removeItem(at: url)
                return
            }
            #if os(iOS) || os(visionOS)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: url, options: .atomic)
            #endif
            var directoryURL = directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? directoryURL.setResourceValues(values)
            trim()
        } catch {
            return
        }
    }

    private func fileURL(threadID: String) -> URL {
        let safeID = Data(threadID.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
        return directory.appending(path: "\(safeID).json")
    }

    private func trim() {
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) else { return }
        let entries = urls.filter { $0.pathExtension == "json" }.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var count = entries.count
        var bytes = entries.reduce(0) { $0 + $1.2 }
        for (url, date, size) in entries {
            guard count > maximumEntries || bytes > maximumTotalBytes || Date().timeIntervalSince(date) > maximumAge else { continue }
            do { try FileManager.default.removeItem(at: url); count -= 1; bytes -= size } catch { continue }
        }
    }
}

@MainActor
@Observable
final class PathwayAgentThreadModel {
    typealias Request = @MainActor (String, JSONValue) async throws -> JSONValue
    private(set) var connectionState: PathwayThreadConnectionState = .idle
    private(set) var items: [PathwayTimelineItem] = []
    var questionDrafts: [String: PathwayQuestionDraft] = [:]
    var questionAttachmentStores: [String: PathwayNewThreadAttachments] = [:]
    var restoringQuestionAttachments: Set<String> = []
    var preparingQuestionAttachments: Set<String> = []
    private var restoredQuestionAttachments: Set<String> = []
    var serverConfig: [String: JSONValue] = [:]
    var providers: [PathwayServerProvider] = []
    var modelCatalog: [PathwayServerProvider] = []
    var currentModelSelection: PathwayModelSelection
    private(set) var runtimeMode: String
    private(set) var interactionMode: String
    private(set) var activeRunID: String?
    private(set) var threadTitle: String
    private(set) var runs: [PathwayThreadRun] = []
    private(set) var subagents: [PathwayThreadSubagent] = []
    private(set) var runtimeRequests: [JSONValue] = []
    private(set) var browserTakeover: [String: JSONValue]?
    private(set) var checkpoints: [JSONValue] = []
    private(set) var plans: [JSONValue] = []
    var isSending = false
    var actionError: String?
    var isProviderNativeChild = false
    var isParentRosterLoading = false
    var isConfigurationLocked: Bool { isParentRosterLoading || isProviderNativeChild || items.contains { $0.type == "compaction" && ["running", "waiting", "pending"].contains($0.status) } }
    var configurationLockReason: String? { isParentRosterLoading ? "Checking the parent thread configuration…" : isProviderNativeChild ? "This subagent is managed by its parent thread." : (isConfigurationLocked ? "Settings are available after context compaction finishes." : nil) }
    var maximumFileAttachmentBytes: Int? = nil
    var supportsAttachmentUploads = false
    var projectionCollections: [String: [JSONValue]] = [:]
    var draftAttachments: [PathwayThreadAttachmentDraft] = [] { didSet { saveDraft() } }
    var draft = "" { didSet { saveDraft() } }
    var threadID: String { thread.threadId }
    var environmentLabel: String { environment.environment.label }
    var supportsConversations: Bool {
        serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue?["threadConversations"]?.boolValue == true
    }
    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftAttachments.isEmpty)
            && draft.count <= 120_000 && !isSending && draftAttachments.allSatisfy { $0.state == .ready }
            && isSubscriptionReady && (rpc != nil || injectedRequest != nil)
    }

    private(set) var isSubscriptionReady = false
    @ObservationIgnored let storageDirectory: URL?
    @ObservationIgnored private let draftStore: PathwayConversationDraftStore?
    @ObservationIgnored private var draftWriteTask: Task<Void, Never>?
    @ObservationIgnored private var pendingDraftWrite: PathwayConversationDraftSnapshot?
    @ObservationIgnored private var didRestoreDraft = false
    @ObservationIgnored let connect: PathwayConnectClient?
    @ObservationIgnored let environment: PathwayCompanyEnvironment
    private(set) var thread: PathwayAgentThread
    @ObservationIgnored let cache: PathwayThreadCache
    @ObservationIgnored let persistsLocalState: Bool
    @ObservationIgnored let injectedRequest: Request?
    @ObservationIgnored var rpc: PathwayRPCClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var cacheWriteTask: Task<Void, Never>?
    @ObservationIgnored private var pendingCacheWrite: PathwayThreadCachePendingWrite?
    @ObservationIgnored private var configTask: Task<Void, Never>?
    @ObservationIgnored private var lastSequence = 0
    @ObservationIgnored var childRoster: PathwayThreadSubagent?
    @ObservationIgnored var parentModelSelection: PathwayModelSelection?
    @ObservationIgnored var preparedNewSend: PathwayThreadPreparedNewSend? { didSet { saveDraft() } }
    @ObservationIgnored var preparedSend: PathwayThreadPreparedSend? { didSet { saveDraft() } }
    @ObservationIgnored var attachmentData: [String: Data] = [:] { didSet { saveDraft() } }

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment,
         connect: PathwayConnectClient, cache: PathwayThreadCache? = nil, storageDirectory: URL? = nil) {
        self.thread = thread; self.environment = environment; self.connect = connect
        self.storageDirectory = storageDirectory
        self.cache = cache ?? PathwayThreadCache(directory: storageDirectory?.appending(path: "AgentThreads"))
        draftStore = storageDirectory.map { PathwayConversationDraftStore(directory: $0.appending(path: "ConversationDrafts"), key: thread.id) }
        persistsLocalState = storageDirectory != nil; injectedRequest = nil
        currentModelSelection = thread.shell.modelSelection; runtimeMode = thread.shell.runtimeMode
        interactionMode = thread.shell.interactionMode; activeRunID = thread.shell.activeRunId
        threadTitle = thread.shell.title
        isParentRosterLoading = thread.shell.lineage?.relationshipToParent == "subagent"

    }

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment,
         request: @escaping Request, persistsLocalState: Bool = false, cache: PathwayThreadCache = PathwayThreadCache(), storageDirectory: URL? = nil) {
        self.thread = thread; self.environment = environment; connect = nil; self.cache = cache
        self.storageDirectory = storageDirectory
        draftStore = storageDirectory.map { PathwayConversationDraftStore(directory: $0.appending(path: "ConversationDrafts"), key: thread.id) }
        self.persistsLocalState = persistsLocalState; injectedRequest = request
        isSubscriptionReady = true
        currentModelSelection = thread.shell.modelSelection; runtimeMode = thread.shell.runtimeMode
        interactionMode = thread.shell.interactionMode; activeRunID = thread.shell.activeRunId
        threadTitle = thread.shell.title
        isParentRosterLoading = thread.shell.lineage?.relationshipToParent == "subagent"
    }

    isolated deinit {
        streamTask?.cancel(); configTask?.cancel(); cacheWriteTask?.cancel(); draftWriteTask?.cancel()
        if let pendingDraftWrite, let draftStore { Task { try? await draftStore.save(pendingDraftWrite) } }
        if let pending = pendingCacheWrite {
            let cache = cache; let id = thread.id
            Task { await cache.save(items: pending.items, threadID: id, revision: pending.revision) }
        }
        if let rpc { Task { await rpc.stop() } }
    }

    func start() {
        guard streamTask == nil, let connect else { return }
        connectionState = .connecting
        streamTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await restoreDraft()
            if persistsLocalState, let cached = await cache.load(threadID: thread.id), items.isEmpty {
                items = cached; connectionState = .cached
            }
            guard !Task.isCancelled else { return }
            let environment = environment
            let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            self.rpc = rpc
            configTask = Task { [weak self] in
                if let value = try? await rpc.request("server.getConfig", payload: .object([:])) {
                    self?.installServerConfig(value)
                }
                await self?.refreshParentRoster()
            }
            do {
                for try await value in await rpc.subscribeToThread(thread.threadId) {
                    guard !Task.isCancelled else { return }
                    applySubscriptionValue(value)
                }
            } catch is CancellationError { return }
            catch { connectionState = items.isEmpty ? .failed(error.localizedDescription) : .cached }
        }
    }

    func stop() async {
        streamTask?.cancel(); streamTask = nil; configTask?.cancel(); configTask = nil
        isSubscriptionReady = false
        connectionState = items.isEmpty ? .idle : .cached
        await persistDraftNow()
        let previousRPC = rpc; rpc = nil
        let cacheWrite = takePendingCacheWrite()
        await previousRPC?.stop()
        if let cacheWrite { await cache.save(items: cacheWrite.items, threadID: thread.id, revision: cacheWrite.revision) }
    }

    func clearActionError() { actionError = nil }
    func request(_ method: String, payload: JSONValue, reportsErrors: Bool = true, requiresSubscription: Bool = false) async throws -> JSONValue {
        do {
            if requiresSubscription, !isSubscriptionReady { throw PathwayRPCError.disconnected }
            let result: JSONValue
            if let injectedRequest { result = try await injectedRequest(method, payload) }
            else if let rpc { result = try await rpc.request(method, payload: payload, requiresSubscription: requiresSubscription, waitForSubscription: false) }
            else { throw PathwayThreadConversationError.message("Connect to the environment to use this action.") }
            if reportsErrors { actionError = nil }
            return result
        } catch { if reportsErrors { actionError = error.localizedDescription }; throw error }
    }

    func dispatch(_ type: String, fields: [String: JSONValue] = [:]) async throws {
        var payload = fields
        payload["type"] = .string(type)
        if payload["commandId"] == nil { payload["commandId"] = .string(UUID().uuidString) }
        if payload["threadId"] == nil && type != "thread.fork" { payload["threadId"] = .string(threadID) }
        _ = try await request("orchestration.dispatchCommand", payload: .object(payload), requiresSubscription: true)
    }

    func send(mode: String = "queue") async {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        var selected = draftAttachments
        isSending = true
        defer { isSending = false }
        do {
            if preparedNewSend != nil {
                for id in selected.map(\.id) { await retryAttachment(id: id) }
                selected = draftAttachments
                guard selected.allSatisfy({ $0.state == .ready }) else { throw PathwayThreadConversationError.message("Finish uploading the attachments before sending.") }
                preparedNewSend = nil
            }
            let ids = selected.map(\.id)
            let sameAttempt = preparedSend?.ids == ids && preparedSend?.text == text && preparedSend?.requestedMode == mode
            if !sameAttempt {
                var dispatchMode: [String: JSONValue] = ["type": .string(activeRunID == nil ? "start_immediately" : "queue_after_active")]
                if mode == "steer", let activeRunID { dispatchMode = ["type": .string("steer_active"), "targetRunId": .string(activeRunID)] }
                preparedSend = PathwayThreadPreparedSend(ids: ids, messageID: UUID().uuidString, text: text,
                    requestedMode: mode, attachments: [], dispatchMode: .object(dispatchMode))
            }
            guard let transaction = preparedSend else { return }
            await persistDraftNow()
            if !transaction.attachmentsPrepared {
                var attachments: [JSONValue] = []
                if !selected.isEmpty {
                    let result = try await request("assets.persistChatAttachments", payload: .object([
                        "threadId": .string(threadID), "messageId": .string(transaction.messageID),
                        "attachments": .array(selected.compactMap { $0.attachment?.json })
                    ]))
                    attachments = result.objectValue?["attachments"]?.arrayValue ?? []
                    guard attachments.count == selected.count else { throw PathwayThreadConversationError.message("The attachments could not be prepared. Try again.") }
                }
                preparedSend?.attachments = attachments
                preparedSend?.attachmentsPrepared = true
                await persistDraftNow()
            }
            guard let prepared = preparedSend else { return }
            try await dispatch("message.dispatch", fields: ["commandId": .string(prepared.messageID), "createdBy": .string("user"), "creationSource": .string("mobile"),
                "messageId": .string(prepared.messageID), "text": .string(prepared.text), "attachments": .array(prepared.attachments), "dispatchMode": prepared.dispatchMode])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            preparedSend = nil
            let sentIDs = Set(selected.map(\.id))
            draftAttachments.removeAll { sentIDs.contains($0.id) }
            for id in sentIDs { attachmentData.removeValue(forKey: id) }
            await persistDraftNow()
        } catch { actionError = error.localizedDescription }
    }

    func canEdit(_ item: PathwayTimelineItem) -> Bool { isSubscriptionReady && activeRunID == nil && canPrepareEdit(item) }

    func canPrepareEdit(_ item: PathwayTimelineItem) -> Bool {
        guard item.isUserMessage, item.messageID != nil, item.fields["createdBy"]?.stringValue == "user",
              items.last(where: \.isUserMessage)?.id == item.id, let run = run(for: item),
              !["queued", "cancelled"].contains(run.status),
              run.fields["modelSelection"] == (try? Self.json(currentModelSelection)) else { return false }
        if checkpoints.contains(where: { value in
            let fields = value.objectValue ?? [:]
            return fields["status"]?.stringValue == "ready" && !(fields["files"]?.arrayValue ?? []).isEmpty && (fields["appRunOrdinal"]?.intValue ?? -1) >= run.ordinal
        }) { return false }
        let attemptID = run.fields["activeAttemptId"]?.stringValue
        let attempt = projectionCollections["attempts"]?.first { $0.objectValue?["id"]?.stringValue == attemptID }?.objectValue
        let providerTurn = projectionCollections["providerTurns"]?.first {
            (attemptID != nil && $0.objectValue?["runAttemptId"]?.stringValue == attemptID) ||
            (attempt?["providerTurnId"]?.stringValue != nil && $0.objectValue?["id"]?.stringValue == attempt?["providerTurnId"]?.stringValue)
        }
        let hasAssistant = projectionCollections["messages"]?.contains { $0.objectValue?["runId"]?.stringValue == run.id && $0.objectValue?["role"]?.stringValue == "assistant" } == true
        if run.status == "interrupted", providerTurn == nil, !hasAssistant { return true }
        let providerThread = projectionCollections["providerThreads"]?.first { $0.objectValue?["id"]?.stringValue == run.fields["providerThreadId"]?.stringValue }?.objectValue
        let sessionID = providerThread?["providerSessionId"]?.stringValue
        guard let sessionID, let session = projectionCollections["providerSessions"]?.first(where: { $0.objectValue?["id"]?.stringValue == sessionID })?.objectValue,
              session["capabilities"]?.objectValue?["checkpointing"]?.objectValue?["providerCanRollbackConversation"]?.boolValue == true else { return false }
        let scopeID = projectionCollections["checkpointScopes"]?.first { $0.objectValue?["runId"]?.stringValue == run.id && $0.objectValue?["kind"]?.stringValue == "root_run" }?.objectValue?["id"]?.stringValue
        return checkpoints.contains {
            let fields = $0.objectValue ?? [:]
            guard fields["status"]?.stringValue == "ready" else { return false }
            return run.ordinal == 1 ? (scopeID != nil && fields["scopeId"]?.stringValue == scopeID && fields["ordinalWithinScope"]?.intValue == 0 && fields["appRunOrdinal"]?.intValue == nil) : fields["appRunOrdinal"]?.intValue == run.ordinal - 1
        }
    }
    func editLatestUserMessage(_ item: PathwayTimelineItem, text: String) async throws {
        guard activeRunID == nil, canEdit(item), let messageID = item.messageID, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PathwayThreadConversationError.message("Only the latest message can be edited after the agent stops.")
        }
        try await dispatch("message.edit-and-restart", fields: ["createdBy": .string("user"), "creationSource": .string("mobile"),
            "messageId": .string(messageID), "replacementMessageId": .string(UUID().uuidString), "text": .string(Self.preservingMessageContext(original: item.text ?? "", edited: text))])
    }
    func fork(from item: PathwayTimelineItem? = nil) async throws -> String {
        guard !thread.shell.isTemporary else {
            throw PathwayThreadConversationError.message("Keep conversation before forking this thread.")
        }
        let target = UUID().uuidString
        var source: JSONValue = .object(["type": .string("latest_stable")])
        if let item {
            guard let runID = item.runID else { throw PathwayThreadConversationError.message("This message has no run to fork.") }
            source = .object(["type": .string("run"), "runId": .string(runID)])
        }
        try await dispatch("thread.fork", fields: ["sourceThreadId": .string(threadID), "targetThreadId": .string(target),
            "sourcePoint": source, "createdBy": .string("user"), "creationSource": .string("mobile")])
        return target
    }
    func interrupt() async throws {
        guard let activeRunID else { return }
        try await dispatch("run.interrupt", fields: ["runId": .string(activeRunID)])
    }
    func changeModelSelection(_ selection: PathwayModelSelection) async throws {
        guard !isConfigurationLocked else { throw PathwayThreadConversationError.message("This subagent is managed by its parent thread.") }
        try await dispatch("thread.model-selection.set", fields: ["modelSelection": try Self.json(selection)])
        currentModelSelection = selection
        if providers.first(where: { $0.id == selection.instanceId })?.showsInteractionMode == false && interactionMode != "default" {
            try await setInteractionMode("default")
        }
    }
    func setRuntimeMode(_ value: String) async throws {
        guard !isConfigurationLocked else { throw PathwayThreadConversationError.message("This subagent is managed by its parent thread.") }
        try await dispatch("thread.runtime-mode.set", fields: ["runtimeMode": .string(value)]); runtimeMode = value
    }
    func setInteractionMode(_ value: String) async throws {
        guard !isConfigurationLocked else { throw PathwayThreadConversationError.message("This subagent is managed by its parent thread.") }
        try await dispatch("thread.interaction-mode.set", fields: ["interactionMode": .string(value)]); interactionMode = value
    }
    var pendingAsyncQuestions: [PathwayTimelineItem] {
        items.filter { item in
            item.type == "user_input_request" && isNonBlockingQuestion(item) && runtimeRequests.contains {
                $0.objectValue?["id"]?.stringValue == item.requestID && $0.objectValue?["status"]?.stringValue == "pending"
            }
        }
    }
    func isNonBlockingQuestion(_ item: PathwayTimelineItem) -> Bool {
        guard let id = item.requestID else { return false }
        return runtimeRequests.contains { request in
            let fields = request.objectValue
            return fields?["id"]?.stringValue == id && fields?["isBlocking"]?.boolValue == false
        }
    }
    func prepareQuestionDraft(for item: PathwayTimelineItem) {
        if supportsQuestionAttachments && !restoredQuestionAttachments.contains(item.id) {
            restoredQuestionAttachments.insert(item.id)
            restoringQuestionAttachments.insert(item.id)
            Task {
                defer { restoringQuestionAttachments.remove(item.id) }
                for question in item.questions { await questionAttachments(item: item, questionID: question.id).restore() }
            }
        }
        guard questionDrafts[item.id] == nil, isNonBlockingQuestion(item) else { return }
        var draft = PathwayQuestionDraft()
        for question in item.questions {
            if let first = question.options.first { draft.selected[question.id] = [first.label] }
        }
        questionDrafts[item.id] = draft
    }
    func canRespond(to item: PathwayTimelineItem) -> Bool {
        guard isSubscriptionReady, item.requiresResponse, let id = item.requestID else { return false }
        return runtimeRequests.contains { request in
            let fields = request.objectValue
            let capability = fields?["responseCapability"]?.objectValue?["type"]?.stringValue
            return fields?["id"]?.stringValue == id && fields?["status"]?.stringValue == "pending" && (capability == "live" || capability == "message")
        }
    }
    func responseUnavailableReason(for item: PathwayTimelineItem) -> String? {
        if !isSubscriptionReady { return "Reconnect and wait for the latest thread state before responding." }
        return canRespond(to: item) ? nil : "This request is no longer connected to a live agent."
    }
    func respondToApproval(requestID: String, decision: String) async {
        do { try await respond(requestID: requestID, fields: ["decision": .string(decision)]) }
        catch { actionError = error.localizedDescription }
    }
    func respondToQuestion(requestID: String, questionID: String, answer: String) async {
        do { try await respondToQuestions(requestID: requestID, answers: [questionID: .string(answer)]) }
        catch { actionError = error.localizedDescription }
    }
    func respondToQuestions(requestID: String, answers: [String: JSONValue]) async throws {
        guard let item = items.first(where: { $0.requestID == requestID }), questionAttachmentsReady(item) else {
            throw PathwayThreadConversationError.message("Wait for answer attachments to finish uploading.")
        }
        let stores = item.questions.map { ($0.id, questionAttachments(item: item, questionID: $0.id)) }
        let uploads = stores.flatMap { $0.1.uploads }
        guard uploads.count <= 8 else { throw PathwayThreadConversationError.message("You can attach up to 8 files across these answers.") }
        var fields: [String: JSONValue] = ["answers": .object(answers)]
        if !uploads.isEmpty {
            let persisted = try await request("assets.persistChatAttachments", payload: .object([
                "threadId": .string(threadID), "messageId": .string("question:\(UUID().uuidString)"), "attachments": .array(uploads)
            ]))
            guard let saved = persisted.objectValue?["attachments"]?.arrayValue, saved.count == uploads.count else {
                throw PathwayThreadConversationError.message("The answer attachments could not be saved.")
            }
            var offset = 0
            var byQuestion: [String: JSONValue] = [:]
            for (questionID, store) in stores {
                let count = store.uploads.count
                if count > 0 { byQuestion[questionID] = .array(Array(saved[offset..<(offset + count)])) }
                offset += count
            }
            fields["attachmentsByQuestionId"] = .object(byQuestion)
        }
        try await respond(requestID: requestID, fields: fields)
        for (_, store) in stores {
            for draft in store.drafts { await store.remove(id: draft.id) }
        }
    }

    var supportsQuestionAttachments: Bool {
        serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue?["questionAttachments"]?.boolValue == true
    }

    func questionAttachments(item: PathwayTimelineItem, questionID: String) -> PathwayNewThreadAttachments {
        let key = "\(item.id):\(questionID)"
        let store = questionAttachmentStores[key] ?? PathwayNewThreadAttachments(directory: storageDirectory?.appending(path: "QuestionAttachments"), key: "\(thread.id):\(key)")
        if questionAttachmentStores[key] == nil { questionAttachmentStores[key] = store }
        store.supportsUploads = supportsQuestionAttachments
        store.maximumFileBytes = maximumFileAttachmentBytes
        store.isConnected = isSubscriptionReady
        store.request = { [weak self] method, payload in
            guard let self else { throw PathwayRPCError.disconnected }
            return try await self.request(method, payload: payload)
        }
        store.uploadRequest = { [weak self] path in
            guard let self, let connect = self.connect else { throw PathwayRPCError.disconnected }
            return try await connect.authenticatedRequest(environment: self.environment, method: "PUT", path: path)
        }
        return store
    }

    func questionAttachmentCount(_ item: PathwayTimelineItem) -> Int {
        item.questions.reduce(0) { $0 + (questionAttachmentStores["\(item.id):\($1.id)"]?.drafts.count ?? 0) }
    }

    func questionAttachmentsReady(_ item: PathwayTimelineItem) -> Bool {
        !restoringQuestionAttachments.contains(item.id) && !preparingQuestionAttachments.contains(item.id) &&
        item.questions.allSatisfy { questionAttachmentStores["\(item.id):\($0.id)"]?.isReady ?? true }
    }
    private func respond(requestID: String, fields: [String: JSONValue]) async throws {
        guard let item = items.first(where: { $0.requestID == requestID }), canRespond(to: item) else {
            throw PathwayThreadConversationError.message("This request is no longer connected to a live agent.")
        }
        var payload = fields; payload["requestId"] = .string(requestID)
        try await dispatch("runtime-request.respond", fields: payload)
    }
    func run(for item: PathwayTimelineItem) -> PathwayThreadRun? { runs.first { $0.id == item.runID } }

    func installSnapshot(_ projection: JSONValue, sequence: Int = 0) {
        guard let object = projection.objectValue else { return }
        projectionCollections = object.compactMapValues(\.arrayValue)
        items = (object["visibleTurnItems"]?.arrayValue ?? []).compactMap { $0.objectValue?["item"].flatMap(PathwayTimelineItem.init(json:)) }.sorted(by: Self.order)
        runs = (object["runs"]?.arrayValue ?? []).compactMap(PathwayThreadRun.init)
        subagents = (object["subagents"]?.arrayValue ?? []).compactMap(PathwayThreadSubagent.init)
        runtimeRequests = object["runtimeRequests"]?.arrayValue ?? []
        checkpoints = object["checkpoints"]?.arrayValue ?? []; plans = object["plans"]?.arrayValue ?? []
        applyThread(object["thread"]); deriveActiveRun()
        lastSequence = sequence; connectionState = isSubscriptionReady ? .live : .connecting; persist()
    }
    func applySubscriptionValue(_ value: JSONValue) {
        guard let object = value.objectValue else { return }
        if object["_pathwayTransport"] != nil {
            isSubscriptionReady = false
            connectionState = items.isEmpty ? .connecting : .cached
            return
        }
        switch object["kind"]?.stringValue {
        case "snapshot": if let projection = object["projection"] { installSnapshot(projection, sequence: object["snapshotSequence"]?.intValue ?? 0) }
        case "event":
            guard let sequence = object["sequence"]?.intValue, sequence > lastSequence,
                  let event = object["event"]?.objectValue, let type = event["type"]?.stringValue, let payload = event["payload"] else { return }
            lastSequence = sequence
            if type == "turn-item.updated", let item = PathwayTimelineItem(json: payload) {
                guard !runs.contains(where: { $0.id == item.runID && $0.status == "rolled_back" }) else { return }
                if let index = items.firstIndex(where: { $0.id == item.id }) {
                    let previous = items[index]
                    items[index] = item
                    // Streaming text updates retain their position; only ordering changes sort.
                    if Self.order(previous, item) || Self.order(item, previous) { items.sort(by: Self.order) }
                } else {
                    var lower = 0, upper = items.count
                    while lower < upper {
                        let middle = lower + (upper - lower) / 2
                        if Self.order(items[middle], item) { lower = middle + 1 } else { upper = middle }
                    }
                    items.insert(item, at: lower)
                }
                persist()
            } else if type == "run.created" || type == "run.updated", let run = PathwayThreadRun(payload) {
                if let index = runs.firstIndex(where: { $0.id == run.id }) { runs[index] = run } else { runs.append(run) }
                deriveActiveRun()
                if run.status == "rolled_back" { items.removeAll { $0.runID == run.id }; persist() }
            } else if type == "subagent.updated" || type == "subagent.created", let agent = PathwayThreadSubagent(payload) {
                if let index = subagents.firstIndex(where: { $0.id == agent.id }) { subagents[index] = agent } else { subagents.append(agent) }
            } else if type.hasPrefix("runtime-request.") { Self.upsert(payload, into: &runtimeRequests) }
            else if type == "checkpoint.captured" { Self.upsert(payload, into: &checkpoints) }
            else if type == "plan.created" || type == "plan.updated" { Self.upsert(payload, into: &plans) }
            else if type.hasPrefix("thread.") { applyThread(payload) }
            let collectionByEvent = ["run-attempt": "attempts", "provider-turn": "providerTurns", "provider-thread": "providerThreads", "provider-session": "providerSessions", "message": "messages", "checkpoint-scope": "checkpointScopes"]
            if let prefix = type.split(separator: ".").first, let collection = collectionByEvent[String(prefix)] {
                var values = projectionCollections[collection] ?? []
                Self.upsert(payload, into: &values); projectionCollections[collection] = values
            }
            if isSubscriptionReady { connectionState = .live }
        case "synchronized": isSubscriptionReady = true; connectionState = .live
        default: break
        }
    }
    private func applyThread(_ value: JSONValue?) {
        guard let object = value?.objectValue else { return }
        // Events can carry partial metadata; merge it with the last shell to retain directory references.
        if var shell = (try? Self.json(thread.shell))?.objectValue {
            shell.merge(object) { _, value in value }
            if let decoded = try? JSONDecoder().decode(PathwayAgentThreadShell.self, from: JSONEncoder().encode(JSONValue.object(shell))) {
                thread = PathwayAgentThread(companyId: thread.companyId, environmentId: thread.environmentId,
                    cloudProjectId: thread.cloudProjectId, shell: decoded, cloudUpdatedAt: thread.cloudUpdatedAt)
            }
        }
        if let value = object["browserTakeover"] { browserTakeover = value.objectValue }
        if let value = object["title"]?.stringValue { threadTitle = value }
        if let value = object["runtimeMode"]?.stringValue { runtimeMode = value }
        if let value = object["interactionMode"]?.stringValue { interactionMode = value }
        if let value = object["modelSelection"], let selection = try? JSONDecoder().decode(PathwayModelSelection.self, from: JSONEncoder().encode(value)) { currentModelSelection = selection }
        deriveActiveRun()
        applyChildRosterSelection()
    }
    private func deriveActiveRun() {
        activeRunID = runs.filter { $0.isActive }.max { $0.ordinal < $1.ordinal }?.id
    }
    private static func upsert(_ value: JSONValue, into values: inout [JSONValue]) {
        guard let id = value.objectValue?["id"]?.stringValue else { return }
        if let index = values.firstIndex(where: { $0.objectValue?["id"]?.stringValue == id }) { values[index] = value } else { values.append(value) }
    }
    static func json<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
    private func persist() {
        guard persistsLocalState else { return }
        pendingCacheWrite = PathwayThreadCachePendingWrite(items: items, revision: DispatchTime.now().uptimeNanoseconds)
        guard cacheWriteTask == nil else { return }
        cacheWriteTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard !Task.isCancelled, let self, let pending = takePendingCacheWrite() else { return }
            await cache.save(items: pending.items, threadID: thread.id, revision: pending.revision)
        }
    }
    private func takePendingCacheWrite() -> PathwayThreadCachePendingWrite? {
        cacheWriteTask?.cancel(); cacheWriteTask = nil
        let pending = pendingCacheWrite; pendingCacheWrite = nil
        return pending
    }
    func restoreDraft(legacyDefaults: UserDefaults = .standard) async {
        guard !didRestoreDraft, let draftStore else { return }
        didRestoreDraft = true
        let legacyKey = "pathway.agent-thread.draft.\(thread.id)"
        if draft.isEmpty, draftAttachments.isEmpty, let legacy = legacyDefaults.string(forKey: legacyKey) {
            do {
                if try await draftStore.migrateLegacyText(legacy), legacyDefaults.string(forKey: legacyKey) == legacy {
                    legacyDefaults.removeObject(forKey: legacyKey)
                }
            } catch { actionError = "The previous draft could not be saved on this device. " + error.localizedDescription }
        }
        guard let restored = await draftStore.load(expirePendingUploads: true) else { return }
        // Do not overwrite a draft the user already started while disk I/O was pending.
        guard draft.isEmpty, draftAttachments.isEmpty else { return }
        draft = restored.text
        attachmentData = restored.data
        draftAttachments = restored.attachments
        preparedSend = restored.preparedSend
        preparedNewSend = restored.preparedNewSend
    }

    private func saveDraft() {
        guard draftStore != nil else { return }
        pendingDraftWrite = draftSnapshot()
        guard draftWriteTask == nil else { return }
        draftWriteTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await self?.persistDraftNow()
        }
    }

    private func draftSnapshot() -> PathwayConversationDraftSnapshot {
        PathwayConversationDraftSnapshot(text: draft, attachments: draftAttachments, data: attachmentData,
            preparedSend: preparedSend, preparedNewSend: preparedNewSend, revision: DispatchTime.now().uptimeNanoseconds)
    }

    func persistDraftNow() async {
        draftWriteTask?.cancel(); draftWriteTask = nil
        guard let draftStore, didRestoreDraft || pendingDraftWrite != nil else { return }
        let snapshot = draftSnapshot()
        pendingDraftWrite = nil
        do { try await draftStore.save(snapshot) }
        catch { actionError = "The draft could not be saved on this device. " + error.localizedDescription }
    }
    private static func order(_ left: PathwayTimelineItem, _ right: PathwayTimelineItem) -> Bool {
        left.ordinal == right.ordinal ? left.id < right.id : left.ordinal < right.ordinal
    }
}
