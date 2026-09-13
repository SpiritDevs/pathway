import Foundation
import Observation
import CryptoKit
import UniformTypeIdentifiers

struct PathwayAssetUsage: Identifiable, Equatable, Sendable {
    let contextID: String
    let kind: String
    let title: String?
    let environmentID: String?
    let messageID: String?
    var id: String { "\(kind):\(environmentID ?? ""):\(contextID):\(messageID ?? "")" }
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue, let kind = fields["kind"]?.stringValue else { return nil }
        contextID = id; self.kind = kind; title = fields["title"]?.stringValue
        environmentID = fields["environmentId"]?.stringValue; messageID = fields["messageId"]?.stringValue
    }
}

struct PathwayAssetShare: Identifiable, Equatable, Sendable {
    let id: String
    let expiresAt: Date
    let revoked: Bool
    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue else { return nil }
        self.id = id; expiresAt = Date(timeIntervalSince1970: Double(fields["expiresAt"]?.intValue ?? 0) / 1000)
        revoked = fields["revokedAt"]?.intValue != nil
    }
}

struct PathwayAsset: Identifiable, Equatable, Sendable {
    let id: String
    let companyID: String
    var name: String
    let mimeType: String
    let byteSize: Int
    let kind: String
    let state: String
    let previewState: String
    let originalReady: Bool
    let createdAt: Double
    let uploaderID: String?
    let uploaderName: String?
    let canManage: Bool
    let canShare: Bool
    let kept: Bool
    let usages: [PathwayAssetUsage]
    let shares: [PathwayAssetShare]
    let legacyPublic: Bool

    init?(_ value: JSONValue, companyID: String) {
        guard let fields = value.objectValue, let id = fields["id"]?.stringValue ?? fields["_id"]?.stringValue else { return nil }
        self.id = id; self.companyID = companyID
        name = fields["name"]?.stringValue ?? fields["fileName"]?.stringValue ?? "File"
        mimeType = fields["mimeType"]?.stringValue ?? "application/octet-stream"
        byteSize = fields["byteSize"]?.intValue ?? 0
        kind = fields["kind"]?.stringValue ?? "file"
        state = fields["state"]?.stringValue ?? "pending"
        previewState = fields["previewState"]?.stringValue ?? "pending"
        originalReady = fields["originalReady"]?.boolValue ?? false
        createdAt = Double(fields["createdAt"]?.intValue ?? 0)
        uploaderID = fields["uploaderId"]?.stringValue
        uploaderName = fields["uploaderName"]?.stringValue
        canManage = fields["permissions"]?.objectValue?["canManage"]?.boolValue ?? false
        canShare = fields["permissions"]?.objectValue?["canShare"]?.boolValue ?? false
        kept = fields["keepInLibrary"]?.boolValue ?? false
        usages = (fields["contexts"]?.arrayValue ?? []).compactMap(PathwayAssetUsage.init)
        shares = (fields["shares"]?.arrayValue ?? []).compactMap(PathwayAssetShare.init)
        legacyPublic = fields["legacyPublic"]?.boolValue ?? false
    }
    var isMedia: Bool { kind == "image" || kind == "video" }
    var isTrashed: Bool { state == "trashed" || state == "purged" }
    var icon: String {
        switch kind { case "image": "photo"; case "video": "video"; case "audio": "waveform"; case "document": "doc.text"; default: "doc" }
    }
    var statusLabel: String {
        if state == "ready", previewState == "failed" { return "Preview failed · Original available" }
        return switch state {
        case "ready": "Ready"
        case "uploaded", "preparing", "preparing-preview": "Preparing preview"
        case "uploading", "reserved": "Uploading"
        case "failed": "Upload failed"
        case "trashed", "purged": "Asset deleted"
        default: "Upload pending"
        }
    }
}

@MainActor @Observable
final class PathwayAssetsModel {
    typealias Request = @MainActor (String, String, JSONValue) async throws -> JSONValue
    private(set) var items: [PathwayAsset] = []
    private(set) var loading = false
    private(set) var busy = false
    var error: String?
    private(set) var usedBytes = 0
    private(set) var maxBytes = 10 * 1024 * 1024 * 1024
    private(set) var maxFileBytes = 250 * 1024 * 1024
    private(set) var canConfigureQuota = false
    private(set) var nextCursor: String?
    private(set) var uploadLabel: String?
    private(set) var lastUploadedAssetID: String?
    @ObservationIgnored let request: Request
    @ObservationIgnored private let mediaResolver: (@MainActor (PathwayAsset, Bool) async throws -> URL)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lastArguments: [String: JSONValue] = [:]
    @ObservationIgnored private var pendingUpload: (url: URL, requestID: String, assetID: String?)?
    init(mediaResolver: (@MainActor (PathwayAsset, Bool) async throws -> URL)? = nil, request: @escaping Request) { self.mediaResolver = mediaResolver; self.request = request }

