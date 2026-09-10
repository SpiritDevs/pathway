import CryptoKit
import Foundation
import Observation

// Keep account guards, disk receipts, and delivery transitions together for review.
// swiftlint:disable file_length type_body_length

struct PathwayThreadQueueRejected: Error, LocalizedError, Sendable {
    let code: String?
    let message: String
    var errorDescription: String? { message }
}

struct PathwayQueuedThread: Identifiable, Equatable, Sendable {
    let companyID: String
    let fields: [String: JSONValue]
    var threadID: String { fields["threadId"]?.stringValue ?? "" }
    var environmentID: String { fields["environmentId"]?.stringValue ?? "" }
    var id: String { "\(companyID):\(threadID)" }
    var title: String { fields["title"]?.stringValue ?? "New thread" }
    var state: String { fields["state"]?.stringValue ?? "queued" }
    var revision: Int { fields["revision"]?.intValue ?? 0 }
    var status: String {
        if (fields["localCount"]?.intValue ?? 0) > 0 { return "Waiting to sync" }
        return switch state {
        case "local": "Waiting to sync"
        case "blocked": "Needs attention"
        case "accepted": "Starting"
        case "delivered": "Sent to environment"
        case "canceled": "Canceled"
        default: "Queued · Saved to cloud"
        }
    }
}

struct PathwayQueueFile: Codable, Sendable {
    var metadata: JSONValue
    var data: Data
    var cloudID: String?
    var localDataFile: String?

    static func captureUpload(_ value: JSONValue) throws -> Self {
        guard var fields = value.objectValue, let dataURL = fields.removeValue(forKey: "dataUrl")?.stringValue,
              let comma = dataURL.firstIndex(of: ","), let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
        else {
            throw PathwayThreadConversationError.message("An image's bytes are unavailable. Add the image again before sending.")
        }
        fields["id"] = fields["id"] ?? .string(UUID().uuidString.lowercased())
        fields["sizeBytes"] = .number(Double(data.count))
        return Self(metadata: .object(fields), data: data)
    }

    static func capture(_ draft: PathwayThreadAttachmentDraft, bytes: Data?) throws -> Self {
        guard let bytes else { throw PathwayThreadConversationError.message("Attachment bytes are unavailable. Add the file again before sending.") }
        return Self(metadata: .object(["id": .string(draft.id), "name": .string(draft.name),
                                       "mimeType": .string(draft.mimeType), "type": .string(draft.type), "sizeBytes": .number(Double(bytes.count))]), data: bytes)
    }
}

struct PathwayLocalQueueEntry: Codable, Sendable, Identifiable {
    let companyID: String
    let environmentID: String
    let threadID: String
    let commandID: String
    var submission: JSONValue
    var files: [PathwayQueueFile]
    var error: String?
    var localRevision: Int?
    var submissionStarted: Bool?
    var id: String { "\(companyID):\(commandID)" }
}

actor PathwayThreadQueueStore {
    let url: URL
    private var revision: UInt64 = 0
    private nonisolated var filesDirectory: URL { url.deletingLastPathComponent().appending(path: "ThreadQueueAttachments") }
    init(directory: URL) { url = directory.appending(path: "ThreadQueue.json") }

    nonisolated func attachmentURL(entryID: String, attachmentID: String) -> URL {
        let identity = entryID + ":" + attachmentID
        let name = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return filesDirectory.appending(path: name)
    }

    func load() throws -> [PathwayLocalQueueEntry] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        var entries = try JSONDecoder().decode([PathwayLocalQueueEntry].self, from: Data(contentsOf: url))
        for entryIndex in entries.indices {
            for fileIndex in entries[entryIndex].files.indices {
                guard let name = entries[entryIndex].files[fileIndex].localDataFile else { continue }
                guard name.count == 64, name.allSatisfy(\.isHexDigit) else { throw CocoaError(.fileReadCorruptFile) }
                entries[entryIndex].files[fileIndex].data = try Data(contentsOf: filesDirectory.appending(path: name))
            }
        }
        return entries
    }

    func save(_ entries: [PathwayLocalQueueEntry], revision next: UInt64 = DispatchTime.now().uptimeNanoseconds) throws {
        guard next >= revision else { return }
        let manager = FileManager.default
        try manager.createDirectory(at: filesDirectory, withIntermediateDirectories: true)
        var manifest = entries
        var retainedFiles: Set<String> = []
        for entryIndex in manifest.indices {
            for fileIndex in manifest[entryIndex].files.indices {
                let file = manifest[entryIndex].files[fileIndex]
                let attachmentID = file.metadata.objectValue?["id"]?.stringValue ?? String(fileIndex)
                let identity = manifest[entryIndex].id + ":" + attachmentID
                let name = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
                let fileURL = filesDirectory.appending(path: name)
                if !manager.fileExists(atPath: fileURL.path) {
                    try file.data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                }
                retainedFiles.insert(name)
                manifest[entryIndex].files[fileIndex].localDataFile = name
                manifest[entryIndex].files[fileIndex].data = Data()
            }
        }
        try JSONEncoder().encode(manifest).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        revision = next
        // Bytes are immutable and written before their manifest. Only collect them after the
        // replacement manifest is durable, so a failed save cannot destroy the previous draft.
        for name in (try? manager.contentsOfDirectory(atPath: filesDirectory.path)) ?? [] where !retainedFiles.contains(name) {
            try? manager.removeItem(at: filesDirectory.appending(path: name))
        }
    }
}

