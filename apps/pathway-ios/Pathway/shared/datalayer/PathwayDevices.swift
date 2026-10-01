import Foundation

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

    init(revision: Int, hubBasePath: String, sessions: [Session], devices: [Device], hostLabels: [String: String]) {
        self.revision = revision
        self.hubBasePath = hubBasePath
        self.sessions = sessions
        self.devices = devices
        self.hostLabels = hostLabels
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

/// Who drives the device the viewer shows. The server has no device control lease yet, so this
/// follows the thread's run, and the viewer accepts input only once the run is known to have stopped.
enum PathwayDeviceControl: Equatable, Sendable {
    /// The thread's run state is unknown, for example while it reconnects; the viewer only watches.
    case unknown
    /// The agent's run is active; the viewer only watches.
    case agent
    /// The user interrupted the run and it has not finished stopping; the viewer still only watches.
    case stopping
    /// The user stopped the agent's run to drive the device.
    case user
    /// No run is active; touches reach the device.
    case idle

    /// `interruptedRunID` is the run the user's interrupt was accepted for; any other active run belongs to the agent.
    static func resolve(runStateKnown: Bool, activeRunID: String?, interruptedRunID: String?) -> Self {
        guard runStateKnown else { return .unknown }
        if let activeRunID { return activeRunID == interruptedRunID ? .stopping : .agent }
        return interruptedRunID == nil ? .idle : .user
    }

    var label: String {
        switch self {
        case .unknown: "Reconnecting to the agent…"
        case .agent: "Agent is using the device"
        case .stopping: "Stopping the agent…"
        case .user: "You have control"
        case .idle: "Agent idle — you can use the device"
        }
    }

    var acceptsInput: Bool { self == .user || self == .idle }

    static let defaultResumeMessage = "I'm done with the device. Continue from its current state."
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
        defer { Task { await rpc.stop() } }
        var acceptsAnyRevision = true
        do {
            for try await value in await rpc.subscribe("subscribeDeviceState", payload: .object([:]), bufferingPolicy: .bufferingNewest(1)) {
                // A reconnect may land on a restarted server whose revisions start over.
                if value.objectValue?["_pathwayTransport"] != nil { acceptsAnyRevision = true; continue }
                guard let next = PathwayDeviceState(value) else { continue }
                if acceptsAnyRevision || next.revision >= (state?.revision ?? .min) {
                    if next != state { state = next }
                    acceptsAnyRevision = false
                }
            }
        } catch {}
    }

    /// Closes the thread's session and shuts the simulator or emulator down.
    func shutDown(_ preview: PathwayThreadDevicePreview) async throws {
        let rpc = PathwayRPCClient(reconnectsSubscriptions: false) { [connect, environment] in
            try await connect.prepare(environment: environment).webSocketURL
        }
        defer { Task { await rpc.stop() } }
        _ = try await rpc.request("device.close", payload: .object([
            "threadId": .string(threadID), "hostId": .string(preview.hostID),
            "deviceId": .string(preview.deviceID), "shutdown": .bool(true)
        ]))
    }
}
