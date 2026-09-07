import Foundation
import Testing
@testable import Pathway

struct PathwayCaptureTests {
    @Test func capturesRequireAnAccountAndRemainSeparatedAcrossSignout() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory)
        await #expect(throws: PathwayCaptureError.self) { try await store.save(prompt: "Private prompt", files: [], accountKey: "account-a") }
        try await store.setActiveAccount("account-a")
        let draft = try await store.save(prompt: "Private prompt", files: [], accountKey: "account-a")
        try await store.setActiveAccount(nil)
        await #expect(throws: PathwayCaptureError.self) { try await store.drafts(accountKey: "account-a") }
        try await store.setActiveAccount("account-b")
        #expect(try await store.drafts(accountKey: "account-b").isEmpty)
        await #expect(throws: PathwayCaptureError.self) { try await store.remove(draft) }
        try await store.setActiveAccount("account-a")
        #expect(try await store.drafts(accountKey: "account-a") == [draft])
    }

    @Test func copiedFilesSurviveProviderTemporaryFileRemoval() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory.appending(path: "inbox"))
        try await store.setActiveAccount("account")
        let file = directory.appending(path: "input.txt")
        try Data("Shared context".utf8).write(to: file)
        let draft = try await store.save(prompt: "Review", files: [.init(url: file, name: "input.txt", mimeType: "text/plain")], accountKey: "account")
        try FileManager.default.removeItem(at: file)
        let restored = PathwayCaptureStore(directory: directory.appending(path: "inbox"))
        let saved = try #require(await restored.drafts(accountKey: "account").first)
        #expect(saved.id == draft.id)
        #expect(try await restored.data(for: #require(saved.attachments.first), in: saved) == Data("Shared context".utf8))
        try await restored.remove(saved)
        #expect(try await restored.drafts(accountKey: "account").isEmpty)
    }

    @Test func changedAccountAndInvalidInputCannotCreateDrafts() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PathwayCaptureStore(directory: directory)
        try await store.setActiveAccount("account-b")
        await #expect(throws: PathwayCaptureError.self) { try await store.save(prompt: "Wrong owner", files: [], accountKey: "account-a") }
        await #expect(throws: PathwayCaptureError.self) { try await store.save(prompt: "  ", files: [], accountKey: "account-b") }
        await #expect(throws: PathwayCaptureError.self) { try await store.save(prompt: String(repeating: "x", count: 120_001), files: [], accountKey: "account-b") }
        await #expect(throws: PathwayCaptureError.self) { try await store.setActiveAccount("../other") }
        #expect(try await store.drafts(accountKey: "account-b").isEmpty)
    }
}