/// Account-owned outbox. Its lifetime is the cloud session, not an open conversation view.
@MainActor @Observable
final class PathwayThreadQueueModel {
    typealias Request = @MainActor (String, String, JSONValue) async throws -> JSONValue
    typealias Subscribe = @MainActor (String, JSONValue) -> AsyncThrowingStream<JSONValue, Error>
    private(set) var threads: [PathwayQueuedThread] = []
    private(set) var errorMessage: String?
    @ObservationIgnored private let request: Request
    @ObservationIgnored private let subscribe: Subscribe
    @ObservationIgnored private var store: PathwayThreadQueueStore?
    @ObservationIgnored private var stores: [URL: PathwayThreadQueueStore] = [:]
    @ObservationIgnored private var local: [PathwayLocalQueueEntry] = []
    @ObservationIgnored private var captures: Set<String> = []
    @ObservationIgnored private var remote: [String: [PathwayQueuedThread]] = [:]
    @ObservationIgnored private var detailCache: [String: JSONValue] = [:]
    @ObservationIgnored private var acknowledgedRows: [String: PathwayQueuedThread] = [:]
    @ObservationIgnored private var observers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var drain: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var drainGeneration = UUID()
    @ObservationIgnored private var companyIDs: Set<String> = []
    @ObservationIgnored private var storageReady = false

    init(request: @escaping Request, subscribe: @escaping Subscribe) {
        self.request = request; self.subscribe = subscribe
    }

    func configure(directory: URL?) async {
        stop(clear: true)
        store = directory.map { directory in
            if let existing = stores[directory] { return existing }
            let created = PathwayThreadQueueStore(directory: directory)
            stores[directory] = created
            return created
        }
        storageReady = false
        let current = generation
        do {
            let restored = try await store?.load() ?? []
            guard current == generation else { return }
            local = restored; storageReady = store != nil; rebuild()
        } catch {
            guard current == generation else { return }
            errorMessage = "Saved queued messages could not be read. " + error.localizedDescription
        }
    }

    func observe(companies: [String]) {
        companyIDs = Set(companies)
        for id in Array(observers.keys) where !companyIDs.contains(id) {
            observers.removeValue(forKey: id)?.cancel(); remote.removeValue(forKey: id)
        }
        let current = generation
        for id in companies where observers[id] == nil {
            observers[id] = Task { [weak self] in
                guard let self else { return }
                do {
                    for try await value in subscribe("threadQueue:list", .object(["companyId": .string(id)])) {
                        guard !Task.isCancelled, current == generation else { return }
                        remote[id] = (value.arrayValue ?? []).compactMap { value in
                            guard let fields = value.objectValue, fields["threadId"]?.stringValue != nil else { return nil }
                            return PathwayQueuedThread(companyID: id, fields: fields)
                        }
                        for row in remote[id] ?? [] {
                            acknowledgedRows.removeValue(forKey: row.id)
                        }
                        rebuild(); flush()
                    }
                } catch {
                    guard current == generation, !Task.isCancelled else { return }
                    errorMessage = error.localizedDescription
                }
                if current == generation, !Task.isCancelled { observers.removeValue(forKey: id) }
            }
        }
        rebuild(); flush()
    }

