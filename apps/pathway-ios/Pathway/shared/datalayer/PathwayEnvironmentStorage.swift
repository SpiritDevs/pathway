import Foundation
import Observation
import CryptoKit

struct PathwayStoragePolicy: Codable, Sendable {
    var enabled: Bool
    var afterDays: Int
    var warningBytes: Double
    var criticalBytes: Double
    var warningPercent: Double
    var criticalPercent: Double
    var autoSettleAfterDays: Int?
}

struct PathwayStorageVolume: Codable, Identifiable, Sendable {
    let id: String
    let path: String
    let totalBytes: Double
    let availableBytes: Double
    let sampledAt: String
    let pressure: String
    var usedFraction: Double { totalBytes > 0 ? max(0, min(1, 1 - availableBytes / totalBytes)) : 0 }
}

struct PathwayStorageThread: Codable, Identifiable, Sendable {
    let threadId: String
    let title: String
    let projectId: String?
    let worktreeId: String?
    let status: String
    let keepWorktree: Bool
    let threadDataBytes: Double?
    let eligibleSince: String?
    let reclaimedAt: String?
    var temporary: Bool? = nil
    var conversationCompanyId: String? = nil
    var id: String { threadId }
}

struct PathwayStorageWorktree: Codable, Identifiable, Sendable {
    let id: String
    let path: String
    let projectRoot: String?
    let branch: String?
    let volumeId: String?
    let threadIds: [String]
    let estimatedBytes: Double?
    let measuredAt: String?
    let kind: String
    let blockers: [String]
    let removed: Bool
}

struct PathwayStoragePreview: Codable, Sendable {
    struct Item: Codable, Identifiable, Sendable {
        let worktreeId: String
        let path: String
        let threadIds: [String]
        let estimatedBytes: Double?
        let eligible: Bool
        let blockers: [String]
        var id: String { worktreeId }
    }
    let items: [Item]
    let estimatedBytes: Double
}

struct PathwayStorageJob: Codable, Identifiable, Sendable {
    struct Item: Codable, Identifiable, Sendable {
        let worktreeId: String
        let status: String
        let message: String?
        let estimatedBytes: Double
        let actualFreeDeltaBytes: Double?
        var projectRoot: String? = nil
        var id: String { worktreeId }
    }
    let id: String
    let mode: String
    let status: String
    let startedAt: String
    let finishedAt: String?
    let items: [Item]
    var actualFreeDeltaBytes: Double? {
        let values = items.filter { $0.status == "removed" }.compactMap(\.actualFreeDeltaBytes)
        return values.isEmpty ? nil : values.reduce(0, +)
    }
}

struct PathwayStorageSnapshot: Codable, Sendable {
    let sampledAt: String
    let volumes: [PathwayStorageVolume]
    let worktrees: [PathwayStorageWorktree]
    let threads: [PathwayStorageThread]
    let policy: PathwayStoragePolicy
    let jobs: [PathwayStorageJob]
    let scanError: String?
    var runningJob: PathwayStorageJob? { jobs.first { $0.status == "running" } }
    var critical: Bool { volumes.contains { $0.pressure == "critical" } }
}

func pathwayStorageBytes(_ value: Double?) -> String {
    guard let value, value.isFinite, abs(value) < Double(Int64.max) else { return "Not measured" }
    return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
}

/// Each remote environment owns measurement, eligibility checks, and cleanup execution.
@MainActor
@Observable
final class PathwayEnvironmentStorageModel: Identifiable {
    let environment: PathwayCompanyEnvironment
    nonisolated let id: String
    private(set) var snapshot: PathwayStorageSnapshot?
    private(set) var hasCurrentSnapshot = false
    private(set) var error: String?
    private(set) var refreshing = false
    private(set) var performingAction = false
    private(set) var preview: PathwayStoragePreview?
    var selectedWorktrees: Set<String> = []
    @ObservationIgnored private let connect: PathwayConnectClient
    @ObservationIgnored private let cacheURL: URL?
    @ObservationIgnored var visibleProjectIDs: Set<String> = []
    @ObservationIgnored var visibleThreadIDs: Set<String> = []
    @ObservationIgnored var visibleRoots: Set<String> = []

    init(environment: PathwayCompanyEnvironment, connect: PathwayConnectClient, storageDirectory: URL? = nil) {
        id = environment.id
        self.environment = environment
        self.connect = connect
        let digest = SHA256.hash(data: Data(environment.id.utf8)).map { String(format: "%02x", $0) }.joined()
        cacheURL = storageDirectory?.appending(path: "EnvironmentStorage/\(digest).json")
    }

    static func request(environment: PathwayCompanyEnvironment, connect: PathwayConnectClient,
                        method: String, fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        let rpc = PathwayRPCClient {
            let connection = try await connect.prepare(environment: environment)
            let readOnly = method == "storage.snapshot" || method == "storage.preview" || method == "server.getHostResources"
            return readOnly ? connection.webSocketURL : try connection.threadOperationWebSocketURL()
        }
        do {
            let value = try await rpc.request(method, payload: .object(fields), requiresSubscription: false,
                                              waitForSubscription: false, timeout: .seconds(method == "server.getHostResources" ? 5 : 30))
            await rpc.stop()
            try Task.checkCancellation()
            return value
        } catch {
            await rpc.stop()
            throw error
        }
    }