    func load(companyID: String, threadID: String? = nil, environmentID: String? = nil,
              search: String = "", kind: String? = nil, trashed: Bool = false, more: Bool = false, uploaderID: String? = nil, createdAfter: Int? = nil, sort: String = "newest") async {
        generation += 1
        let current = generation
        loading = true
        var arguments: [String: JSONValue] = ["companyId": .string(companyID), "limit": .number(50), "trashed": .bool(trashed)]
        arguments["sort"] = .string(sort)
        if let uploaderID { arguments["uploaderId"] = .string(uploaderID) }
        if let createdAfter { arguments["createdAfter"] = .number(Double(createdAfter)) }
        if let threadID { arguments["threadId"] = .string(threadID) }
        if let environmentID { arguments["environmentId"] = .string(environmentID) }
        if !search.isEmpty { arguments["search"] = .string(search) }
        if let kind { arguments["kind"] = .string(kind) }
        lastArguments = arguments
        if more, let nextCursor { arguments["cursor"] = .string(nextCursor) }
        do {
            let response = try await request("query", "assets:list", .object(arguments))
            guard generation == current else { return }
            let values = (response.objectValue?["items"]?.arrayValue ?? []).compactMap { PathwayAsset($0, companyID: companyID) }
            if more { items += values.filter { asset in !items.contains { $0.id == asset.id } } } else { items = values }
            nextCursor = response.objectValue?["nextCursor"]?.stringValue
            let usage = response.objectValue?["usage"]?.objectValue
            usedBytes = usage?["usedBytes"]?.intValue ?? 0
            maxBytes = usage?["maxBytes"]?.intValue ?? maxBytes
            maxFileBytes = usage?["maxFileBytes"]?.intValue ?? maxFileBytes
            canConfigureQuota = usage?["canConfigureQuota"]?.boolValue ?? false
            error = nil
        } catch { if generation == current { self.error = error.localizedDescription } }
        if generation == current { loading = false }
    }

    func mutate(_ operation: String, asset: PathwayAsset, extra: [String: JSONValue] = [:]) async throws -> JSONValue {
        var arguments = extra
        arguments["companyId"] = .string(asset.companyID); arguments["assetId"] = .string(asset.id)
        return try await request("mutation", "assets:\(operation)", .object(arguments))
    }
    func resolve(_ asset: PathwayAsset, original: Bool = false, poster: Bool = false) async throws -> URL {
        if let mediaResolver { return try await mediaResolver(asset, original) }
        let value = try await mutate("resolve", asset: asset, extra: ["representation": .string(poster ? "poster" : original ? "original" : "preview")])
        guard let raw = value.objectValue?["url"]?.stringValue, let url = URL(string: raw), url.scheme == "https" else {
            throw PathwayIssueWriteError(message: "This file is not available yet.")
        }
        return url
    }

