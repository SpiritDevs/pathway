import Foundation
import Testing
@testable import Pathway

@Suite(.serialized)
@MainActor
struct PathwayWorkWidgetStoreTests {
    @Test func signOutClearsCountsAndRejectsLatePublish() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayWorkWidgetStore(directory: directory)
        let session = try #require(try store.configure(accountKey: "account-a"))
        let now = Date()
        #expect(try store.publish(runningCount: 3, attentionCount: 2, updatedAt: now, session: session))
        #expect(PathwayWorkWidgetStore.read(directory: directory)?.runningCount == 3)
        try store.configure(accountKey: nil)
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
        #expect(try !store.publish(runningCount: 9, attentionCount: 9, updatedAt: now, session: session))
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
    }

    @Test func accountSwitchAndSameAccountReconfigurationInvalidateOldLeases() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayWorkWidgetStore(directory: directory)
        let first = try #require(try store.configure(accountKey: "account-a"))
        let second = try #require(try store.configure(accountKey: "account-b"))
        #expect(try !store.publish(runningCount: 4, attentionCount: 0, updatedAt: Date(), session: first))
        #expect(try store.publish(runningCount: 1, attentionCount: 0, updatedAt: Date(), session: second))
        #expect(PathwayWorkWidgetStore.read(directory: directory)?.accountKey == "account-b")
        let third = try #require(try store.configure(accountKey: "account-b"))
        #expect(third != second)
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
        #expect(try !store.publish(runningCount: 5, attentionCount: 0, updatedAt: Date(), session: second))
    }

    @Test func olderSnapshotCannotOverwriteNewerAndInvalidCountsCannotPublish() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayWorkWidgetStore(directory: directory)
        let session = try #require(try store.configure(accountKey: "account-a"))
        let now = Date()
        #expect(try store.publish(runningCount: 1, attentionCount: 2, updatedAt: now, session: session))
        #expect(try !store.publish(runningCount: 9, attentionCount: 9, updatedAt: now.addingTimeInterval(-1), session: session))
        #expect(throws: (any Error).self) {
            try store.publish(runningCount: -1, attentionCount: 0, updatedAt: now, session: session)
        }
        #expect(PathwayWorkWidgetStore.read(directory: directory)?.attentionCount == 2)
    }

    @Test func missingMalformedAndOversizedSnapshotsAreUnavailable() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "snapshot.json")
        try Data("invalid".utf8).write(to: file)
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
        try Data(repeating: 0x20, count: 16_385).write(to: file)
        #expect(PathwayWorkWidgetStore.read(directory: directory) == nil)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "PathwayWidgetTests-\(UUID().uuidString)")
    }
}