    private func request(_ method: String, _ fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await Self.request(environment: environment, connect: connect, method: method, fields: fields)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        if snapshot == nil, let cacheURL {
            snapshot = await Task.detached {
                guard let data = try? Data(contentsOf: cacheURL) else { return nil as PathwayStorageSnapshot? }
                return try? JSONDecoder().decode(PathwayStorageSnapshot.self, from: data)
            }.value
            if let snapshot { self.snapshot = scoped(snapshot) }
        }
        do {
            let value = try await request("storage.snapshot")
            let next = scoped(try decode(PathwayStorageSnapshot.self, value))
            snapshot = next
            hasCurrentSnapshot = true
            if let cacheURL {
                await Task.detached {
                    do {
                        try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                        try JSONEncoder().encode(next).write(to: cacheURL, options: .atomic)
                    } catch { /* A cache write failure must not fail a live measurement. */ }
                }.value
            }
            error = nil
        } catch is CancellationError { }
        catch { hasCurrentSnapshot = false; self.error = error.localizedDescription }
    }

    func prepare(mode: String = "manual", ids: [String]? = nil) async {
        preview = nil
        await perform {
            let value = try await request("storage.preview", cleanupFields(mode, ids ?? Array(selectedWorktrees)))
            preview = try decode(PathwayStoragePreview.self, value)
        }
    }

    func start(mode: String = "manual", ids: [String]? = nil) async {
        let candidates = ids ?? preview?.items.filter(\.eligible).map(\.worktreeId) ?? []
        guard !candidates.isEmpty else { return }
        await perform {
            _ = try await request("storage.start", cleanupFields(mode, candidates))
            preview = nil
            selectedWorktrees.subtract(candidates)
            await refresh()
        }
    }

    func cancel(_ job: PathwayStorageJob) async {
        await perform {
            _ = try await request("storage.cancel", ["jobId": .string(job.id)])
            await refresh()
        }
    }

    func recreate(_ thread: PathwayStorageThread) async {
        await perform {
            _ = try await request("storage.recreate", ["threadId": .string(thread.threadId)])
            await refresh()
        }
    }

    func setKeep(_ thread: PathwayStorageThread, keep: Bool) async {
        await perform {
            _ = try await request("storage.setKeep", ["threadId": .string(thread.threadId), "keep": .bool(keep)])
            await refresh()
        }
    }

    func setPolicy(_ policy: PathwayStoragePolicy) async {
        await perform {
            let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(policy))
            var fields = value.objectValue ?? [:]
            fields["autoSettleAfterDays"] = policy.autoSettleAfterDays.map { .number(Double($0)) } ?? .null
            _ = try await request("storage.setPolicy", ["policy": .object(fields)])
            await refresh()
        }
    }

    func threadAction(_ action: PathwayThreadAction, thread: PathwayStorageThread) async {
        await perform {
            let command = action.command(threadID: thread.threadId).objectValue ?? [:]
            _ = try await request("orchestration.dispatchCommand", command)
            await refresh()
        }
    }

    private func cleanupFields(_ mode: String, _ ids: [String]) -> [String: JSONValue] {
        ["mode": .string(mode), "worktreeIds": .array(ids.map(JSONValue.string))]
    }

    private func scoped(_ snapshot: PathwayStorageSnapshot) -> PathwayStorageSnapshot {
        let threads = snapshot.threads.filter {
            visibleThreadIDs.contains($0.threadId) || $0.projectId.map(visibleProjectIDs.contains) == true
                || $0.conversationCompanyId == environment.companyId
        }
        let ids = Set(threads.map(\.threadId))
        let worktrees = snapshot.worktrees.filter {
            $0.threadIds.contains(where: ids.contains) || $0.kind == "orphan" && $0.projectRoot.map(visibleRoots.contains) == true
        }
        let worktreeIDs = Set(worktrees.map(\.id))
        let jobs = snapshot.jobs.compactMap { job -> PathwayStorageJob? in
            let items = job.items.filter { worktreeIDs.contains($0.worktreeId) || $0.projectRoot.map(visibleRoots.contains) == true }
            return items.isEmpty ? nil : .init(id: job.id, mode: job.mode, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, items: items)
        }
        return .init(sampledAt: snapshot.sampledAt, volumes: snapshot.volumes, worktrees: worktrees,
                     threads: threads, policy: snapshot.policy, jobs: jobs, scanError: snapshot.scanError)
    }

    func setVisibility(cloud: PathwayCloudModel) {
        let bindings = cloud.environmentBindings.filter { $0.companyId == environment.companyId && $0.binding.environmentId == environment.environment.environmentId && $0.binding.status == "active" }
        visibleProjectIDs = Set(bindings.map { $0.binding.localProjectId })
        visibleRoots = Set(bindings.map { $0.binding.localWorkspaceRoot })
        visibleThreadIDs = Set(cloud.threads.filter { $0.companyId == environment.companyId && $0.environmentId == environment.environment.environmentId }.map(\.threadId))
        if let snapshot { self.snapshot = scoped(snapshot) }
    }

    private func perform(_ action: () async throws -> Void) async {
        guard !performingAction else { return }
        performingAction = true
        defer { performingAction = false }
        error = nil
        do { try await action() }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
