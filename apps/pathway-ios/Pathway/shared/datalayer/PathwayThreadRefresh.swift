import Foundation
import Observation

/// The gesture has a deadline even when an SDK operation does not cooperate with cancellation.
@MainActor @Observable
final class PathwayThreadRefresh {
    enum Result: Equatable, Sendable {
        case updated
        case unavailable([String])
        case failed(String)
        case timedOut

        var message: String {
            switch self {
            case .updated: "Threads refreshed. Active environments are connected."
            case let .unavailable(names): "Threads refreshed. Couldn’t connect to: \(names.joined(separator: ", "))."
            case let .failed(message): message
            case .timedOut: "Refresh timed out. Showing the latest available threads. Pull down to try again."
            }
        }
    }

    private(set) var isRefreshing = false
    private(set) var result: Result?
    private(set) var revision = 0

    func run(
        deadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(15)) },
        operation: @escaping @MainActor () async throws -> Result
    ) async {
        guard !isRefreshing else { return }
        isRefreshing = true
        result = nil
        let (events, continuation) = AsyncStream<Result>.makeStream(bufferingPolicy: .bufferingOldest(1))
        let work = Task { @MainActor in
            do {
                let result = try await operation()
                try Task.checkCancellation()
                continuation.yield(result)
            } catch is CancellationError {
                continuation.finish()
            } catch {
                continuation.yield(.failed("Couldn’t refresh threads. Check your connection and pull down to try again."))
            }
        }
        let timer = Task {
            do {
                try await deadline()
                try Task.checkCancellation()
                continuation.yield(.timedOut)
            } catch { }
        }
        defer {
            work.cancel()
            timer.cancel()
            continuation.finish()
            isRefreshing = false
        }
        for await outcome in events {
            guard !Task.isCancelled else { return }
            result = outcome
            revision += 1
            return
        }
    }
}
