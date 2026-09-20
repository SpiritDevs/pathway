import Foundation

enum PathwayWorkspaceGitAction: String, CaseIterable, Identifiable {
    case commit
    case commitPush = "commit_push"
    case commitPushPR = "commit_push_pr"
    case push
    case createPR = "create_pr"
    case pull

    var id: String { rawValue }
    var title: String {
        switch self {
        case .commit: "Commit"
        case .commitPush: "Commit & push"
        case .commitPushPR: "Commit, push & create PR"
        case .push: "Push commits"
        case .createPR: "Create pull request"
        case .pull: "Pull upstream changes"
        }
    }
    var systemImage: String {
        switch self {
        case .commit: "checkmark.circle"
        case .commitPush, .push: "arrow.up.circle"
        case .commitPushPR, .createPR: "arrow.triangle.pull"
        case .pull: "arrow.down.circle"
        }
    }
    var requiresCommit: Bool { self == .commit || self == .commitPush || self == .commitPushPR }

    func unavailableReason(status: PathwayWorkspaceStatus, selected: Set<String>, featureBranch: Bool = false) -> String? {
        guard status.isRepo else { return "This workspace is not a repository." }
        if self != .commit {
            guard status.refName != nil || (requiresCommit && featureBranch) else { return "Switch to a branch before continuing." }
            guard status.hasPrimaryRemote else { return "Add a remote before continuing." }
        }
        if self == .pull {
            guard status.hasUpstream else { return "This branch has no upstream to pull from." }
            guard !status.hasWorkingTreeChanges else { return "Commit local changes before pulling." }
        } else if self != .commit, status.behindCount > 0 {
            return "Pull upstream changes before continuing."
        }
        if requiresCommit {
            guard status.hasWorkingTreeChanges else { return "No uncommitted changes." }
            let files = Set(status.workingTree.files.map(\.path))
            guard !selected.isEmpty, selected.isSubset(of: files) else { return "Select the files to commit." }
        }
        if self == .push, status.hasUpstream, status.aheadCount == 0 { return "No local commits to push." }
        if self == .createPR, status.hasWorkingTreeChanges { return "Commit local changes before creating a pull request." }
        if self == .createPR || self == .commitPushPR {
            if status.isDefaultRef == true, !(requiresCommit && featureBranch) {
                return "Create a new branch before opening a pull request."
            }
            if self == .createPR, (status.aheadOfDefaultCount ?? status.aheadCount) == 0 {
                return "No commits to include in a pull request."
            }
        }
        return nil
    }
}
