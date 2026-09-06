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
    private var lastSavedRevision: [String: UInt64] = [:]

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory
            .appending(path: "Pathway", directoryHint: .isDirectory)
            .appending(path: "AgentThreads", directoryHint: .isDirectory)
    }

    func load(threadID: String) -> [PathwayTimelineItem]? {
        guard
            let data = try? Data(contentsOf: fileURL(threadID: threadID)),
            let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return nil }
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
            try data.write(to: fileURL(threadID: threadID), options: .atomic)
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
        guard
            let urls = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey]
            ),
            urls.count > maximumEntries
        else { return }
        let oldest = urls.sorted {
            let left = try? $0.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate
            let right = try? $1.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate
            return (left ?? .distantPast) < (right ?? .distantPast)
        }
        for url in oldest.prefix(urls.count - maximumEntries) {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

@MainActor
@Observable
final class PathwayAgentThreadModel {
    typealias Request = @MainActor (String, JSONValue) async throws -> JSONValue
    private(set) var connectionState: PathwayThreadConnectionState = .idle
    private(set) var items: [PathwayTimelineItem] = []
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
    var draftAttachments: [PathwayThreadAttachmentDraft] = []
    var draft = "" { didSet { saveDraft() } }
    var threadID: String { thread.threadId }
    var environmentLabel: String { environment.environment.label }
    var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftAttachments.isEmpty)
            && draft.count <= 120_000 && !isSending && draftAttachments.allSatisfy { $0.state == .ready }
            && (rpc != nil || injectedRequest != nil)
    }

    @ObservationIgnored let connect: PathwayConnectClient?
    @ObservationIgnored let environment: PathwayCompanyEnvironment
    @ObservationIgnored let thread: PathwayAgentThread
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
    @ObservationIgnored var preparedNewSend: PathwayThreadPreparedNewSend?
    @ObservationIgnored var preparedSend: PathwayThreadPreparedSend?
    @ObservationIgnored var attachmentData: [String: Data] = [:]

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment,
         connect: PathwayConnectClient, cache: PathwayThreadCache = PathwayThreadCache()) {
        self.thread = thread; self.environment = environment; self.connect = connect; self.cache = cache
        persistsLocalState = true; injectedRequest = nil
        currentModelSelection = thread.shell.modelSelection; runtimeMode = thread.shell.runtimeMode
        interactionMode = thread.shell.interactionMode; activeRunID = thread.shell.activeRunId
        threadTitle = thread.shell.title
        isParentRosterLoading = thread.shell.lineage?.relationshipToParent == "subagent"
        draft = UserDefaults.standard.string(forKey: Self.draftKey(thread.id)) ?? ""
    }

    init(thread: PathwayAgentThread, environment: PathwayCompanyEnvironment,
         request: @escaping Request, persistsLocalState: Bool = false, cache: PathwayThreadCache = PathwayThreadCache()) {
        self.thread = thread; self.environment = environment; connect = nil; self.cache = cache
        self.persistsLocalState = persistsLocalState; injectedRequest = request
        currentModelSelection = thread.shell.modelSelection; runtimeMode = thread.shell.runtimeMode
        interactionMode = thread.shell.interactionMode; activeRunID = thread.shell.activeRunId
        threadTitle = thread.shell.title
        isParentRosterLoading = thread.shell.lineage?.relationshipToParent == "subagent"
    }

    deinit {
        streamTask?.cancel(); configTask?.cancel(); cacheWriteTask?.cancel()
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
        let previousRPC = rpc; rpc = nil
        let cacheWrite = takePendingCacheWrite()
        await previousRPC?.stop()
        if let cacheWrite { await cache.save(items: cacheWrite.items, threadID: thread.id, revision: cacheWrite.revision) }
    }

    func clearActionError() { actionError = nil }
    func request(_ method: String, payload: JSONValue, reportsErrors: Bool = true) async throws -> JSONValue {
        do {
            let result: JSONValue
            if let injectedRequest { result = try await injectedRequest(method, payload) }
            else if let rpc { result = try await rpc.request(method, payload: payload) }
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
        _ = try await request("orchestration.dispatchCommand", payload: .object(payload))
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
            let previous = preparedSend
            let sameAttempt = previous?.ids == ids && previous?.text == text && previous?.requestedMode == mode
            var prepared = sameAttempt ? previous : nil
            if prepared == nil {
                let messageID = UUID().uuidString
                var attachmentsByID: [String: JSONValue] = [:]
                if let previous {
                    attachmentsByID = Dictionary(uniqueKeysWithValues: zip(previous.ids, previous.attachments))
                }
                let missing = selected.filter { attachmentsByID[$0.id] == nil }
                if !missing.isEmpty {
                    let result = try await request("assets.persistChatAttachments", payload: .object([
                        "threadId": .string(threadID), "messageId": .string(messageID),
                        "attachments": .array(missing.compactMap { $0.attachment?.json })
                    ]))
                    let persisted = result.objectValue?["attachments"]?.arrayValue ?? []
                    guard persisted.count == missing.count else { throw PathwayThreadConversationError.message("The attachments could not be prepared. Try again.") }
                    for (attachment, value) in zip(missing, persisted) { attachmentsByID[attachment.id] = value }
                }
                var dispatchMode: [String: JSONValue] = ["type": .string(activeRunID == nil ? "start_immediately" : "queue_after_active")]
                if mode == "steer", let activeRunID { dispatchMode = ["type": .string("steer_active"), "targetRunId": .string(activeRunID)] }
                prepared = PathwayThreadPreparedSend(ids: ids, messageID: messageID, text: text, requestedMode: mode,
                    attachments: ids.compactMap { attachmentsByID[$0] }, dispatchMode: .object(dispatchMode))
                preparedSend = prepared
            }
            guard let prepared else { return }
            try await dispatch("message.dispatch", fields: ["commandId": .string(prepared.messageID), "createdBy": .string("user"), "creationSource": .string("mobile"),
                "messageId": .string(prepared.messageID), "text": .string(prepared.text), "attachments": .array(prepared.attachments), "dispatchMode": prepared.dispatchMode])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            preparedSend = nil
            let sentIDs = Set(selected.map(\.id))
            draftAttachments.removeAll { sentIDs.contains($0.id) }
            for id in sentIDs { attachmentData.removeValue(forKey: id) }
        } catch { actionError = error.localizedDescription }
    }

    func canEdit(_ item: PathwayTimelineItem) -> Bool { activeRunID == nil && canPrepareEdit(item) }

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
    func canRespond(to item: PathwayTimelineItem) -> Bool {
        guard item.requiresResponse, let id = item.requestID else { return false }
        return runtimeRequests.contains { $0.objectValue?["id"]?.stringValue == id && $0.objectValue?["status"]?.stringValue == "pending" && $0.objectValue?["responseCapability"]?.objectValue?["type"]?.stringValue == "live" }
    }
    func responseUnavailableReason(for item: PathwayTimelineItem) -> String? {
        canRespond(to: item) ? nil : "This request is no longer connected to a live agent."
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
        try await respond(requestID: requestID, fields: ["answers": .object(answers)])
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
        lastSequence = sequence; connectionState = .live; persist()
    }
    func applySubscriptionValue(_ value: JSONValue) {
        guard let object = value.objectValue else { return }
        switch object["kind"]?.stringValue {
        case "snapshot": if let projection = object["projection"] { installSnapshot(projection, sequence: object["snapshotSequence"]?.intValue ?? 0) }
        case "event":
            guard let sequence = object["sequence"]?.intValue, sequence > lastSequence,
                  let event = object["event"]?.objectValue, let type = event["type"]?.stringValue, let payload = event["payload"] else { return }
            lastSequence = sequence
            if type == "turn-item.updated", let item = PathwayTimelineItem(json: payload) {
                guard !runs.contains(where: { $0.id == item.runID && $0.status == "rolled_back" }) else { return }
                if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item } else { items.append(item) }
                items.sort(by: Self.order); persist()
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
            connectionState = .live
        case "synchronized": connectionState = .live
        default: break
        }
    }
    private func applyThread(_ value: JSONValue?) {
        guard let object = value?.objectValue else { return }
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
    private func saveDraft() {
        guard persistsLocalState else { return }
        let key = Self.draftKey(thread.id)
        if draft.isEmpty { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set(draft, forKey: key) }
    }
    private static func draftKey(_ id: String) -> String { "pathway.agent-thread.draft.\(id)" }
    private static func order(_ left: PathwayTimelineItem, _ right: PathwayTimelineItem) -> Bool {
        left.ordinal == right.ordinal ? left.id < right.id : left.ordinal < right.ordinal
    }
}
