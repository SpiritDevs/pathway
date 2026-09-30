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

    @Test func hugeToolOutputKeepsHeadAndTailForDisplay() {
        let short = String(repeating: "a", count: 100)
        #expect(AgentTranscriptCodeBlock.displayText(short, limit: 100) == short)

        let long = "HEAD" + String(repeating: "x", count: 10_000) + "TAIL"
        let shown = AgentTranscriptCodeBlock.displayText(long, limit: 1_000)
        #expect(shown.hasPrefix("HEAD"))
        #expect(shown.hasSuffix("TAIL"))
        #expect(shown.count < 1_200)

        // Multibyte text can exceed the byte limit without exceeding the character limit.
        let emoji = String(repeating: "🙂", count: 500)
        #expect(AgentTranscriptCodeBlock.displayText(emoji, limit: 1_000) == emoji)
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
