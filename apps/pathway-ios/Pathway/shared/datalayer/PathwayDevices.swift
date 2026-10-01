import Foundation

/// One device's control lease, as `subscribeDeviceState` and the control RPCs report it.
struct PathwayDeviceControlState: Equatable, Sendable {
    enum Phase: String, Sendable { case idle, held, draining }
    enum Owner: Equatable, Sendable {
        case viewer(viewerID: String)
        case agent
    }

    let hostID: String
    let deviceID: String
    let generation: Int
    let phase: Phase
    let owner: Owner?

    init(hostID: String, deviceID: String, generation: Int, phase: Phase, owner: Owner?) {
        self.hostID = hostID
        self.deviceID = deviceID
        self.generation = generation
        self.phase = phase
        self.owner = owner
    }

    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let hostID = fields["hostId"]?.stringValue,
              let deviceID = fields["deviceId"]?.stringValue, let generation = fields["generation"]?.intValue,
              let phase = fields["phase"]?.stringValue.flatMap(Phase.init(rawValue:)) else { return nil }
        self.hostID = hostID
        self.deviceID = deviceID
        self.generation = generation
        self.phase = phase
        let owner = fields["owner"]?.objectValue
        switch owner?["kind"]?.stringValue {
        case "viewer": self.owner = owner?["viewerId"]?.stringValue.map { .viewer(viewerID: $0) }
        case "agent": self.owner = .agent
        default: self.owner = nil
        }
    }
}

/// The parts of a `subscribeDeviceState` snapshot the thread viewer reads.
struct PathwayDeviceState: Equatable, Sendable {
    struct Session: Equatable, Sendable {
        let threadID: String
        let hostID: String
        let deviceID: String
        let platform: String
        let openedAt: String
    }
    struct Device: Equatable, Sendable {
        let hostID: String
        let id: String
        let name: String
        let version: String
    }

    let revision: Int
    let hubBasePath: String
    let sessions: [Session]
    let devices: [Device]
    let hostLabels: [String: String]
    /// Whether the environment enforces device control leases. Older environments do not.
    let supportsDeviceControl: Bool
    let controls: [PathwayDeviceControlState]

    init(revision: Int, hubBasePath: String, sessions: [Session], devices: [Device], hostLabels: [String: String],
         supportsDeviceControl: Bool = false, controls: [PathwayDeviceControlState] = []) {
        self.revision = revision
        self.hubBasePath = hubBasePath
        self.sessions = sessions
        self.devices = devices
        self.hostLabels = hostLabels
        self.supportsDeviceControl = supportsDeviceControl
        self.controls = controls
    }

    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let revision = fields["revision"]?.intValue,
              let hubBasePath = fields["hubBasePath"]?.stringValue else { return nil }
        self.revision = revision
        self.hubBasePath = hubBasePath
        sessions = (fields["sessions"]?.arrayValue ?? []).compactMap { value in
            guard let session = value.objectValue, let threadID = session["threadId"]?.stringValue,
                  let hostID = session["hostId"]?.stringValue, let deviceID = session["deviceId"]?.stringValue,
                  let platform = session["platform"]?.stringValue, ["ios", "android"].contains(platform) else { return nil }
            return Session(threadID: threadID, hostID: hostID, deviceID: deviceID, platform: platform,
                           openedAt: session["openedAt"]?.stringValue ?? "")
        }
        devices = (fields["devices"]?.arrayValue ?? []).compactMap { value in
            guard let device = value.objectValue, let hostID = device["hostId"]?.stringValue,
                  let id = device["id"]?.stringValue else { return nil }
            return Device(hostID: hostID, id: id, name: device["name"]?.stringValue ?? "",
                          version: device["version"]?.stringValue ?? "")
        }
        var labels: [String: String] = [:]
        for host in fields["hosts"]?.arrayValue ?? [] {
            if let id = host.objectValue?["id"]?.stringValue, let label = host.objectValue?["label"]?.stringValue { labels[id] = label }
        }
        hostLabels = labels
        supportsDeviceControl = fields["supportsDeviceControl"]?.boolValue == true
        controls = (fields["controls"]?.arrayValue ?? []).compactMap(PathwayDeviceControlState.init)
    }
}

/// One device open in a thread, as the button and picker show it.
struct PathwayThreadDevicePreview: Identifiable, Equatable, Sendable {
    let hostID: String
    let deviceID: String
    let platform: String
    let name: String
    /// "iOS 18.0 · Mac mini"; the host label appears only when the environment has several hosts.
    let detail: String
    var id: String { Self.key(hostID: hostID, deviceID: deviceID) }

    /// Device IDs are unique per host, not per environment.
    static func key(hostID: String, deviceID: String) -> String { "\(hostID)\n\(deviceID)" }