    func stop(clear: Bool = false) {
        generation = UUID()
        for task in observers.values {
            task.cancel()
        }
        observers = [:]; stopDrain(); companyIDs = []; captures = []
        if clear { local = []; remote = [:]; detailCache = [:]; acknowledgedRows = [:]; threads = []; store = nil; storageReady = false; errorMessage = nil }
    }

    func enqueue(companyID: String, environmentID: String, threadID: String, submission: JSONValue, files: [PathwayQueueFile] = []) async throws {
        guard storageReady, let store else { throw PathwayThreadConversationError.message("Sign in and finish loading local storage before sending.") }
        guard companyIDs.contains(companyID), let commandID = submission.objectValue?["input"]?.objectValue?["commandId"]?.stringValue else {
            throw PathwayThreadConversationError.message("This company is unavailable. Your draft has been kept.")
        }
        var normalized = submission.objectValue ?? [:]
        var input = normalized["input"]?.objectValue ?? [:]
        if normalized["kind"]?.stringValue == "launch" {
            var message = input["initialMessage"]?.objectValue ?? [:]
            message["attachments"] = .array(files.map(\.metadata)); input["initialMessage"] = .object(message)
        } else { input["attachments"] = .array(files.map(\.metadata)) }
        normalized["input"] = .object(input)
        let entry = PathwayLocalQueueEntry(companyID: companyID, environmentID: environmentID, threadID: threadID, commandID: commandID, submission: .object(normalized), files: files)
        let inserted = !local.contains(where: { $0.id == entry.id })
        if inserted { local.append(entry) }
        let current = generation
        captures.insert(entry.id)
        stopDrain()
        do {
            try await store.save(local)
            guard current == generation else { throw CancellationError() }
            captures.remove(entry.id)
            rebuild(); flush()
        } catch {
            guard current == generation else { throw CancellationError() }
            captures.remove(entry.id)
            // The composer retains a failed capture. It must not later be sent by a
            // subscription callback while the user retries that same visible draft.
            if inserted { local.removeAll { $0.id == entry.id } }
            try? await store.save(local)
            guard current == generation else { throw CancellationError() }
            rebuild(); flush()
            throw error
        }
    }

    /// A conversation can render immediately from local state while cloud reconciliation runs.
    func cachedDetail(_ thread: PathwayQueuedThread) -> JSONValue {
        guard companyIDs.contains(thread.companyID) else { return .object(["messages": .array([])]) }
        var result = detailCache[thread.id]?.objectValue ?? [:]
        result["thread"] = .object(thread.fields)
        let confirmed = result["messages"]?.arrayValue ?? []
        let confirmedIDs = Set(confirmed.compactMap { $0.objectValue?["commandId"]?.stringValue })
        var messages = confirmed
        var urls = result["attachmentUrls"]?.objectValue ?? [:]
        for entry in local where entry.companyID == thread.companyID && entry.threadID == thread.threadID && !confirmedIDs.contains(entry.commandID) {
            messages.append(.object(["commandId": .string(entry.commandID), "submission": entry.submission,
                                     "state": .string("local"), "revision": .number(Double(entry.localRevision ?? 0)),
                                     "editable": .bool(entry.submissionStarted != true), "acceptedAt": .null,
                                     "error": entry.error.map(JSONValue.string) ?? .null]))
            for file in entry.files {
                if let id = file.metadata.objectValue?["id"]?.stringValue, let store {
                    urls[id] = .string(store.attachmentURL(entryID: entry.id, attachmentID: id).absoluteString)
                }
            }
        }
        result["messages"] = .array(messages)
        result["attachmentUrls"] = .object(urls)
        return .object(result)
    }

