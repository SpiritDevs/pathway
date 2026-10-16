import Foundation
import Observation
@testable import Pathway
import Testing

@MainActor
struct PathwayRenderCostTests {
    @Test func parsesCachedTimestampsConsistently() {
        let fractional = "2026-08-29T02:00:00.125Z"
        let whole = "2026-08-29T02:00:00Z"
        let first = pathwayDate(from: fractional)
        #expect(first != nil)
        #expect(pathwayDate(from: fractional) == first)
        #expect(pathwayDate(from: whole) == first.map { $0.addingTimeInterval(-0.125) })
        #expect(pathwayDate(from: "not a date") == nil)
        #expect(pathwayDate(from: "not a date") == nil)
    }

    @Test func streamedMarkdownOnlyChangesTheGrowingBlock() {
        let earlier = "# Plan\n\nFirst paragraph with **bold** text.\n\n- one\n- two\n\nStreaming"
        let before = PathwayIssueMarkdownBlock.parse(earlier)
        let after = PathwayIssueMarkdownBlock.parse(earlier + " more words")
        #expect(before.count == after.count)
        #expect(Array(before.dropLast()) == Array(after.dropLast()))
        #expect(before.last?.id == after.last?.id)
        #expect(before.last != after.last)
    }

    @Test func appendedMarkdownMatchesAFullParseAtEveryCharacter() {
        let document = """
        # Plan
        Intro paragraph with **bold**
        continued here.

        Title
        =====
        Sub
        ---
        - one
          - nested
        1. first
        - [ ] task
        - [x] done
        > quoted
        > more
        para
        ***
        after divider
        ```swift
        let a = 1

        print(a)
        ```
        ~~~
        tilde
        ~~~
        Closing paragraph\r\nwith CRLF.

        """
        let cache = PathwayMarkdownBlockCache()
        var prefix = ""
        for character in document {
            prefix.append(character)
            #expect(cache.blocks(for: prefix) == PathwayIssueMarkdownBlock.parse(prefix), "after \(prefix.count) characters")
        }
        // A later character can reinterpret the last line: a divider becoming text, or a paragraph a setext heading.
        for (start, appended) in [("para\n***", "x"), ("Title\n--", "-"), ("text\n", "==="), ("- a\n", "---"), ("```\ncode\n``", "`\nafter")] {
            let incremental = PathwayMarkdownBlockCache()
            _ = incremental.blocks(for: start)
            #expect(incremental.blocks(for: start + appended) == PathwayIssueMarkdownBlock.parse(start + appended), "\(start) + \(appended)")
        }
    }

    @Test func chunkedAppendsOnlyParseTheUnfinishedTail() {
        let paragraphs = (0..<2_000).map { "Paragraph \($0) with some **inline** words." }.joined(separator: "\n\n")
        let cache = PathwayMarkdownBlockCache()
        _ = cache.blocks(for: paragraphs)
        #expect(cache.parsedLines == 3_999)
        var text = paragraphs + "\n\n"
        for chunk in ["Streaming", " more", " words", "\n", "next line", "\n\n", "- item", "\n```", "swift\nlet x", " = 1"] {
            text += chunk
            #expect(cache.blocks(for: text) == PathwayIssueMarkdownBlock.parse(text))
            #expect(cache.parsedLines <= 4, "\(chunk) reparsed \(cache.parsedLines) lines")
        }
        // A closed fence ends its block, so text streaming below it does not reparse the code.
        text += "\n```\nAfter"
        _ = cache.blocks(for: text)
        text += " the code"
        #expect(cache.blocks(for: text) == PathwayIssueMarkdownBlock.parse(text))
        #expect(cache.parsedLines == 1)
    }

    @Test func editedOrReplacedMarkdownParsesAgain() {
        let cache = PathwayMarkdownBlockCache()
        _ = cache.blocks(for: "# One\n\n- [ ] task\n- [ ] other")
        let toggled = "# One\n\n- [x] task\n- [ ] other"
        #expect(cache.blocks(for: toggled) == PathwayIssueMarkdownBlock.parse(toggled))
        #expect(cache.parsedLines == 4)
        #expect(cache.blocks(for: "Replaced") == PathwayIssueMarkdownBlock.parse("Replaced"))
        #expect(cache.blocks(for: "") == [])
        #expect(cache.blocks(for: "Again") == PathwayIssueMarkdownBlock.parse("Again"))
    }