    /// Preserve the original in an app-owned temporary file so retry survives a dismissed file picker.
    func upload(url: URL, companyID: String, context: JSONValue? = nil, clientRequestID: String? = nil, fileName: String? = nil, retryFinalization: Bool = false) async {
        guard !busy else { return }
        let retryingFinalization = retryFinalization || pendingUpload?.assetID != nil
        busy = true; error = nil; lastUploadedAssetID = nil; uploadLabel = "Preparing upload…"
        defer { busy = false }
        do {
            let staged: URL
            let requestID: String
            if let pendingUpload, pendingUpload.url == url {
                staged = url; requestID = pendingUpload.requestID
            } else {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let sourceSize = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard sourceSize > 0, sourceSize <= maxFileBytes else { throw PathwayIssueWriteError(message: "The file exceeds the upload limit or is empty.") }
                let directory = FileManager.default.temporaryDirectory.appending(path: "PathwayAssetUploads/\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                staged = directory.appending(path: URL(fileURLWithPath: fileName ?? url.lastPathComponent).lastPathComponent)
                try await Task.detached { try FileManager.default.copyItem(at: url, to: staged) }.value
                requestID = clientRequestID ?? UUID().uuidString.lowercased()
                pendingUpload = (staged, requestID, nil)
            }
            let size = try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= maxFileBytes else { throw PathwayIssueWriteError(message: "The file exceeds the upload limit or is empty.") }
            let checksum = try await Task.detached {
                let handle = try FileHandle(forReadingFrom: staged); defer { try? handle.close() }
                var hash = SHA256()
                while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hash.update(data: chunk) }
                return hash.finalize().map { String(format: "%02x", $0) }.joined()
            }.value
            let mime = UTType(filenameExtension: staged.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            var args: [String: JSONValue] = ["companyId": .string(companyID), "clientRequestId": .string(requestID),
                "fileName": .string(staged.lastPathComponent), "mimeType": .string(mime), "byteSize": .number(Double(size)), "checksum": .string(checksum)]
            if let context { args["context"] = context }
            uploadLabel = "Uploading \(staged.lastPathComponent)…"
            let prepared = try await request("action", "assets:prepareUpload", .object(args))
            guard let fields = prepared.objectValue, let assetID = fields["assetId"]?.stringValue else { throw PathwayIssueWriteError(message: "Could not prepare this upload.") }
            pendingUpload = (staged, requestID, assetID)
            var verified = false
            if retryingFinalization {
                let confirmation = try? await request("action", "assets:finalizeUpload", .object([
                    "companyId": .string(companyID), "assetId": .string(assetID)]))
                verified = confirmation?.objectValue?["originalReady"]?.boolValue == true
            }
            if !verified, let rawURL = fields["uploadUrl"]?.stringValue {
                guard let uploadURL = URL(string: rawURL), uploadURL.scheme == "https" else { throw URLError(.badURL) }
                let boundary = UUID().uuidString
                let bodyURL = staged.deletingLastPathComponent().appending(path: "multipart-upload")
                try await Task.detached {
                    let safeName = staged.lastPathComponent.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
                    let header = "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n"
                    try Data(header.utf8).write(to: bodyURL)
                    let output = try FileHandle(forWritingTo: bodyURL); defer { try? output.close() }
                    try output.seekToEnd()
                    let input = try FileHandle(forReadingFrom: staged); defer { try? input.close() }
                    while let data = try input.read(upToCount: 1_048_576), !data.isEmpty { try output.write(contentsOf: data) }
                    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
                }.value
                defer { try? FileManager.default.removeItem(at: bodyURL) }
                var upload = URLRequest(url: uploadURL); upload.httpMethod = "PUT"
                upload.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                upload.setValue("bytes=0-", forHTTPHeaderField: "Range")
                upload.setValue("7.7.4", forHTTPHeaderField: "x-uploadthing-version")
                let (_, response) = try await URLSession.shared.upload(for: upload, fromFile: bodyURL)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.cannotWriteToFile) }
            }
            uploadLabel = "Verifying upload…"
            if !verified {
                let confirmation = try await request("action", "assets:finalizeUpload", .object(["companyId": .string(companyID), "assetId": .string(assetID)]))
                guard confirmation.objectValue?["originalReady"]?.boolValue == true else { throw URLError(.badServerResponse) }
            }
            try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
            lastUploadedAssetID = assetID
            pendingUpload = nil; uploadLabel = nil
        } catch { self.error = error.localizedDescription; uploadLabel = "Upload pending · Retry" }
    }
    func retryUpload(companyID: String, context: JSONValue? = nil) async {
        guard let pendingUpload else { return }
        await upload(url: pendingUpload.url, companyID: companyID, context: context)
    }
}

@MainActor @Observable
final class PathwayAssetsIndex {
    private(set) var counts: [String: Int] = [:]
    @ObservationIgnored private weak var cloud: PathwayCloudModel?
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    init(cloud: PathwayCloudModel) { self.cloud = cloud }
    func count(_ thread: PathwayAgentThread) -> Int { counts["\(thread.companyId)/\(thread.environmentId)/\(thread.id)"] ?? 0 }
    func observe(companies: [String]) {
        for company in Array(tasks.keys) where !companies.contains(company) { tasks.removeValue(forKey: company)?.cancel() }
        for company in companies where tasks[company] == nil {
            tasks[company] = Task { [weak self] in
                guard let self, let cloud else { return }
                do {
                    for try await value in cloud.subscribe(name: "assets:threadCounts", arguments: .object(["companyId": .string(company)])) {
                        counts = counts.filter { !$0.key.hasPrefix(company + "/") }
                        for value in value.arrayValue ?? [] {
                            guard let object = value.objectValue, let thread = object["threadId"]?.stringValue else { continue }
                            counts["\(company)/\(object["environmentId"]?.stringValue ?? "")/\(thread)"] = object["count"]?.intValue ?? 0
                        }
                    }
                } catch { /* Older cloud deployments have no asset index. Existing threads remain usable. */ }
            }
        }
    }
    func stop() { tasks.values.forEach { $0.cancel() }; tasks.removeAll(); counts.removeAll() }
    isolated deinit { tasks.values.forEach { $0.cancel() } }
}