    // Each cloud await must keep its account fence and local receipt reconciliation visible.
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    func detail(_ thread: PathwayQueuedThread) async throws -> JSONValue {
        let current = generation
        guard companyIDs.contains(thread.companyID) else { throw CancellationError() }
        let localEntries = local.filter { $0.companyID == thread.companyID && $0.threadID == thread.threadID }
        let pending = localEntries.map {
            JSONValue.object(["commandId": .string($0.commandID), "submission": $0.submission,
                              "state": .string("local"), "revision": .number(Double($0.localRevision ?? 0)),
                              "editable": .bool($0.submissionStarted != true), "acceptedAt": .null,
                              "error": $0.error.map(JSONValue.string) ?? .null])
        }
        var result = detailCache[thread.id]?.objectValue ?? ["thread": .object(thread.fields), "messages": .array([])]
        if thread.state != "local" || localEntries.contains(where: { $0.submissionStarted == true }) {
            do {
                result = try await request("query", "threadQueue:getThread", .object(["companyId": .string(thread.companyID), "threadId": .string(thread.threadID)])).objectValue ?? result
            } catch { if pending.isEmpty { throw error } }
        }
        guard current == generation, companyIDs.contains(thread.companyID) else { throw CancellationError() }
        detailCache[thread.id] = .object(result)
        let confirmed = result["messages"]?.arrayValue ?? []
        var ids = Set(confirmed.compactMap { $0.objectValue?["commandId"]?.stringValue })
        // Queue detail omits delivered bodies. Check each uncertain command's indexed receipt
        // instead of treating absence from that filtered view as proof it was never saved.
        for entry in localEntries where entry.submissionStarted == true && !ids.contains(entry.commandID) {
            let status = try? await request("query", "threadQueue:submissionStatus", .object([
                "companyId": .string(entry.companyID), "threadId": .string(entry.threadID), "commandId": .string(entry.commandID)
            ]))
            guard current == generation, companyIDs.contains(thread.companyID) else { throw CancellationError() }
            if status?.objectValue?["commandId"]?.stringValue == entry.commandID {
                ids.insert(entry.commandID)
                if !(remote[thread.companyID] ?? []).contains(where: { $0.threadID == thread.threadID }) {
                    var fields = thread.fields
                    fields["state"] = status?.objectValue?["state"] ?? .string("queued")
                    fields.removeValue(forKey: "localCount")
                    acknowledgedRows[thread.id] = PathwayQueuedThread(companyID: thread.companyID, fields: fields)
                }
            }
        }
        if local.contains(where: { $0.companyID == thread.companyID && $0.threadID == thread.threadID && ids.contains($0.commandID) }), let store {
            stopDrain()
            local.removeAll { $0.companyID == thread.companyID && $0.threadID == thread.threadID && ids.contains($0.commandID) }
            try await store.save(local)
            guard current == generation, !Task.isCancelled else { throw CancellationError() }
            rebuild(); flush()
        }
        var urls = result["attachmentUrls"]?.objectValue ?? [:]
        if let store {
            for entry in localEntries where !ids.contains(entry.commandID) {
                for file in entry.files {
                    guard let id = file.metadata.objectValue?["id"]?.stringValue else { continue }
                    let url = store.attachmentURL(entryID: entry.id, attachmentID: id)
                    guard current == generation else { throw CancellationError() }
                    if urls[id] == nil { urls[id] = .string(url.absoluteString) }
                }
            }
        }
        result["attachmentUrls"] = .object(urls)
        result["messages"] = .array(confirmed + pending.filter { !ids.contains($0.objectValue?["commandId"]?.stringValue ?? "") })
        return .object(result)
    }

    func destinations(companyID: String, threadID: String? = nil) async throws -> JSONValue {
        let current = generation
        guard companyIDs.contains(companyID) else { throw CancellationError() }
        var args: [String: JSONValue] = ["companyId": .string(companyID)]
        if let threadID { args["threadId"] = .string(threadID) }
        let result = try await request("query", "threadQueue:destinations", .object(args))
        guard current == generation, companyIDs.contains(companyID), !Task.isCancelled else { throw CancellationError() }
        return result
    }

