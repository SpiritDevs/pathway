import Foundation
@testable import Pathway
import Testing

struct PathwayAgentThreadShellTests {
    @Test func decodesAttachedPullRequestMetadata() throws {
        let pullRequest = PathwayPullRequestAttachment(
            number: 68,
            url: "https://github.com/SpiritDevs/pathway/pull/68"
        )
        let shell = makeAgentThread(attachedPullRequest: pullRequest).shell
        let decoded = try JSONDecoder().decode(
            PathwayAgentThreadShell.self,
            from: JSONEncoder().encode(shell)
        )

        #expect(decoded.attachedPullRequest == pullRequest)
    }
}
