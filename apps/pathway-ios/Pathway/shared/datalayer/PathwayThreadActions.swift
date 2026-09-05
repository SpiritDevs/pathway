import Foundation
import Observation

enum PathwayThreadAction: Equatable, Sendable {
    case pin, unpin, settle, reopen, wake
    case sleep(until: Date)

    func command(threadID: String, commandID: String = UUID().uuidString.lowercased()) -> JSONValue {
        var fields: [String: JSONValue] = [
            "commandId": .string(commandID), "threadId": .string(threadID)
        ]
        let type: String
        switch self {
        case .pin: type = "thread.pin"
        case .unpin: type = "thread.unpin"
        case .settle: type = "thread.settle"
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
