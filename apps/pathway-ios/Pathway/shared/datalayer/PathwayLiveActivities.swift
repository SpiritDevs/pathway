#if os(iOS)
import ActivityKit
import Foundation
import Observation

@MainActor @Observable final class PathwayLiveActivities {
    static let shared = PathwayLiveActivities()
    private(set) var isActive = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var accountKey: String?
    @ObservationIgnored private var deviceID: String?
    @ObservationIgnored private var connect: PathwayConnectClient?
    @ObservationIgnored private var enabled = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var activity: Activity<LiveActivityAttributes>?
    @ObservationIgnored private var observers: [Task<Void, Never>] = []
    @ObservationIgnored private var activityObservers: [Task<Void, Never>] = []
    @ObservationIgnored private var relayQueue: Task<Void, Never>?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var registeredToken: String?
    @ObservationIgnored private var startToken: String?
    @ObservationIgnored private var onPushToStartToken: (@MainActor (String?) async throws -> Void)?
    @ObservationIgnored private var onActivityEnded: (@MainActor () async throws -> Void)?
    private let ownerKey = "pathway.liveActivity.account"

    func configure(accountKey: String, deviceID: String, connect: PathwayConnectClient, enabled: Bool,
                   onPushToStartToken: @escaping @MainActor (String?) async throws -> Void,
                   onActivityEnded: @escaping @MainActor () async throws -> Void) async {
        if self.accountKey == accountKey, self.enabled == enabled, !enabled || !observers.isEmpty {
            self.connect = connect
            self.onPushToStartToken = onPushToStartToken
            self.onActivityEnded = onActivityEnded
            if enabled { await refresh() }
            return
        }
        if self.accountKey != nil { await stop(clearServerRegistration: true) }
        self.accountKey = accountKey; self.deviceID = deviceID; self.connect = connect
        self.onPushToStartToken = onPushToStartToken; self.onActivityEnded = onActivityEnded
        self.enabled = enabled
        let epoch = generation
        // ActivityKit persists cards across launches. Empty relay attributes cannot identify an account.
        // Retain the account namespace separately and dismiss cards before adopting a different owner.
        let previousOwner = UserDefaults.standard.string(forKey: ownerKey)
        if previousOwner != accountKey || !enabled {
            for existing in Activity<LiveActivityAttributes>.activities {
                await PathwayActivitySystem.end(id: existing.id, content: nil, policy: .immediate)
            }
        }
        guard generation == epoch else { return }
        UserDefaults.standard.set(accountKey, forKey: ownerKey)
        guard enabled else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            errorMessage = "Live Activities are disabled in system settings."
            enqueue(epoch: epoch) { try await onPushToStartToken(nil); try await onActivityEnded() }
            return
        }
        observers = [
            Task { [weak self] in
                for await value in Activity<LiveActivityAttributes>.activityUpdates {
                    guard let self, self.generation == epoch, !Task.isCancelled else { return }
                    await self.adopt(value, epoch: epoch)
                }
            },
            Task { [weak self] in
                for await token in Activity<LiveActivityAttributes>.pushToStartTokenUpdates {
                    guard let self, self.generation == epoch, !Task.isCancelled else { return }
                    self.publishStartToken(token, epoch: epoch)
                }
            },
            Task { [weak self] in
                for await allowed in ActivityAuthorizationInfo().activityEnablementUpdates {
                    guard let self, self.generation == epoch, !Task.isCancelled else { return }
                    if !allowed {
                        let hadActivity = self.activity != nil
                        self.startToken = nil
                        await self.endCurrent(content: nil, immediate: true, epoch: epoch)
                        self.enqueue(epoch: epoch) {
                            try await onPushToStartToken(nil)
                            if !hadActivity { try await onActivityEnded() }
                        }
                        self.errorMessage = "Live Activities are disabled in system settings."
                    } else { await self.refresh() }
                }
            }
        ]
        for existing in Activity<LiveActivityAttributes>.activities { await adopt(existing, epoch: epoch) }
        if let token = Activity<LiveActivityAttributes>.pushToStartToken { publishStartToken(token, epoch: epoch) }
        await refresh()
    }

    // Called at foreground entry, never as a polling loop. APNs owns background updates.
    func refresh() async {
        guard enabled, !refreshing, ActivityAuthorizationInfo().areActivitiesEnabled,
              let connect else { return }
        refreshing = true
        let epoch = generation
        let stateBeforeFetch = activity?.content.state
        if let token = Activity<LiveActivityAttributes>.pushToStartToken { publishStartToken(token, epoch: epoch) }
        if let token = activity?.pushToken { publishActivityToken(token, epoch: epoch) }
        defer { if generation == epoch { refreshing = false } }
        do {
            let response = try await connect.relayRequest(method: "GET", path: "/v1/mobile/agent-activity")
            struct Snapshot: Decodable { let aggregate: PathwayActivityAggregate? }
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: JSONEncoder().encode(response))
            guard generation == epoch, !Task.isCancelled else { return }
            guard let aggregate = snapshot.aggregate else {
                guard activity?.content.state == stateBeforeFetch else { return }
                await endCurrent(content: nil, immediate: true, epoch: epoch)
                return
            }
            let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
            let content = ActivityContent(state: state, staleDate: (aggregate.date ?? Date()).addingTimeInterval(600))
            if let current = activity {
                guard aggregate.shouldReplace(current.content.state.aggregate) else { return }
                if aggregate.canStart { await PathwayActivitySystem.update(id: current.id, content: content) }
                else { await endCurrent(content: content, immediate: false, epoch: epoch) }
            } else if aggregate.canStart {
                // Re-check OS state after the fetch: a push-to-start may have arrived in flight.
                if let existing = Activity<LiveActivityAttributes>.activities.first(where: { $0.activityState == .active || $0.activityState == .stale }) {
                    await adopt(existing, epoch: epoch)
                    if aggregate.shouldReplace(existing.content.state.aggregate) { await PathwayActivitySystem.update(id: existing.id, content: content) }
                } else {
                    let started = try Activity.request(attributes: LiveActivityAttributes(), content: content, pushType: .token)
                    await adopt(started, epoch: epoch)
                }
            }
            if generation == epoch { errorMessage = nil }
        } catch {
            guard generation == epoch, !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    // Await before invalidating credentials. The owner callback removes the server's old activity token.
    func stop(clearServerRegistration: Bool = false) async {
        generation += 1
        observers.forEach { $0.cancel() }; observers = []
        activityObservers.forEach { $0.cancel() }; activityObservers = []
        let previousQueue = relayQueue
        relayQueue = nil
        // Drain registrations first so a late old write cannot restore a token after cleanup.
        await previousQueue?.value
        let hadConfiguration = accountKey != nil
        let clearStart = onPushToStartToken
        let clearActivity = onActivityEnded
        let oldActivities = Activity<LiveActivityAttributes>.activities
        activity = nil; isActive = false; refreshing = false
        accountKey = nil; deviceID = nil; connect = nil; enabled = false
        registeredToken = nil; startToken = nil
        onPushToStartToken = nil; onActivityEnded = nil
        for existing in oldActivities { await PathwayActivitySystem.end(id: existing.id, content: nil, policy: .immediate) }
        if hadConfiguration && clearServerRegistration {
            do { try await clearStart?(nil); try await clearActivity?() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func adopt(_ candidate: Activity<LiveActivityAttributes>, epoch: Int) async {
        guard generation == epoch, enabled else { return }
        guard candidate.activityState == .active || candidate.activityState == .stale || candidate.activityState == .pending else { return }
        guard candidate.id != activity?.id else { return }
        if activity != nil {
            // The account has one aggregate card. A remote start racing a foreground start is redundant.
            await PathwayActivitySystem.end(id: candidate.id, content: nil, policy: .immediate)
            return
        }
        activity = candidate; isActive = true; registeredToken = nil
        activityObservers.forEach { $0.cancel() }
        activityObservers = [
            Task { [weak self] in
                for await token in candidate.pushTokenUpdates {
                    guard let self, self.generation == epoch, self.activity?.id == candidate.id, !Task.isCancelled else { return }
                    self.publishActivityToken(token, epoch: epoch)
                }
            },
            Task { [weak self] in
                for await state in candidate.activityStateUpdates {
                    guard let self, self.generation == epoch, self.activity?.id == candidate.id, !Task.isCancelled else { return }
                    if state == .ended || state == .dismissed {
                        self.activity = nil; self.isActive = false; self.registeredToken = nil; self.startToken = nil
                        if let cleanup = self.onActivityEnded { self.enqueue(epoch: epoch, operation: cleanup) }
                        return
                    }
                }
            }
        ]
        if let token = candidate.pushToken { publishActivityToken(token, epoch: epoch) }
    }

    private func endCurrent(content: ActivityContent<LiveActivityAttributes.ContentState>?, immediate: Bool, epoch: Int) async {
        guard let current = activity else { return }
        activity = nil; isActive = false; registeredToken = nil; startToken = nil
        activityObservers.forEach { $0.cancel() }; activityObservers = []
        await PathwayActivitySystem.end(id: current.id, content: content, policy: immediate ? .immediate : .after(Date().addingTimeInterval(300)))
        guard generation == epoch else { return }
        if let cleanup = onActivityEnded { enqueue(epoch: epoch, operation: cleanup) }
    }

    private func publishStartToken(_ data: Data, epoch: Int) {
        guard enabled, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard token != startToken, let callback = onPushToStartToken else { return }
        enqueue(epoch: epoch) { [weak self] in
            try await callback(token)
            if self?.generation == epoch { self?.startToken = token }
        }
    }

    private func publishActivityToken(_ data: Data, epoch: Int) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        guard token != registeredToken, let connect, let deviceID else { return }
        let activityID = activity?.id
        enqueue(epoch: epoch) { [weak self] in
            guard self?.activity?.id == activityID else { return }
            _ = try await connect.relayRequest(method: "POST", path: "/v1/mobile/live-activities", payload: .object([
                "deviceId": .string(deviceID), "activityPushToken": .string(token)
            ]))
            if self?.generation == epoch { self?.registeredToken = token }
        }
    }

    private func enqueue(epoch: Int, operation: @escaping @MainActor () async throws -> Void) {
        let previous = relayQueue
        relayQueue = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == epoch else { return }
            do { try await operation() }
            catch { if self.generation == epoch { self.errorMessage = error.localizedDescription } }
        }
    }
}
// ActivityKit handles are not Sendable in the current SDK. Transfer value IDs/content only,
// then resolve the handle on the executor where its asynchronous operation runs.
private enum PathwayActivitySystem {
    static func update(id: String, content: ActivityContent<LiveActivityAttributes.ContentState>) async {
        guard let activity = Activity<LiveActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.update(content)
    }
    static func end(id: String, content: ActivityContent<LiveActivityAttributes.ContentState>?, policy: ActivityUIDismissalPolicy) async {
        guard let activity = Activity<LiveActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        await activity.end(content, dismissalPolicy: policy)
    }
}
#endif
