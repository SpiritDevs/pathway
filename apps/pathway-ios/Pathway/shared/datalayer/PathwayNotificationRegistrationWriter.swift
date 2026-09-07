import Foundation

/// Serialize relay writes and replace a waiting snapshot with the most recent preferences/tokens.
/// Fencing drops queued work but drains an in-flight write before account cleanup may proceed.
@MainActor final class PathwayNotificationRegistrationWriter {
    typealias Write = @MainActor (_ payload: JSONValue, _ reset: Bool) async throws -> Void
    private struct Pending {
        let payload: JSONValue
        let reset: Bool
        let write: Write
        let sequence: Int
    }
    private struct Waiter {
        let sequence: Int
        let continuation: CheckedContinuation<Bool, any Error>
    }
    private var pending: Pending?
    private var waiters: [Waiter] = []
    private var task: Task<Void, Never>?
    private var sequence = 0
    private var generation = 0
    private var accepting = true
    var isBusy: Bool { task != nil }

    func submit(_ payload: JSONValue, reset: Bool = false, write: @escaping Write) async throws -> Bool {
        guard accepting, !Task.isCancelled else { throw CancellationError() }
        sequence += 1
        let number = sequence
        pending = Pending(payload: payload, reset: reset || pending?.reset == true, write: write, sequence: number)
        return try await withCheckedThrowingContinuation { continuation in
            waiters.append(Waiter(sequence: number, continuation: continuation))
            if task == nil {
                let epoch = generation
                task = Task { await drain(epoch: epoch) }
            }
        }
    }

    @discardableResult func fence() -> Task<Void, Never>? {
        accepting = false; generation += 1; pending = nil
        let cancelled = waiters; waiters = []
        cancelled.forEach { $0.continuation.resume(throwing: CancellationError()) }
        return task
    }

    func resume() {
        precondition(task == nil, "Drain the previous account's registration before resuming")
        accepting = true
    }

    private func drain(epoch: Int) async {
        defer { task = nil }
        while generation == epoch, let operation = pending {
            pending = nil
            let result: Result<Void, any Error>
            do { try await operation.write(operation.payload, operation.reset); result = .success(()) }
            catch { result = .failure(error) }
            guard generation == epoch else { return }
            if case .failure = result, operation.reset, let next = pending {
                pending = Pending(payload: next.payload, reset: true, write: next.write, sequence: next.sequence)
            }
            let completed = waiters.filter { $0.sequence <= operation.sequence }
            waiters.removeAll { $0.sequence <= operation.sequence }
            let isLatest = operation.sequence == sequence
            for waiter in completed {
                waiter.continuation.resume(with: isLatest ? result.map { true } : .success(false))
            }
        }
    }
}
