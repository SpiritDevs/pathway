import Foundation
import Observation

enum PathwayThreadAction: Equatable, Sendable {
    case pin, unpin, settle, reopen, wake, forceSettle, regenerateTitle
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
        case .forceSettle:
            type = "thread.settle"
            fields["force"] = .bool(true)
        case .regenerateTitle:
            type = "thread.metadata.update"
            fields["regenerateTitle"] = .bool(true)
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
    private(set) var failedAction: (action: PathwayThreadAction, thread: PathwayAgentThread)?
    private var retryCommands: [String: (action: PathwayThreadAction, command: JSONValue)] = [:]
    typealias Request = (PathwayCompanyEnvironment, String, JSONValue) async throws -> JSONValue

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
        request: Request
    ) async {
        guard let environment = environments.first(where: {
            $0.companyId == thread.companyId && $0.environment.environmentId == thread.environmentId
        }) else {
            errorMessage = "This thread’s environment is unavailable. Reconnect and try again."
            failedAction = nil
            return
        }
        await perform(threadID: thread.id) {
            self.errorMessage = nil
            self.failedAction = nil
            let previous = self.retryCommands[thread.id]
            let command: JSONValue
            if let previous, previous.action == action { command = previous.command }
            else { command = action.command(threadID: thread.threadId) }
            self.retryCommands[thread.id] = (action, command)
            do {
                _ = try await request(environment, "orchestration.dispatchCommand", command)
                self.retryCommands.removeValue(forKey: thread.id)
            } catch {
                if action == .settle && thread.shell.isTemporary && Self.requiresDiscardConfirmation(error) {
                    self.retryCommands.removeValue(forKey: thread.id)
                    self.unfinishedGitThread = thread
                    return
                }
                if Self.isConnectionFailure(error) {
                    self.failedAction = (action, thread)
                } else {
                    self.retryCommands.removeValue(forKey: thread.id)
                }
                throw error
            }
        }
    }

    private static func isConnectionFailure(_ error: Error) -> Bool {
        if let error = error as? URLError {
            return [.timedOut, .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost].contains(error.code)
        }
        if case PathwayRPCError.disconnected = error { return true }
        if case PathwayRPCError.timedOut = error { return true }
        return false
    }

    func perform(threadID: String, send: () async throws -> Void) async {
        guard !pendingThreadIDs.contains(threadID) else { return }
        pendingThreadIDs.insert(threadID)
        defer { pendingThreadIDs.remove(threadID) }
        do {
            try await send()
        } catch {
            if Self.isConnectionFailure(error) {
                errorMessage = "The environment did not confirm this action. Check its connection and retry. The thread will stay visible until the update is confirmed."
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}
