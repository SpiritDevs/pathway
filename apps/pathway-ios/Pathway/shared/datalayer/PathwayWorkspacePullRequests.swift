import Foundation

struct PathwayWorkspacePullRequestList: Decodable {
    let entries: [PathwayWorkspacePullRequestRow]
    let errors: [ProjectError]
    let truncated: Bool
    let nextCursors: [String: String]
    struct ProjectError: Decodable, Identifiable {
        let projectId: String
        let projectTitle: String
        let message: String
        var id: String { projectId }
    }
}
struct PathwayWorkspacePullRequestRow: Decodable, Identifiable {
    let host: String
    let projectId: String
    let repository: String
    let number: Int
    let title: String
    let state: String
    let isDraft: Bool
    let url: String
    var id: String { "\(host)/\(projectId)/\(repository)/\(number)" }
    var payload: [String: JSONValue] {
        ["projectId": .string(projectId), "repository": .string(repository), "number": .number(Double(number))]
    }
}
struct PathwayWorkspacePullRequestDetail: Decodable {
    let title: String
    let body: String
    let state: String
    let isDraft: Bool
    let mergeability: String
    let headBranch: String
    let baseBranch: String
    let additions: Int
    let deletions: Int
    let checks: [Check]
    let capabilities: Capabilities
    let viewerPermissions: Permissions
    let mergeCapabilities: [String: Bool]
    struct Check: Decodable, Identifiable {
        var id: String { name + "|" + (url ?? "") }
        let name: String
        let status: String
        let description: String?
        let url: String?
    }
    struct Capabilities: Decodable {
        let diff: Bool
        let comment: Bool
        let actions: [String]
        let mergeMethods: [String]
        let review: Review
        let reviewers: Reviewers
        struct Reviewers: Decodable { let request: Bool; let listCandidates: Bool }
        struct Review: Decodable {
            let inlineComment: Bool
            let reply: Bool
            let resolve: Bool
            let verdicts: [String]
        }
    }
    struct Permissions: Decodable {
        let requestReviewers: Bool
        let actions: [String]
        let comment: Bool
        let resolve: Bool
        let verdicts: [String]
    }
    var availableActions: [String] {
        capabilities.actions.filter { action in
            guard viewerPermissions.actions.contains(action) else { return false }
            switch action {
            case "merge": return state == "open" && !isDraft && mergeability == "mergeable" && !availableMergeMethods.isEmpty
            case "close": return state == "open"
            case "reopen": return state == "closed"
            case "ready": return state == "open" && isDraft
            case "draft": return state == "open" && !isDraft
            default: return false
            }
        }
    }
    var availableMergeMethods: [String] { capabilities.mergeMethods.filter { mergeCapabilities[$0] == true } }
    var availableVerdicts: [String] { capabilities.review.verdicts.filter { viewerPermissions.verdicts.contains($0) } }
    var canDraftInline: Bool { capabilities.review.inlineComment && viewerPermissions.comment && !availableVerdicts.isEmpty }
    var canRequestReviewers: Bool { capabilities.reviewers.request && viewerPermissions.requestReviewers }
    var canComment: Bool { capabilities.comment && viewerPermissions.comment }
}
struct PathwayWorkspacePullRequestActivity: Decodable {
    let comments: [Comment]
    let commentCount: Int
    let commentsTruncated: Bool
    let reviewThreads: [ReviewThread]
    struct Actor: Decodable { let login: String }
    struct Comment: Decodable, Identifiable {
        let id: String
        let author: Actor?
        let body: String
        let createdAt: String
    }
    struct ReviewThread: Decodable, Identifiable {
        let id: String
        let path: String
        let line: Int?
        let isResolved: Bool
        let isOutdated: Bool
        let comments: [Comment]
    }
}
