import Foundation

struct PathwayThreadLaunchDraft: Sendable {
    let projectID: String
    let prompt: String
    let modelSelection: PathwayModelSelection
    let runtimeMode: String
    let interactionMode: String
    let workspaceMode: String
    let baseReference: String
    let branch: String
    let startFromOrigin: Bool
}

enum PathwayAgentThreadCommands {
    static func launchThread(
        _ draft: PathwayThreadLaunchDraft,
        identifier: String = UUID().uuidString.lowercased()
    ) -> JSONValue {
        let trimmedBranch = draft.branch.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceStrategy: JSONValue
        if draft.workspaceMode == "worktree" {
            var fields: [String: JSONValue] = [
                "type": .string("worktree"),
                "baseRef": .string(
                    draft.baseReference.trimmingCharacters(in: .whitespacesAndNewlines)
                ),
                "startFromOrigin": .bool(draft.startFromOrigin)
            ]
            if !trimmedBranch.isEmpty {
                fields["branch"] = .string(trimmedBranch)
            }
            workspaceStrategy = .object(fields)
        } else {
            workspaceStrategy = .object(["type": .string("root")])
        }

        var selection: [String: JSONValue] = [
            "instanceId": .string(draft.modelSelection.instanceId),
            "model": .string(draft.modelSelection.model)
        ]
        if let options = draft.modelSelection.options, !options.isEmpty {
            selection["options"] = .array(options.map { option in
                .object(["id": .string(option.id), "value": option.value])
            })
        }

        return .object([
            "commandId": .string(identifier),
            "creationSource": .string("mobile"),
            "projectId": .string(draft.projectID),
            "title": .string("New thread"),
            "generateTitle": .bool(true),
            "modelSelection": .object(selection),
            "runtimeMode": .string(draft.runtimeMode),
            "interactionMode": .string(draft.interactionMode),
            "locations": .array([.string("agents")]),
            "workspaceStrategy": workspaceStrategy,
            "initialMessage": .object([
                "messageId": .string(identifier),
                "text": .string(draft.prompt),
                "attachments": .array([])
            ])
        ])
    }

    static func dispatchMessage(
        threadID: String,
        text: String,
        hasActiveRun: Bool,
        identifier: String = UUID().uuidString.lowercased()
    ) -> JSONValue {
        .object([
            "type": .string("message.dispatch"),
            "commandId": .string(identifier),
            "createdBy": .string("user"),
            "creationSource": .string("mobile"),
            "threadId": .string(threadID),
            "messageId": .string(identifier),
            "text": .string(text),
            "attachments": .array([]),
            "dispatchMode": .object([
                "type": .string(hasActiveRun ? "queue_after_active" : "start_immediately")
            ])
        ])
    }

    static func runtimeResponse(
        threadID: String,
        requestID: String,
        fields: [String: JSONValue],
        commandID: String = UUID().uuidString.lowercased()
    ) -> JSONValue {
        var command: [String: JSONValue] = [
            "type": .string("runtime-request.respond"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "requestId": .string(requestID)
        ]
        command.merge(fields) { _, next in next }
        return .object(command)
    }
}