    /// The devices open in `threadID`, oldest first.
    static func previews(_ state: PathwayDeviceState, threadID: String) -> [PathwayThreadDevicePreview] {
        let multipleHosts = Set(state.sessions.map(\.hostID)).union(state.hostLabels.keys).count > 1
        return state.sessions.filter { $0.threadID == threadID }.sorted { $0.openedAt < $1.openedAt }.map { session in
            let device = state.devices.first { $0.hostID == session.hostID && $0.id == session.deviceID }
            let fallback = session.platform == "ios" ? "iOS Simulator" : "Android Emulator"
            let name = device?.name.isEmpty == false ? device!.name : fallback
            let host = multipleHosts ? state.hostLabels[session.hostID] : nil
            let detail = [device?.version, host].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            return PathwayThreadDevicePreview(hostID: session.hostID, deviceID: session.deviceID, platform: session.platform,
                                              name: name, detail: detail)
        }
    }

    static func buttonTitle(count: Int) -> String { count == 1 ? "One device open" : "\(count) devices open" }
}

/// Who drives the device the viewer shows. Only this viewer's held lease, or an environment
/// without leases while no run is active, lets touches reach the device.
enum PathwayDeviceControl: Equatable, Sendable {
    /// Device or run state is not live, for example while reconnecting; the viewer only watches.
    case unknown
    /// This viewer asked for control and the previous owner's input is finishing.
    case taking
    /// This viewer holds the lease.
    case you
    /// An agent run holds the lease, or on an environment without leases, the agent's run is active.
    case agent
    /// Another viewer, on this or another client, holds the lease.
    case viewer
    /// Nobody holds the lease.
    case nobody
    /// The previous owner's input is still finishing.
    case finishing
    /// An environment without leases and no active run; touches reach the device unguarded.
    case idle

    /// Control on an environment that enforces leases. `lease` is this viewer's latest acquire or renew
    /// response, which can be newer than the last snapshot; a newer snapshot supersedes it.
    static func resolve(_ state: PathwayDeviceState, hostID: String, deviceID: String, viewerID: String,
                        lease: PathwayDeviceControlState?, acquiring: Bool) -> Self {
        if acquiring { return .taking }
        let lease = lease.flatMap { $0.hostID == hostID && $0.deviceID == deviceID ? $0 : nil }
        let reported = state.controls.first { $0.hostID == hostID && $0.deviceID == deviceID }
        guard let current = [reported, lease].compactMap({ $0 }).max(by: { $0.generation < $1.generation }) else { return .nobody }
        switch (current.phase, current.owner) {
        case (.draining, _): return .finishing
        case (.held, .agent): return .agent
        case let (.held, .viewer(id)): return id == viewerID && lease?.generation == current.generation ? .you : .viewer
        case (.idle, _), (.held, nil): return .nobody
        }
    }

    /// Control on an environment without leases: watch-only while the agent's run is active.
    static func unleased(runStateKnown: Bool, activeRunID: String?) -> Self {
        guard runStateKnown else { return .unknown }
        return activeRunID == nil ? .idle : .agent
    }

    var label: String {
        switch self {
        case .unknown: "Reconnecting to the device…"
        case .taking: "Taking control…"
        case .you: "You have control"
        case .agent: "The agent is using the device"
        case .viewer: "Someone else is controlling the device"
        case .nobody: "Nobody is controlling the device"
        case .finishing: "Finishing the last input…"
        case .idle: "Agent idle — you can use the device"
        }
    }

    var acceptsInput: Bool { self == .you || self == .idle }
    /// Whether Take control applies; environments without leases never offer it.
    var canTake: Bool { [.agent, .viewer, .nobody, .finishing].contains(self) }

    static let defaultResumeMessage = "I'm done with the device. Continue from its current state."

    /// What the viewer says when a device request fails.
    static func message(for error: Error) -> String {
        guard case let PathwayRPCError.deviceControl(code, message) = error else { return error.localizedDescription }
        return switch code {
        case "control_required": "Take control of the device first."
        case "control_held": "Someone else is controlling this device."
        case "stale_generation": "Your control of the device ended. Take control again if you still need it."
        case "control_draining": "The device is still finishing its last input. Try again in a moment."
        case "run_stopped": "The agent's run already ended."
        case "invalid_grant": "The device's control session is no longer valid. Reopen the device and try again."
        case "input_unconfirmed": "The device may not have received the last input. Restart its device tools before taking control."
        default: message
        }
    }
}

/// The `{viewerId, generation}` a held lease proves itself with, on input URLs and device mutations.
struct PathwayDeviceControlProof: Equatable, Sendable {
    let viewerID: String
    let generation: Int

    var json: JSONValue { .object(["viewerId": .string(viewerID), "generation": .number(Double(generation))]) }
    var page: [String: Any] { ["viewerId": viewerID, "generation": generation] }
}

