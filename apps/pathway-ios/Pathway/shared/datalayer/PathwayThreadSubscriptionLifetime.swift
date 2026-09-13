import Foundation

/// The conversation and its pushed browser share a subscription, but hidden destinations do not.
@MainActor
final class PathwayThreadSubscriptionLifetime {
    enum Owner: Hashable { case conversation, browser }
    private var owners: Set<Owner> = []
    private var running = false
    private let start: @MainActor () -> Void
    private let stop: @MainActor () async -> Void
    private(set) var pendingStop: Task<Void, Never>?

    init(start: @escaping @MainActor () -> Void, stop: @escaping @MainActor () async -> Void) {
        self.start = start; self.stop = stop
    }

    func retain(_ owner: Owner) {
        owners.insert(owner)
        guard !running, pendingStop == nil else { return }
        running = true
        start()
    }

    func release(_ owner: Owner) {
        owners.remove(owner)
        guard owners.isEmpty, running, pendingStop == nil else { return }
        pendingStop = Task { [weak self] in
            guard let self else { return }
            // Navigation can hand ownership back before this task starts.
            guard owners.isEmpty else { pendingStop = nil; return }
            running = false
            await stop()
            pendingStop = nil
            // A new appearance must wait until the old RPC's asynchronous stop is complete.
            if !owners.isEmpty { running = true; start() }
        }
    }

    isolated deinit {
        // SwiftUI can discard a navigation stack without completing a pending transition.
        // Never stop from an unused @State initial value discarded during view reconstruction.
        guard running else { return }
        let stop = stop
        Task { await stop() }
    }
}
