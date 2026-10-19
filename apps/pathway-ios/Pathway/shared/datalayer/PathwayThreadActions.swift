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

// Keep the overlay until discovery reflects the command, not merely its RPC response.
struct PathwayOptimisticThreadAction {
    let id = UUID()
    let threadID: String
    let action: PathwayThreadAction
    let date: Date
    var baseline: PathwayAgentThread? = nil

    func applying(to thread: PathwayAgentThread) -> PathwayAgentThread {
        var result = thread
        let timestamp = date.ISO8601Format()
        switch action {
        case .pin: result.shell.pinnedAt = timestamp
        case .unpin: result.shell.pinnedAt = nil; result.shell.pinOrderKey = nil
        case let .reorder(key): result.shell.pinOrderKey = key
        case let .rename(title): result.shell.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        case .archive: result.shell.archivedAt = timestamp
        case .restore: result.shell.archivedAt = nil
        case .delete: result.shell.deletedAt = timestamp
        case .settle, .forceSettle, .discardAndSettle:
            result.shell.settledOverride = "settled"
            result.shell.settledAt = timestamp
            result.shell.pinnedAt = nil
            result.shell.pinOrderKey = nil
            result.shell.snoozedAt = nil
            result.shell.snoozedUntil = nil
            if thread.shell.isTemporary { result.shell.deletedAt = timestamp }
            if action == .forceSettle {
                result.shell.activeRunId = nil
                result.shell.activityRunStatus = "idle"
                result.shell.status = "idle"
                result.shell.pendingRuntimeRequest = nil
            }
        case .reopen: result.shell.settledOverride = "active"; result.shell.settledAt = nil
        case .wake: result.shell.snoozedAt = nil; result.shell.snoozedUntil = nil
        case let .sleep(until):
            result.shell.snoozedAt = timestamp
            result.shell.snoozedUntil = until.ISO8601Format()
        case .keepConversation: result.shell.temporary = false
        case let .attachProject(projectID): result.shell.projectId = projectID
        case let .settleAfterCompletion(enabled): result.shell.settleAfterCompletion = enabled
        case .regenerateTitle: break // The generated title is only known to the server.
        }
        return result
    }

    func isReflected(in thread: PathwayAgentThread) -> Bool {
        let shell = thread.shell
        switch action {
        case .pin: return shell.pinnedAt != nil
        case .unpin: return shell.pinnedAt == nil
        case let .reorder(key): return shell.pinOrderKey == key
        case let .rename(title): return shell.title == title.trimmingCharacters(in: .whitespacesAndNewlines)
        case .archive: return shell.archivedAt != nil
        case .restore: return shell.archivedAt == nil
        case .delete: return shell.deletedAt != nil
        case .settle, .forceSettle, .discardAndSettle:
            if baseline?.shell.isTemporary == true { return shell.deletedAt != nil }
            return shell.deletedAt != nil || (shell.settledOverride == "settled" && shell.pinnedAt == nil && shell.snoozedUntil == nil)
        case .reopen: return shell.settledOverride == "active"
        case .wake: return shell.snoozedUntil == nil
        case let .sleep(until): return shell.snoozedUntil.flatMap(pathwayDate) == pathwayDate(from: until.ISO8601Format())
        case .keepConversation: return !shell.isTemporary
        case let .attachProject(projectID): return shell.projectId == projectID
        case let .settleAfterCompletion(enabled): return (shell.settleAfterCompletion == true) == enabled
        case .regenerateTitle: return true
        }
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
        cloud: PathwayCloudModel? = nil,
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
            let mutation = cloud?.beginThreadAction(action, thread: thread)
            do {
                _ = try await request(environment, "orchestration.dispatchCommand", command)
                self.retryCommands.removeValue(forKey: thread.id)
            } catch {
                if let mutation { cloud?.rollbackThreadAction(mutation) }
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