/// This viewer's device control lease. The environment ties leases to the RPC connection that
/// acquired them, so one connection lives from acquire to release; closing it releases the lease,
/// and the lease's 30-second expiry covers a release that never arrives.
@MainActor @Observable
final class PathwayDeviceControlLease {
    struct Connection: Sendable {
        let request: @Sendable (String, JSONValue) async throws -> JSONValue
        let close: @Sendable () async -> Void
    }

    /// Distinct per mounted viewer.
    let viewerID = UUID().uuidString.lowercased()
    /// The latest acquire or renew response while this viewer holds the lease.
    private(set) var lease: PathwayDeviceControlState?
    private(set) var acquiring = false
    @ObservationIgnored private var connection: Connection?
    @ObservationIgnored private var renewal: Task<Void, Never>?
    /// Bumped by every acquire and release, so a superseded response is dropped.
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private let connect: @MainActor () -> Connection

    static let renewInterval: Duration = .seconds(10)

    init(connect: @escaping @MainActor () -> Connection) { self.connect = connect }

    convenience init(connect client: PathwayConnectClient, environment: PathwayCompanyEnvironment) {
        self.init {
            let rpc = PathwayRPCClient(reconnectsSubscriptions: false) { try await client.prepare(environment: environment).webSocketURL }
            return Connection(
                // Acquiring waits for the previous owner's input to finish.
                request: { tag, payload in
                    try await rpc.request(tag, payload: payload, timeout: tag == "device.acquireControl" ? .seconds(120) : .seconds(30))
                },
                close: { await rpc.stop() }
            )
        }
    }

    var proof: PathwayDeviceControlProof? { lease.map { PathwayDeviceControlProof(viewerID: viewerID, generation: $0.generation) } }

    /// Takes the device from whoever has it and keeps the lease renewed until `release`.
    func acquire(hostID: String, deviceID: String) async throws {
        try? await release()
        epoch += 1
        let epoch = epoch
        let connection = connect()
        self.connection = connection
        acquiring = true
        defer { if epoch == self.epoch { acquiring = false } }
        do {
            let state = try await connection.request("device.acquireControl", .object([
                "hostId": .string(hostID), "deviceId": .string(deviceID), "viewerId": .string(viewerID)
            ]))
            guard epoch == self.epoch else { return }
            lease = PathwayDeviceControlState(state).flatMap { $0.phase == .held && $0.owner == .viewer(viewerID: viewerID) ? $0 : nil }
            guard lease != nil else { await drop(); return }
            renewal = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: Self.renewInterval)
                    guard !Task.isCancelled else { return }
                    await self?.renew()
                }
            }
        } catch {
            if epoch == self.epoch { await drop() }
            throw error
        }
    }

    /// Extends the lease. A refusal means it ended, so the viewer falls back to the latest snapshot.
    func renew() async {
        guard let held = lease, let connection else { return }
        let epoch = epoch
        do {
            let state = try await connection.request("device.renewControl", payload(held))
            guard epoch == self.epoch else { return }
            if let next = PathwayDeviceControlState(state), next.generation == held.generation, next.phase == .held { lease = next }
        } catch PathwayRPCError.deviceControl {
            if epoch == self.epoch { await drop() }
        } catch {
            // A transient failure retries on the next tick; expiry or a closed connection ends the lease.
        }
    }

    /// Gives the device up and waits for the environment to finish this viewer's input.
    /// Throws only when the environment could not be reached.
    func release() async throws {
        epoch += 1
        renewal?.cancel()
        renewal = nil
        acquiring = false
        let held = lease, connection = connection
        lease = nil
        self.connection = nil
        guard let connection else { return }
        // The release finishes even if the caller's task is cancelled, for example when the viewer goes away.
        try await Task {
            defer { Task { await connection.close() } }
            guard let held else { return }
            do { _ = try await connection.request("device.releaseControl", self.payload(held)) }
            catch PathwayRPCError.deviceControl {}
        }.value
    }

    private func drop() async {
        renewal?.cancel()
        renewal = nil
        lease = nil
        let connection = connection
        self.connection = nil
        await connection?.close()
    }

    private func payload(_ held: PathwayDeviceControlState) -> JSONValue {
        .object(["hostId": .string(held.hostID), "deviceId": .string(held.deviceID), "viewerId": .string(viewerID),
                 "generation": .number(Double(held.generation))])
    }
}

/// What the viewer page needs to open one device's media and input through the environment.
/// Media requests cannot carry bearer or DPoP headers, so they carry the connection's `wsTicket`.
enum PathwayDeviceHubAccess {
    /// Assumed lifetime when the environment does not report the ticket's expiry; tickets live five minutes.
    static let fallbackTicketLifetime: TimeInterval = 270