    @Test func hugeTextKeepsHeadAndTailForDisplay() {
        let short = String(repeating: "a", count: 100)
        #expect(PathwayTextPreview.shortened(short, limit: 100) == nil)

        let long = "HEAD" + String(repeating: "x", count: 10_000) + "TAIL"
        let shown = PathwayTextPreview.shortened(long, limit: 1_000)
        #expect(shown?.hasPrefix("HEAD") == true)
        #expect(shown?.hasSuffix("TAIL") == true)
        #expect(shown?.contains("Shortened for display") == true)
        #expect((shown?.count ?? .max) < 1_200)

        // Multibyte text can exceed the byte limit without exceeding the scalar limit.
        let emoji = String(repeating: "🙂", count: 500)
        #expect(PathwayTextPreview.shortened(emoji, limit: 1_000) == nil)

        // One character carrying many combining marks is still bounded in bytes.
        let combining = "e" + String(repeating: "\u{301}", count: 100_000)
        #expect(combining.count == 1)
        let bounded = PathwayTextPreview.shortened(combining, limit: 1_000)
        #expect((bounded?.utf8.count ?? .max) < 1_000 * 4 + PathwayTextPreview.marker.utf8.count)
    }

    @Test func hugeMarkdownCodeBlocksDisplayBoundedAndCopyExactly() throws {
        let line = String(repeating: "x", count: 262_144)
        let single = try #require(PathwayIssueMarkdownBlock.parse("```swift\n\(line)\n```").first)
        #expect(single.kind == .code("swift"))
        #expect(single.text == line)
        #expect((PathwayTextPreview.shortened(single.text)?.unicodeScalars.count ?? .max) <= 20_000 + PathwayTextPreview.marker.unicodeScalars.count)

        // Leading spaces, tabs and a trailing blank line all survive for Copy.
        let lines = (0..<30_000).map { "  line \($0)\t" }.joined(separator: "\n") + "\n"
        let many = try #require(PathwayIssueMarkdownBlock.parse("```\n\(lines)\n```").first)
        #expect(many.text == lines)
        #expect(PathwayTextPreview.shortened(many.text) != nil)

        let ordinary = try #require(PathwayIssueMarkdownBlock.parse("```\nlet a = 1\n```").first)
        #expect(PathwayTextPreview.shortened(ordinary.text) == nil)

        // The full reader lays out bounded rows that still join back into the exact text.
        let rows = PathwayTextPreview.rows(line + "\n\nend", width: 2_000)
        #expect(rows.allSatisfy { $0.unicodeScalars.count <= 2_000 })
        #expect(rows.suffix(2) == ["", "end"])
        #expect(rows.dropLast(2).joined() == line)
    }

    @Test func repeatedProviderStatusesDoNotInvalidateRows() {
        let providers = PathwayThreadProviders()
        let thread = makeAgentThread()
        providers.apply(statuses(driver: "codex"), environmentID: "company-1:environment-1")

        let invalidated = ObservationFlag()
        withObservationTracking { _ = providers.provider(for: thread) } onChange: { invalidated.fired = true }
        providers.apply(statuses(driver: "codex"), environmentID: "company-1:environment-1")
        #expect(!invalidated.fired)

        providers.apply(statuses(driver: "cursor"), environmentID: "company-1:environment-1")
        #expect(invalidated.fired)
    }

    @Test func unchangedThreadPartitionDoesNotInvalidateShelves() {
        let cloud = PathwayCloudModel()
        let invalidated = ObservationFlag()
        withObservationTracking {
            _ = cloud.threads
            _ = cloud.activeThreads
            _ = cloud.snoozedThreads
            _ = cloud.settledThreads
        } onChange: { invalidated.fired = true }
        cloud.refreshThreadPartition()
        #expect(!invalidated.fired)
    }

    private func statuses(driver: String) -> JSONValue {
        .object([
            "type": .string("providerStatuses"),
            "payload": .object(["providers": .array([.object([
                "instanceId": .string("codex-work"),
                "driver": .string(driver),
                "displayName": .string("Work provider")
            ])])])
        ])
    }
}

/// Observation reports changes synchronously on the mutating actor in these tests.
private final class ObservationFlag: @unchecked Sendable {
    var fired = false
}
