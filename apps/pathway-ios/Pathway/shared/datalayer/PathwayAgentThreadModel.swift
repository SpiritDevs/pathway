import Foundation
import Observation

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
}

struct PathwayMessageAttachment: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let type: String
    let name: String
    let mimeType: String
    let sizeBytes: Int
}

struct PathwayWorkspacePreparation: Codable, Equatable, Sendable {
    let phase: String
    let workspaceKind: String
    let baseRef: String?
    let cwd: String?
    let branch: String?
    let terminalId: String?
    let scriptName: String?

    init?(json: JSONValue?) {
        guard let object = json?.objectValue,
              let phase = object["phase"]?.stringValue,
              let workspaceKind = object["workspaceKind"]?.stringValue else { return nil }
        self.phase = phase
        self.workspaceKind = workspaceKind
        baseRef = object["baseRef"]?.stringValue
        cwd = object["cwd"]?.stringValue
        branch = object["branch"]?.stringValue
        terminalId = object["terminalId"]?.stringValue
        scriptName = object["scriptName"]?.stringValue
    }
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
    let workspacePreparation: PathwayWorkspacePreparation?
    let attachments: [PathwayMessageAttachment]
    let questions: [PathwayThreadQuestion]

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
        workspacePreparation = PathwayWorkspacePreparation(json: object["workspacePreparation"])
        if workspacePreparation != nil {
            text = object["output"]?.stringValue ?? object["title"]?.stringValue
        } else {
            text = Self.text(from: object)
        }
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

    private static func attachment(_ value: JSONValue) -> PathwayMessageAttachment? {
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
        return PathwayThreadQuestion(id: id, header: header, question: question, options: options)
    }
}

actor PathwayThreadCache {
    private struct Snapshot: Codable, Sendable {
        let items: [PathwayTimelineItem]
        let updatedAt: Date
    }

    private let directory: URL
    private let maximumEntries = 50

    init() {
        directory = URL.applicationSupportDirectory
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

    func save(items: [PathwayTimelineItem], threadID: String) {
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
    private(set) var connectionState: PathwayThreadConnectionState = .idle
    private(set) var items: [PathwayTimelineItem] = []
    private(set) var isSending = false
    var draft = "" {
        didSet { saveDraft() }
    }

    @ObservationIgnored private let connect: PathwayConnectClient
    @ObservationIgnored private let environment: PathwayCompanyEnvironment
    @ObservationIgnored private let thread: PathwayAgentThread
    @ObservationIgnored private let cache: PathwayThreadCache
    @ObservationIgnored private var rpc: PathwayRPCClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var lastSequence = 0

    init(
        thread: PathwayAgentThread,
        environment: PathwayCompanyEnvironment,
        connect: PathwayConnectClient,
        cache: PathwayThreadCache = PathwayThreadCache()
    ) {
        self.thread = thread
        self.environment = environment
        self.connect = connect
        self.cache = cache
        draft = UserDefaults.standard.string(forKey: Self.draftKey(thread.id)) ?? ""
    }

    deinit {
        streamTask?.cancel()
        if let rpc {
            Task { await rpc.stop() }
        }
    }

    func start() {
        guard streamTask == nil else { return }
        connectionState = .connecting
        streamTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if let cached = await cache.load(threadID: thread.id), items.isEmpty {
                items = cached
                connectionState = .cached
            }
            let connect = connect
            let environment = environment
            let rpc = PathwayRPCClient {
                try await connect.prepare(environment: environment).webSocketURL
            }
            self.rpc = rpc
            do {
                for try await value in await rpc.subscribeToThread(thread.threadId) {
                    guard !Task.isCancelled else { return }
                    apply(value)
                }
            } catch is CancellationError {
                return
            } catch {
                connectionState = items.isEmpty ? .failed(error.localizedDescription) : .cached
            }
        }
    }

    func stop() async {
        streamTask?.cancel()
        streamTask = nil
        await rpc?.stop()
        rpc = nil
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, let rpc else { return }
        isSending = true
        defer { isSending = false }
        do {
            _ = try await rpc.request(
                "orchestration.dispatchCommand",
                payload: PathwayAgentThreadCommands.dispatchMessage(
                    threadID: thread.threadId,
                    text: text,
                    hasActiveRun: thread.shell.activeRunId != nil
                )
            )
            draft = ""
        } catch {
            connectionState = .failed(error.localizedDescription)
        }
    }

    func respondToApproval(requestID: String, decision: String) async {
        await dispatchRuntimeResponse(
            requestID: requestID,
            fields: ["decision": .string(decision)]
        )
    }

    func respondToQuestion(requestID: String, questionID: String, answer: String) async {
        await dispatchRuntimeResponse(
            requestID: requestID,
            fields: ["answers": .object([questionID: .string(answer)])]
        )
    }

    private func dispatchRuntimeResponse(
        requestID: String,
        fields: [String: JSONValue]
    ) async {
        guard let rpc else { return }
        do {
            _ = try await rpc.request(
                "orchestration.dispatchCommand",
                payload: PathwayAgentThreadCommands.runtimeResponse(
                    threadID: thread.threadId,
                    requestID: requestID,
                    fields: fields
                )
            )
        } catch {
            connectionState = .failed(error.localizedDescription)
        }
    }

    private func apply(_ value: JSONValue) {
        guard let object = value.objectValue, let kind = object["kind"]?.stringValue else { return }
        switch kind {
        case "snapshot":
            guard let projection = object["projection"]?.objectValue else { return }
            let rows = projection["visibleTurnItems"]?.arrayValue ?? []
            items = rows.compactMap { row in
                row.objectValue?["item"].flatMap(PathwayTimelineItem.init(json:))
            }.sorted(by: Self.order)
            lastSequence = object["snapshotSequence"]?.intValue ?? 0
            connectionState = .live
            persist()
        case "event":
            guard
                let sequence = object["sequence"]?.intValue,
                sequence > lastSequence,
                let event = object["event"]?.objectValue
            else { return }
            lastSequence = sequence
            // swiftlint:disable opening_brace
            if event["type"]?.stringValue == "turn-item.updated",
               let payload = event["payload"],
               let item = PathwayTimelineItem(json: payload)
            {
                upsert(item)
            }
            // swiftlint:enable opening_brace
            connectionState = .live
        case "synchronized":
            connectionState = .live
        default:
            return
        }
    }

    private func upsert(_ item: PathwayTimelineItem) {
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index] = item
        } else {
            items.append(item)
        }
        items.sort(by: Self.order)
        persist()
    }

    private func persist() {
        let snapshot = items
        let threadID = thread.id
        Task { await cache.save(items: snapshot, threadID: threadID) }
    }

    private func saveDraft() {
        let key = Self.draftKey(thread.id)
        if draft.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(draft, forKey: key)
        }
    }

    private static func draftKey(_ threadID: String) -> String {
        "pathway.agent-thread.draft.\(threadID)"
    }

    private static func order(_ left: PathwayTimelineItem, _ right: PathwayTimelineItem) -> Bool {
        if left.ordinal == right.ordinal { return left.id < right.id }
        return left.ordinal < right.ordinal
    }
}
