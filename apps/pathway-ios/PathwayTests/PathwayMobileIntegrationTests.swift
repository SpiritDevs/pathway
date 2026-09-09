import Foundation
@testable import Pathway
import Testing

struct PathwayMobileIntegrationTests {
    @Test @MainActor func offlineStoragePressureRestoresOnlyTheCurrentAccountAndEnvironments() throws {
        let suite = "storage-pressure-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("critical", forKey: PathwayStoragePressureCache.key(account: "one", environmentID: "host"))
        defaults.set("warning", forKey: PathwayStoragePressureCache.key(account: "two", environmentID: "host"))
        defaults.set("invalid", forKey: PathwayStoragePressureCache.key(account: "one", environmentID: "invalid"))
        #expect(PathwayStoragePressureCache.restore(account: "one",
            environments: [("binding", "host"), ("unknown", "missing"), ("bad", "invalid")], defaults: defaults) == ["binding": "critical"])
        #expect(PathwayStoragePressureCache.restore(account: "two",
            environments: [("binding", "host")], defaults: defaults) == ["binding": "warning"])
        #expect(PathwayStoragePressureCache.restore(account: "three",
            environments: [("binding", "host")], defaults: defaults).isEmpty)
    }

    @Test func storageNotificationCarriesASeparateAccountScopedDestination() {
        let destination = PathwayStorageNotificationDestination(account: "account", environmentID: "host")
        #expect(PathwayStorageNotificationDestination(notification: destination.userInfo) == destination)
        #expect(PathwayProductLink(notification: destination.userInfo) == nil)
        #expect(PathwayStorageNotificationDestination(notification: ["environmentId": "host"]) == nil)
        #expect(PathwayStorageNotificationDestination(notification: ["destination": "storage", "account": "", "environmentId": "host"]) == nil)
    }

    @Test func conversationFindsRunningCleanupBehindNewerCompletedJobs() {
        let completed = PathwayStorageJob(id: "new", mode: "manual", status: "completed", startedAt: "", finishedAt: "", items: [])
        let running = PathwayStorageJob(id: "old", mode: "manual", status: "running", startedAt: "", finishedAt: nil, items: [])
        let snapshot = PathwayStorageSnapshot(sampledAt: "", volumes: [], worktrees: [], threads: [],
            policy: .init(enabled: false, afterDays: 30, warningBytes: 20, criticalBytes: 10,
                warningPercent: 10, criticalPercent: 5), jobs: [completed, running], scanError: nil)
        #expect(snapshot.runningJob?.id == "old")
    }

    @Test func clearingHistoryPreservesDraftsAndOtherAccounts() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let account = root.appending(path: "one")
        defer { try? FileManager.default.removeItem(at: root) }
        for path in ["one/AgentThreads/history.json", "one/Discovery.json", "one/Drafts/prompt.json", "two/Discovery.json"] {
            let url = root.appending(path: path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("saved".utf8).write(to: url)
        }
        try await PathwayDownloadedHistory.clear(directory: account)
        #expect(!FileManager.default.fileExists(atPath: account.appending(path: "Discovery.json").path))
        #expect(!FileManager.default.fileExists(atPath: account.appending(path: "AgentThreads").path))
        #expect(FileManager.default.fileExists(atPath: account.appending(path: "Drafts/prompt.json").path))
        #expect(FileManager.default.fileExists(atPath: root.appending(path: "two/Discovery.json").path))
    }

    @Test func accountPartitionsIncludeIssuerAndSubject() throws {
        func token(_ issuer: String, _ subject: String) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: ["iss": issuer, "sub": subject])
            return "header.\(data.base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")).signature"
        }
        let one = try #require(PathwayAccountStorage.identity(fromToken: token("dev", "user")))
        let otherIssuer = try #require(PathwayAccountStorage.identity(fromToken: token("prod", "user")))
        let otherUser = try #require(PathwayAccountStorage.identity(fromToken: token("dev", "other")))
        #expect(PathwayAccountStorage.directory(for: one) != PathwayAccountStorage.directory(for: otherIssuer))
        #expect(PathwayAccountStorage.directory(for: one) != PathwayAccountStorage.directory(for: otherUser))
        #expect(PathwayAccountStorage.identity(fromToken: "invalid") == nil)
    }

    @Test func notificationAndProductURLsResolveSameThread() throws {
        let route = try #require(PathwayProductLink(url: URL(string: "pathway://threads/env-1/thread-1")!))
        #expect(route == PathwayProductLink(notification: ["environmentId": "env-1", "threadId": "thread-1"]))
        #expect(route == PathwayProductLink(url: URL(string: "https://app.pathwayos.dev/threads/env-1/thread-1")!, allowedWebHost: "app.pathwayos.dev"))
        #expect(PathwayProductLink(url: URL(string: "https://untrusted.example/threads/env-1/thread-1")!, allowedWebHost: "app.pathwayos.dev") == nil)
        #expect(PathwayProductLink(url: URL(string: "pathway://callback")!) == nil)
        #expect(PathwayProductLink(url: URL(string: "pathway://threads/one/two/three")!) == nil)
    }

    @Test func notificationDefaultsRequireOptIn() {
        let preferences = PathwayNotificationPreferences()
        #expect(!preferences.notificationsEnabled)
        #expect(!preferences.liveActivitiesEnabled)
    }

    @Test func discoveryCacheRejectsExpiredDataAndOldWrites() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = PathwayDiscoveryCache(directory: directory)
        await cache.save(.init(companies: [], entities: [:], versions: ["company": 8], savedAt: .now), revision: 8)
        await cache.save(.init(companies: [], entities: [:], versions: ["company": 7], savedAt: .now), revision: 7)
        #expect(await cache.load()?.versions["company"] == 8)
        let separate = PathwayDiscoveryCache(directory: directory.appending(path: "other-account"))
        #expect(await separate.load() == nil)
        await cache.save(.init(companies: [], entities: [:], versions: [:], savedAt: Date(timeIntervalSinceNow: -31 * 24 * 60 * 60)), revision: 9)
        #expect(await cache.load() == nil)
    }

    @Test func fractionalOrderRemainsStrictBetweenNeighbors() throws {
        var upper = "n"
        for _ in 0..<100 {
            let key = try #require(PathwayThreadOrder.between(nil, upper))
            #expect(key < upper)
            upper = key
        }
        #expect(PathwayThreadOrder.between("z", "b") == nil)
        #expect(PathwayThreadOrder.between("a", nil) == nil)
        let middle = try #require(PathwayThreadOrder.between("m", "n"))
        #expect("m" < middle && middle < "n")
    }
}
