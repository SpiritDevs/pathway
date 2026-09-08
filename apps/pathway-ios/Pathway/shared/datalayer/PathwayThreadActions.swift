import Foundation
import Observation

enum PathwayThreadAction: Equatable, Sendable {
    case pin, unpin, settle, reopen, wake
    case sleep(until: Date)
    case rename(String), archive, restore, delete, reorder(String)
    case keepConversation, attachProject(String), discardAndSettle
    case settleAfterCompletion(Bool)

    func command(threadID: String, commandID: String = UUID().uuidString.lowercased()) -> JSONValue {
        var fields: [String: JSONValue] = [
            "commandId": .string(commandID), "threadId": .string(threadID)
        ]
        let type: String
        switch self {
        case .pin: type = "thread.pin"
        case .unpin: type = "thread.unpin"
        case let .rename(title):
            type = "thread.metadata.update"
            fields["title"] = .string(title.trimmingCharacters(in: .whitespacesAndNewlines))
        case .archive: type = "thread.archive"
        case .restore: type = "thread.unarchive"
        case .delete: type = "thread.delete"
        case let .reorder(orderKey):
            type = "thread.pin.reorder"
            fields["orderKey"] = .string(orderKey)
        case .settle: type = "thread.settle"
        case .discardAndSettle:
            type = "thread.settle"
            fields["discardChanges"] = .bool(true)
        case .keepConversation:
            type = "thread.temporary.set"
            fields["temporary"] = .bool(false)
            fields["keep"] = .bool(true)
        case let .attachProject(projectID):
            type = "thread.project.attach"
            fields["projectId"] = .string(projectID)
        case let .settleAfterCompletion(enabled):
            type = "thread.settle-after-completion.set"
            fields["enabled"] = .bool(enabled)
        case .reopen:
            type = "thread.unsettle"
            fields["reason"] = .string("user")
        case .wake:
            type = "thread.unsnooze"
            fields["reason"] = .string("user")
        case let .sleep(until):
            type = "thread.snooze"
            fields["snoozedUntil"] = .string(until.ISO8601Format())
        }
        fields["type"] = .string(type)
        return .object(fields)
    }
}

@MainActor
@Observable
final class PathwayThreadActions {
    private(set) var pendingThreadIDs: Set<String> = []
    var errorMessage: String?
    var unfinishedGitThread: PathwayAgentThread?

    static func requiresDiscardConfirmation(_ error: Error) -> Bool {
        if case let PathwayRPCError.rejected(_, detail) = error {
            return detail == "temporary-unfinished-git-work"
        }
        return error.localizedDescription.contains("temporary-unfinished-git-work")
    }

    func perform(
        _ action: PathwayThreadAction,
        thread: PathwayAgentThread,
        environments: [PathwayCompanyEnvironment],
        connect: PathwayConnectClient?
    ) async {
        guard let connect, let environment = environments.first(where: {
            $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId
        }) else {
            errorMessage = "This thread’s environment is unavailable. Reconnect and try again."
            return
        }
        await perform(threadID: thread.id) {
            let rpc = PathwayRPCClient {
                try await connect.prepare(environment: environment).webSocketURL
            }
            do {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        _ = try await rpc.request(
                            "orchestration.dispatchCommand",
                            payload: action.command(threadID: thread.threadId)
                        )
                    }
                    group.addTask {
                        try await Task.sleep(for: .seconds(20))
                        throw URLError(.timedOut)
                    }
                    defer { group.cancelAll() }
                    _ = try await group.next()
                }
                await rpc.stop()
            } catch {
                await rpc.stop()
                if action == .settle && thread.shell.isTemporary && Self.requiresDiscardConfirmation(error) {
                    self.unfinishedGitThread = thread
                    return
                }
                throw error
            }
        }
    }

    func perform(threadID: String, send: () async throws -> Void) async {
        guard !pendingThreadIDs.contains(threadID) else { return }
        pendingThreadIDs.insert(threadID)
        defer { pendingThreadIDs.remove(threadID) }
        do {
            try await send()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
