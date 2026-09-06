import Foundation
import Testing
@testable import Pathway

struct AgentThreadPromptStashTests {
    @Test func diskRoundTripPreservesTextAndAttachmentBytes() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AgentThreadPromptStash(directory: directory)
        let bytes = Data([0, 1, 2, 254, 255])
        let entry = try await store.save(prompt: "  Continue this investigation.  ", attachments: [
            .init(name: "details.bin", mimeType: "application/octet-stream", data: bytes)
        ])
        let reopened = AgentThreadPromptStash(directory: directory)
        #expect(try await reopened.entries() == [entry])
        let attachment = try #require(try await reopened.attachments(for: entry.id).first)
        #expect(attachment.data == bytes)
        #expect(attachment.name == "details.bin")
        #expect(entry.prompt == "Continue this investigation.")
        try await reopened.remove(id: entry.id)
        #expect(try await AgentThreadPromptStash(directory: directory).entries().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: directory.appending(path: entry.id).path))
    }

    @Test func byteLimitFailureKeepsThePreviousDurableStash() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AgentThreadPromptStash(directory: directory, maximumBytes: 4)
        let entry = try await store.save(prompt: "Saved", attachments: [.init(name: "one", mimeType: "text/plain", data: Data([1, 2, 3]))])
        do {
            try await store.save(prompt: "Too large", attachments: [.init(name: "two", mimeType: "text/plain", data: Data([4, 5]))])
            Issue.record("The stash accepted an attachment beyond its byte budget")
        } catch {}
        #expect(try await AgentThreadPromptStash(directory: directory).entries() == [entry])
    }

    @Test func theTwentyNewestPromptsSurviveReload() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AgentThreadPromptStash(directory: directory)
        for index in 0..<21 { try await store.save(prompt: "Prompt \(index)", attachments: []) }
        let entries = try await AgentThreadPromptStash(directory: directory).entries()
        #expect(entries.count == 20)
        #expect(entries.first?.prompt == "Prompt 20")
        #expect(entries.last?.prompt == "Prompt 1")
    }

    @Test func restoringAppendsWithoutOverwritingNewWorkOrAddingAttachmentOnlyWhitespace() {
        #expect(AgentThreadPromptStash.appending("Saved", to: "New work  \n") == "New work\n\nSaved")
        #expect(AgentThreadPromptStash.appending("", to: "New work  \n") == "New work  \n")
        #expect(AgentThreadPromptStash.appending("Saved", to: " \n") == "Saved")
    }
}
