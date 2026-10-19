import Foundation
import Testing
@testable import Pathway

struct AgentThreadComposerTriggerTests {
    @Test func detectsTheTokenAtTheCaretWithoutReplacingFollowingText() throws {
        let text = "Inspect @src/co and retain this explanation"
        let cursor = ("Inspect @src/co" as NSString).length
        let trigger = try #require(AgentThreadComposerTrigger.detect(in: text, cursor: cursor))
        #expect(trigger.kind == .path)
        #expect(trigger.query == "src/co")
        let result = try #require(trigger.replacing(in: text, with: "[config.ts](src/config.ts) "))
        #expect(result.text == "Inspect [config.ts](src/config.ts) and retain this explanation")
        #expect(result.cursor == ("Inspect [config.ts](src/config.ts) " as NSString).length)
    }

    @Test func unicodeBeforeAMentionUsesTheSameUTF16OffsetsAsTheNativeCaret() throws {
        let text = "👩🏽‍💻 Read $re"
        let trigger = try #require(AgentThreadComposerTrigger.detect(in: text, cursor: (text as NSString).length))
        #expect(trigger.kind == .skill)
        let result = try #require(trigger.replacing(in: text, with: "$review "))
        #expect(result.text == "👩🏽‍💻 Read $review ")
        #expect(trigger.replacing(in: "Completely different draft", with: "$review ") == nil)
    }

    @Test func slashCommandsOnlyActivateAtTheStartOfALine() throws {
        #expect(AgentThreadComposerTrigger.detect(in: "Please /plan", cursor: 12) == nil)
        #expect(AgentThreadComposerTrigger.detect(in: "email@example.com", cursor: 17) == nil)
        #expect(AgentThreadComposerTrigger.detect(in: "@src ", cursor: 5) == nil)
        let model = try #require(AgentThreadComposerTrigger.detect(in: "Explain\n/model gpt", cursor: 18))
        #expect(model.kind == .model && model.query == "gpt")
        let command = try #require(AgentThreadComposerTrigger.detect(in: "/com", cursor: 4))
        #expect(command.kind == .slash && command.query == "com")
    }

    @Test func fileLinksMatchDesktopEscapingForSpacesUnicodeAndMarkdownPunctuation() {
        #expect(AgentThreadComposerTrigger.fileLink("src/My [file](é)#?.swift") == "[My \\[file\\](é)#?.swift](src/My%20%5Bfile%5D%28%C3%A9%29%23%3F.swift)")
        #expect(AgentThreadComposerTrigger.fileLink("dir\\file.txt") == "[file.txt](dir%5Cfile.txt)")
    }
}