    /// The `DeviceHubAccess` object the shared stream client reads, or nil when the URLs do not fit.
    static func make(httpBaseURL: URL, webSocketURL: URL, hubBasePath: String, hostID: String, expiresAt: Date) -> [String: Any]? {
        guard var http = URLComponents(url: httpBaseURL, resolvingAgainstBaseURL: false),
              let ticket = URLComponents(url: webSocketURL, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "wsTicket" })?.value, !ticket.isEmpty,
              hubBasePath.hasPrefix("/") else { return nil }
        http.path = hubBasePath
        http.query = nil
        http.fragment = nil
        guard let httpBase = http.url?.absoluteString, let scheme = http.scheme, ["http", "https"].contains(scheme) else { return nil }
        return [
            "httpBase": httpBase,
            "wsBase": (scheme == "https" ? "wss" : "ws") + httpBase.dropFirst(scheme.count),
            "query": ["wsTicket": ticket, "hostId": hostID],
            "credentials": false,
            "expiresAt": expiresAt.timeIntervalSince1970 * 1000
        ]
    }

    /// The page's origin; media and input are same-origin from there.
    static func origin(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

extension PathwayAgentThreadModel {
    /// Whether this thread's server serves device sessions.
    var servesDevices: Bool { serverConfig["deviceWorkspace"]?.boolValue == true }

    /// Hands the device back: a follow-up the agent runs once nothing else is active.
    func resumeAfterDeviceControl(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let identifier = UUID().uuidString.lowercased()
        try await dispatch("message.dispatch", fields: [
            "commandId": .string(identifier), "createdBy": .string("user"), "creationSource": .string("mobile"),
            "messageId": .string(identifier), "text": .string(trimmed.isEmpty ? PathwayDeviceControl.defaultResumeMessage : trimmed),
            "attachments": .array([]),
            "dispatchMode": .object(["type": .string(activeRunID == nil ? "start_immediately" : "queue_after_active")]),
            "modelSelection": try Self.json(currentModelSelection), "runtimeMode": .string(runtimeMode),
            "interactionMode": .string(interactionMode)
        ])
    }
}

/// Watches the environment's device sessions while the thread is on screen.
@MainActor @Observable
final class PathwayThreadDevicesModel {
    private(set) var state: PathwayDeviceState?
    /// False while the subscription reconnects; `state` may then be stale.
    private(set) var isLive = false
    @ObservationIgnored let threadID: String
    @ObservationIgnored let environment: PathwayCompanyEnvironment
    @ObservationIgnored let connect: PathwayConnectClient

    init(threadID: String, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient) {
        self.threadID = threadID
        self.environment = environment
        self.connect = connect
    }

    var previews: [PathwayThreadDevicePreview] {
        state.map { PathwayThreadDevicePreview.previews($0, threadID: threadID) } ?? []
    }

    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private var subscription: Task<Void, Never>?

    /// Keeps device state live until the calling task is cancelled. Callers share one
    /// subscription, so the thread and its viewer can hand off without a gap.
    func watch() async {
        watchers += 1
        if subscription == nil { subscription = Task { [weak self] in await self?.subscribe() } }
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        watchers -= 1
        if watchers == 0 { subscription?.cancel(); subscription = nil }
    }

    /// Runs until cancelled; the RPC client reconnects its own subscription.
    private func subscribe() async {
        let connect = connect, environment = environment
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        defer { Task { await rpc.stop() }; isLive = false }
        var acceptsAnyRevision = true
        do {
            for try await value in await rpc.subscribe("subscribeDeviceState", payload: .object([:]), bufferingPolicy: .bufferingNewest(1)) {
                // A reconnect may land on a restarted server whose revisions start over.
                if value.objectValue?["_pathwayTransport"] != nil { acceptsAnyRevision = true; isLive = false; continue }
                guard let next = PathwayDeviceState(value) else { continue }
                if acceptsAnyRevision || next.revision >= (state?.revision ?? .min) {
                    if next != state { state = next }
                    acceptsAnyRevision = false
                    if !isLive { isLive = true }
                }
            }
        } catch {}
    }

    /// Closes the thread's session and shuts the simulator or emulator down. Environments with
    /// control leases require this viewer's `control` proof.
    func shutDown(_ preview: PathwayThreadDevicePreview, control: PathwayDeviceControlProof?) async throws {
        let rpc = PathwayRPCClient(reconnectsSubscriptions: false) { [connect, environment] in
            try await connect.prepare(environment: environment).webSocketURL
        }
        defer { Task { await rpc.stop() } }
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID), "hostId": .string(preview.hostID),
            "deviceId": .string(preview.deviceID), "shutdown": .bool(true)
        ]
        if let control { payload["control"] = control.json }
        _ = try await rpc.request("device.close", payload: .object(payload))
    }
}