    // Local and cloud commands share one explicit revision/acceptance gate.
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    func mutate(_ operation: String, thread: PathwayQueuedThread, fields: [String: JSONValue] = [:]) async throws {
        let current = generation
        guard companyIDs.contains(thread.companyID), let store else { throw CancellationError() }
        let localIndex = fields["commandId"]?.stringValue.flatMap { commandID in
            local.firstIndex { $0.companyID == thread.companyID && $0.threadID == thread.threadID && $0.commandID == commandID }
        }
        if let index = localIndex {
            let commandID = local[index].commandID
            if operation == "retry" { flush(); return }
            guard local[index].submissionStarted != true else {
                throw PathwayThreadConversationError.message("This message may already be saved to the cloud. Try syncing again before editing or canceling it.")
            }
            guard fields["revision"]?.intValue == (local[index].localRevision ?? 0) else {
                throw PathwayThreadConversationError.message("This message changed. Refresh before editing it again.")
            }
            let original = local
            stopDrain()
            if operation == "edit", let text = fields["text"]?.stringValue {
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !local[index].files.isEmpty else {
                    throw PathwayThreadConversationError.message("Add a message or attachment before saving.")
                }
                var submission = local[index].submission.objectValue ?? [:]
                var input = submission["input"]?.objectValue ?? [:]
                if submission["kind"]?.stringValue == "launch" {
                    var message = input["initialMessage"]?.objectValue ?? [:]
                    message["text"] = .string(text); input["initialMessage"] = .object(message)
                } else { input["text"] = .string(text) }
                submission["input"] = .object(input)
                local[index].submission = .object(submission)
                local[index].localRevision = (local[index].localRevision ?? 0) + 1
                local[index].error = nil
            } else if operation == "cancel" {
                let launch = local[index].submission.objectValue?["kind"]?.stringValue == "launch"
                local.removeAll { $0.companyID == thread.companyID && $0.threadID == thread.threadID && (launch || $0.commandID == commandID) }
            } else { throw PathwayThreadConversationError.message("This action is unavailable until the thread is saved to the cloud.") }
            do {
                try await store.save(local)
            } catch {
                if current == generation {
                    let originalIDs = Set(original.map(\.id))
                    local = original + local.filter { !originalIDs.contains($0.id) }
                    rebuild()
                }
                throw error
            }
            guard current == generation, !Task.isCancelled else { throw CancellationError() }
            rebuild(); flush(); return
        }
        var args = fields
        args["companyId"] = .string(thread.companyID); args["threadId"] = .string(thread.threadID)
        _ = try await request("mutation", "threadQueue:\(operation)", .object(args))
        guard current == generation, !Task.isCancelled else { throw CancellationError() }
    }

    func retry() { flush() }

    private func stopDrain() {
        drainGeneration = UUID()
        drain?.cancel(); drain = nil
    }

    private func rebuild() {
        var rows = remote.filter { companyIDs.contains($0.key) }.values.flatMap(\.self)
        let syncedIDs = Set(rows.map(\.id))
        rows += acknowledgedRows.values.filter { companyIDs.contains($0.companyID) && !syncedIDs.contains($0.id) }
        let remoteIDs = Set(rows.map(\.id))
        var added = remoteIDs
        for entry in local where companyIDs.contains(entry.companyID) {
            let id = "\(entry.companyID):\(entry.threadID)"
            guard added.insert(id).inserted else { continue }
            let input = entry.submission.objectValue?["input"]?.objectValue ?? [:]
            rows.append(PathwayQueuedThread(companyID: entry.companyID, fields: ["threadId": .string(entry.threadID), "environmentId": .string(entry.environmentID),
                                                                                 "title": input["title"] ?? .string("Pending message"), "launch": entry.submission.objectValue?["kind"]?.stringValue == "launch" ? .object(input) : .null,
                                                                                 "localProjectId": input["projectId"] ?? .null, "state": .string("local"), "error": entry.error.map(JSONValue.string) ?? .null]))
        }
        rows = rows.map { row in
            let entries = local.filter { $0.companyID == row.companyID && $0.threadID == row.threadID }
            guard !entries.isEmpty else { return row }
            var fields = row.fields; fields["localCount"] = .number(Double(entries.count))
            fields["localState"] = .array(entries.map { .object(["commandId": .string($0.commandID),
                                                                 "revision": .number(Double($0.localRevision ?? 0)), "submitted": .bool($0.submissionStarted == true),
                                                                 "error": $0.error.map(JSONValue.string) ?? .null]) })
            return PathwayQueuedThread(companyID: row.companyID, fields: fields)
        }
        threads = rows.sorted { ($0.fields["updatedAt"]?.intValue ?? 0) > ($1.fields["updatedAt"]?.intValue ?? 0) }
    }

