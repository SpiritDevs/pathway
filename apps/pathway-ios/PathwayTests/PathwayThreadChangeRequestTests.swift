import Foundation
@testable import Pathway
import Testing

struct PathwayThreadChangeRequestTests {
    private let attachment = PathwayPullRequestAttachment(number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110")

    private func environment(capability: JSONValue? = .bool(true)) -> PathwayCompanyEnvironment {
        .init(companyId: "company-1", environment: .init(
            id: "environment-1", environmentId: "environment-1",
            descriptor: .init(environmentId: "environment-1", label: "Remote", serverVersion: "test", capabilities: capability.map { ["pullRequests": $0] }),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"
        ))
    }

    @Test(arguments: [nil, "main"])
    func attachedStatusUsesIdentityWithoutCheckout(branch: String?) throws {
        let thread = makeAgentThread(attachedPullRequest: attachment, branch: branch)
        let request = try #require(PathwayThreadChangeRequestResolver.request(for: thread, environment: environment(), bindings: []))
        #expect(request.method == "pullRequests.detail")
        #expect(request.payload == .object(["projectId": .string("project-1"), "repository": .string("spiritdevs/pathway"), "number": .number(110)]))
        let status = request.status(from: .object(["url": .string(attachment.url), "number": .number(110), "state": .string("merged")]))
        #expect(status.state == .merged)
        #expect(thread.lifecycleSection(at: .now, changeRequestState: status.state) == .settled)
    }

    @Test(arguments: [nil, JSONValue.bool(false)])
    func unsupportedEnvironmentDoesNotProbeOrUseUnrelatedBranch(capability: JSONValue?) {
        let thread = makeAgentThread(attachedPullRequest: attachment, branch: "main", worktreePath: "/project")
        #expect(PathwayThreadChangeRequestResolver.request(for: thread, environment: environment(capability: capability), bindings: []) == nil)
    }

    @Test(arguments: ["failure", "cancelled", "pending", "success"])
    func attachedChecksReachBadgeStatus(check: String) throws {
        let request = try #require(PathwayThreadChangeRequestResolver.request(for: makeAgentThread(attachedPullRequest: attachment), environment: environment(), bindings: []))
        let status = request.status(from: .object([
            "url": .string(attachment.url), "number": .number(110), "state": .string("open"),
            "checks": .array([.object(["status": .string(check)])])
        ]))
        #expect(status.state == .open)
        #expect(status.checksFailed == ["failure", "cancelled"].contains(check))
        #expect(status.checksPending == (check == "pending"))
        #expect(status.label == (check == "pending" ? "Checks pending" : check == "success" ? "Open" : "Checks failed"))
    }

    @Test func unrelatedDetailsCannotSettleAttachedThread() throws {
        let request = try #require(PathwayThreadChangeRequestResolver.request(for: makeAgentThread(attachedPullRequest: attachment), environment: environment(), bindings: []))
        for url in [attachment.url.replacingOccurrences(of: "github.com", with: "github.example.com"), attachment.url.replacingOccurrences(of: "pathway", with: "another"), attachment.url.replacingOccurrences(of: "110", with: "111")] {
            let status = request.status(from: .object(["url": .string(url), "number": .number(110), "state": .string("merged")]))
            #expect(status.state == nil)
            #expect(status.unavailable)
        }
    }

    @Test func detachedThreadReturnsToBranchLookupAndPreservesBranchGuard() throws {
        let thread = makeAgentThread(branch: "main", worktreePath: "/project")
        let request = try #require(PathwayThreadChangeRequestResolver.request(for: thread, environment: environment(capability: nil), bindings: []))
        #expect(request.method == "vcs.refreshStatus")
        #expect(request.payload == .object(["cwd": .string("/project")]))
        #expect(request.status(from: .object(["refName": .string("feature"), "pr": .object(["state": .string("merged")])])).state == nil)
        #expect(request.status(from: .object(["refName": .string("main"), "pr": .object(["state": .string("open")])])).state == .open)
    }

    @Test func replacingOrDetachingInvalidatesLifecycleSource() {
        let original = PathwayThreadChangeRequestSource(makeAgentThread(attachedPullRequest: attachment).shell)
        let replaced = makeAgentThread(attachedPullRequest: .init(number: 111, url: attachment.url.replacingOccurrences(of: "110", with: "111")))
        #expect(original != PathwayThreadChangeRequestSource(replaced.shell))
        #expect(original != PathwayThreadChangeRequestSource(makeAgentThread().shell))
        #expect(original != PathwayThreadChangeRequestSource(makeAgentThread(attachedPullRequest: attachment, branch: "feature").shell))
        #expect(replaced.lifecycleSection(at: .now) == .active)
    }

    @Test func attachedMergeRespectsPendingWorkAndExplicitKeepActive() {
        let now = Date.now
        #expect(makeAgentThread(settledOverride: "active", attachedPullRequest: attachment).lifecycleSection(at: now, changeRequestState: .merged) == .active)
        #expect(makeAgentThread(pendingRequestKind: "approval", attachedPullRequest: attachment).lifecycleSection(at: now, changeRequestState: .merged) == .active)
        #expect(makeAgentThread(settledOverride: "settled", attachedPullRequest: attachment).lifecycleSection(at: now) == .settled)
    }

    @Test func parsesGitLabSubgroupsAndNormalizesGitHubIdentity() {
        let gitlab = PathwayAttachedPullRequestReference(.init(number: 47, url: "https://gitlab.example.com/group/subgroup/repo/-/merge_requests/47"))
        #expect(gitlab?.repository == "group/subgroup/repo")
        #expect(gitlab?.number == 47)
        #expect(PathwayAttachedPullRequestReference(attachment) == PathwayAttachedPullRequestReference(.init(number: 110, url: attachment.url.lowercased() + "#discussion")))
    }
}
