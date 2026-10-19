import Foundation

struct PathwayWorkspaceReviewAnchor: Equatable, Identifiable {
    let path: String
    let oldPath: String?
    let line: Int
    let side: String
    var id: String { "\(path)|\(side)|\(line)" }
}

struct PathwayWorkspaceReviewDraft: Identifiable {
    let id = UUID()
    let anchor: PathwayWorkspaceReviewAnchor
    var body: String
    var isValid: Bool { !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && body.count <= 65_536 }
    var payload: JSONValue {
        var fields: [String: JSONValue] = ["path": .string(anchor.path), "line": .number(Double(anchor.line)), "side": .string(anchor.side), "body": .string(body)]
        if let oldPath = anchor.oldPath { fields["oldPath"] = .string(oldPath) }
        return .object(fields)
    }
}

enum PathwayWorkspaceReviewValidation {
    static func canSubmit(verdict: String, body: String, drafts: [PathwayWorkspaceReviewDraft]) -> Bool {
        body.count <= 65_536 && drafts.allSatisfy(\.isValid)
            && (verdict == "approve" || !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.isEmpty)
    }
}

/// Anchors only lines present in a valid unified hunk. Quoted paths stay visible
/// but are not guessed: Git's C-style octal path encoding needs a full decoder.
struct PathwayWorkspaceDiffLine: Identifiable {
    let id = UUID()
    let text: String
    let anchor: PathwayWorkspaceReviewAnchor?

    static func parse(_ patch: String) -> [Self] {
        var oldPath: String?
        var newPath: String?
        var oldLine = 0
        var newLine = 0
        var oldRemaining = 0
        var newRemaining = 0
        var inHunk = false
        var validPaths = true
        return patch.components(separatedBy: "\n").map { text in
            var anchor: PathwayWorkspaceReviewAnchor?
            if text.hasPrefix("diff --git ") {
                oldPath = nil; newPath = nil; inHunk = false; validPaths = true
            } else if !inHunk && text.hasPrefix("--- ") {
                let value = String(text.dropFirst(4))
                oldPath = path(value)
                if oldPath == nil && value != "/dev/null" { validPaths = false }
            } else if !inHunk && text.hasPrefix("+++ ") {
                let value = String(text.dropFirst(4))
                newPath = path(value)
                if newPath == nil && value != "/dev/null" { validPaths = false }
            } else if text.hasPrefix("@@ ") {
                let pieces = text.split(separator: " ")
                if pieces.count >= 4, pieces[3] == "@@", let old = range(String(pieces[1]), prefix: "-"), let new = range(String(pieces[2]), prefix: "+") {
                    oldLine = old.0; oldRemaining = old.1; newLine = new.0; newRemaining = new.1; inHunk = true
                } else { inHunk = false }
            } else if inHunk {
                let side: String?
                let number: Int
                if text.hasPrefix("+") && newRemaining > 0 {
                    side = "right"; number = newLine; newLine += 1; newRemaining -= 1
                } else if text.hasPrefix("-") && oldRemaining > 0 {
                    side = "left"; number = oldLine; oldLine += 1; oldRemaining -= 1
                } else if text.hasPrefix(" ") && oldRemaining > 0 && newRemaining > 0 {
                    side = "right"; number = newLine
                    oldLine += 1; newLine += 1; oldRemaining -= 1; newRemaining -= 1
                } else {
                    side = nil; number = 0
                    if !text.hasPrefix("\\ No newline") { inHunk = false }
                }
                if validPaths, let side, let path = newPath ?? oldPath, number > 0 {
                    anchor = .init(path: path, oldPath: oldPath != path ? oldPath : nil, line: number, side: side)
                }
                if oldRemaining == 0 && newRemaining == 0 { inHunk = false }
            }
            return Self(text: text, anchor: anchor)
        }
    }

    private static func path(_ value: String) -> String? {
        guard !value.hasPrefix("\""), value != "/dev/null", value.count > 2,
              value.hasPrefix("a/") || value.hasPrefix("b/") else { return nil }
        return String(value.dropFirst(2))
    }
    private static func range(_ value: String, prefix: Character) -> (Int, Int)? {
        guard value.first == prefix else { return nil }
        let parts = value.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2, let start = Int(parts[0]), start >= 0 else { return nil }
        let count = parts.count == 2 ? Int(parts[1]) : 1
        guard let count, count >= 0, start > 0 || count == 0 else { return nil }
        return (start, count)
    }
}

struct PathwayWorkspaceReviewerCandidates: Decodable {
    let candidates: [Candidate]
    let truncated: Bool
    struct Candidate: Decodable, Identifiable {
        let id: String
        let kind: String
        let login: String
        let name: String?
        let isRequested: Bool
        var identity: String { kind + ":" + id }
    }
}