    // Keep persistence-before-send and post-await account guards in execution order.
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func flush() {
        guard captures.isEmpty, drain == nil, storageReady, let queueStore = store,
              local.contains(where: { companyIDs.contains($0.companyID) }) else { return }
        let current = generation
        let currentDrain = drainGeneration
        drain = Task { [weak self] in
            guard let self else { return }
            defer { if current == generation, currentDrain == drainGeneration { drain = nil } }
            @MainActor func check(_ companyID: String) throws {
                guard current == generation, currentDrain == drainGeneration,
                      companyIDs.contains(companyID), !Task.isCancelled else { throw CancellationError() }
            }
            // Stop on a failed entry so later messages cannot overtake it.
            while let first = local.first(where: { companyIDs.contains($0.companyID) }), current == generation, !Task.isCancelled {
                do {
                    try check(first.companyID)
                    // No background callback may submit an entry whose initial local save failed.
                    try await queueStore.save(local)
                    try check(first.companyID)
                    var entry = first
                    for index in entry.files.indices where entry.files[index].cloudID == nil {
                        let uploadURL = try await request("mutation", "threadQueue:generateUploadUrl", .object(["companyId": .string(entry.companyID)]))
                        try check(entry.companyID)
                        guard let url = uploadURL.stringValue.flatMap(URL.init(string:)) else { throw URLError(.badServerResponse) }
                        var upload = URLRequest(url: url); upload.httpMethod = "POST"
                        upload.setValue(entry.files[index].metadata.objectValue?["mimeType"]?.stringValue ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
                        let (data, response) = try await URLSession.shared.upload(for: upload, from: entry.files[index].data)
                        try check(entry.companyID)
                        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode),
                              let storageID = try JSONDecoder().decode(JSONValue.self, from: data).objectValue?["storageId"] else { throw URLError(.badServerResponse) }
                        let registered = try await request("mutation", "threadQueue:registerAttachment", .object(["companyId": .string(entry.companyID), "storageId": storageID, "attachment": entry.files[index].metadata]))
                        try check(entry.companyID)
                        guard let cloudID = registered.stringValue else { throw URLError(.badServerResponse) }
                        entry.files[index].cloudID = cloudID
                        guard let position = local.firstIndex(where: { $0.id == entry.id }) else { return }
                        local[position] = entry
                        try await queueStore.save(local)
                        try check(entry.companyID)
                    }
                    // A lost response does not prove enqueue failed. Once submission starts, edits
                    // and cancellation must wait for reconciliation with the cloud copy.
                    guard let position = local.firstIndex(where: { $0.id == entry.id }) else { return }
                    entry.submissionStarted = true; local[position] = entry
                    try await queueStore.save(local)
                    try check(entry.companyID)
                    rebuild()
                    _ = try await request("mutation", "threadQueue:enqueue", .object(["companyId": .string(entry.companyID), "environmentId": .string(entry.environmentID), "threadId": .string(entry.threadID), "submission": entry.submission, "attachmentIds": .array(entry.files.compactMap { $0.cloudID.map(JSONValue.string) })]))
                    try check(entry.companyID)
                    // Retain an acknowledged row until the subscription supplies its cloud replacement.
                    if !(remote[entry.companyID] ?? []).contains(where: { $0.threadID == entry.threadID }) {
                        let input = entry.submission.objectValue?["input"]?.objectValue ?? [:]
                        let row = PathwayQueuedThread(companyID: entry.companyID, fields: ["threadId": .string(entry.threadID), "environmentId": .string(entry.environmentID), "title": input["title"] ?? .string("Pending message"), "launch": entry.submission.objectValue?["kind"]?.stringValue == "launch" ? .object(input) : .null,
                                                                                           "localProjectId": input["projectId"] ?? .null, "state": .string("queued")])
                        acknowledgedRows[row.id] = row
                    }
                    local.removeAll { $0.id == entry.id }
                    try await queueStore.save(local)
                    try check(entry.companyID)
                    errorMessage = nil; rebuild()
                } catch {
                    guard current == generation, currentDrain == drainGeneration, !Task.isCancelled else { return }
                    var definitelyUnsubmitted = false
                    if error is PathwayThreadQueueRejected {
                        do {
                            let result = try await request("query", "threadQueue:submissionStatus", .object([
                                "companyId": .string(first.companyID), "threadId": .string(first.threadID), "commandId": .string(first.commandID)
                            ]))
                            try check(first.companyID)
                            definitelyUnsubmitted = result == .null
                        } catch {}
                    }
                    guard current == generation, currentDrain == drainGeneration, !Task.isCancelled else { return }
                    if let index = local.firstIndex(where: { $0.id == first.id }) {
                        local[index].error = error.localizedDescription
                        if definitelyUnsubmitted { local[index].submissionStarted = false }
                    }
                    try? await queueStore.save(local)
                    guard current == generation, currentDrain == drainGeneration, !Task.isCancelled else { return }
                    errorMessage = error.localizedDescription; rebuild(); return
                }
            }
        }
    }
}

// swiftlint:enable file_length type_body_length
