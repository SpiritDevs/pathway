import Foundation

struct PathwayEmailTriggerDraft {
    let id: String
    let projectID: String
    let name: String
    let enabled: Bool
    let sender: String
    let subject: String
    let recipient: String
    let prompt: String
    let hourlyCap: Int
    func payload() throws -> [String: JSONValue] {
        func optional(_ value: String) -> JSONValue {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? .null : .string(trimmed)
        }
        let matcher = ["sender": optional(sender), "subject": optional(subject), "recipient": optional(recipient)]
        guard matcher.values.contains(where: { $0 != .null }) else { throw PathwayIssueWriteError(message: "Match on at least one of sender, subject or recipient.") }
        guard hourlyCap > 0, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PathwayIssueWriteError(message: "Enter a name, prompt and positive hourly limit.") }
        return ["id": .string(id), "projectId": .string(projectID), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "enabled": .bool(enabled), "matcher": .object(matcher), "promptTemplate": .string(prompt), "maxTriggersPerHour": .number(Double(hourlyCap))]
    }
}

enum PathwayEmailRetentionOverride {
    static func parse(_ value: String) throws -> JSONValue {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .null }
        guard let count = Int(trimmed), count > 0, count <= 9_007_199_254_740_991 else { throw PathwayIssueWriteError(message: "Retention overrides must be positive whole numbers, or empty to inherit.") }
        return .number(Double(count))
    }
}
