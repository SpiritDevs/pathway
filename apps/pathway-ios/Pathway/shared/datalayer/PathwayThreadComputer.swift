import Foundation

/// The fields of one `ThreadComputerState` snapshot the thread view reads.
struct PathwayThreadComputerState: Equatable, Sendable {
    struct Window: Equatable, Sendable { let id: String; let appName: String? }

    let threadID: String
    var version: Int
    let computerID: String
    var windows: [Window]
    let agentActive: Bool
    let activity: String?
    let controlOwnerThreadID: String?
    let controlledByOtherThread: Bool
    let availability: String
    var inputStopped: Bool
    let controlGeneration: Int?

    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let threadID = fields["threadId"]?.stringValue,
              let version = fields["version"]?.intValue, let computerID = fields["computerId"]?.stringValue else { return nil }
        self.threadID = threadID
        self.version = version
        self.computerID = computerID
        windows = Self.windows(fields["windows"])
        agentActive = fields["agentActive"]?.boolValue == true
        activity = fields["activity"]?.stringValue
        controlOwnerThreadID = fields["controlOwnerThreadId"]?.stringValue
        controlledByOtherThread = fields["controlledByOtherThread"]?.boolValue == true
        availability = fields["availability"]?.objectValue?["kind"]?.stringValue ?? "unknown"
        inputStopped = fields["inputStopped"]?.boolValue == true
        controlGeneration = fields["controlGeneration"]?.intValue
    }

    static func windows(_ value: JSONValue?) -> [Window] {
        (value?.arrayValue ?? []).compactMap { window in
            window.objectValue?["id"]?.stringValue.map { Window(id: $0, appName: window.objectValue?["appName"]?.stringValue) }
        }
    }

    /// Whether this thread is the one driving the desktop; a bystander sees the owner too.
    var drives: Bool { controlOwnerThreadID == threadID || (agentActive && !controlledByOtherThread) }
}

/// One thread's Computer preview, as the web popover runs it. `armed` waits for the thread to be
/// on screen, `live` shows the card, `hiddenForTask` stays closed until the next drive turn,
/// and `ended` keeps the last action once the agent lets go.
struct PathwayThreadComputerSession: Equatable, Sendable {
    enum Phase: Equatable, Sendable { case armed, live, hiddenForTask, ended }

    let threadID: String
    private(set) var state: PathwayThreadComputerState?
    private(set) var phase: Phase?
    private(set) var lastActionLabel: String?
    private(set) var hostInputStopped = false
    private var drove = false

    init(threadID: String) { self.threadID = threadID }

    /// Applies one `computer.subscribeEvents` value; events for other threads are ignored.
    mutating func apply(event value: JSONValue) {
        guard let fields = value.objectValue else { return }
        switch fields["type"]?.stringValue {
        case "computer.thread-state":
            if let state = fields["state"].flatMap(PathwayThreadComputerState.init) { upsert(state) }
        case "computer.windows-changed":
            state?.windows = PathwayThreadComputerState.windows(fields["windows"])
        case "computer.action":
            guard fields["threadId"]?.stringValue == threadID, let label = Self.actionLabel(fields, windows: state?.windows ?? []) else { return }
            lastActionLabel = label
            // An attributed action is itself proof the thread drives.
            if phase == nil { phase = .armed }
        case "computer.open-pane-requested":
            guard fields["threadId"]?.stringValue == threadID else { return }
            if phase != .live && phase != .armed { phase = .armed }
        case "computer.input-stopped":
            hostInputStopped = fields["stopped"]?.boolValue == true
            state?.inputStopped = hostInputStopped
        default:
            break
        }
    }

    /// A pushed or seeded snapshot. Only a newer version lands; a change in who drives is an edge.
    mutating func upsert(_ next: PathwayThreadComputerState) {
        guard next.threadID == threadID, next.version > state?.version ?? .min else { return }
        state = next
        guard next.drives != drove else { return }
        drove = next.drives
        if drove { phase = phase == .live ? .live : .armed } else if phase != nil { phase = .ended }
    }

    /// A lost or new connection: keep what shows, and let the next snapshot replace it whatever its version.
    mutating func rebase() {
        state?.version = -1
        hostInputStopped = false
    }

    /// The thread is on screen, so an armed preview opens.
    mutating func viewed() { if phase == .armed { phase = .live } }

    /// Closed by the user until the next drive turn.
    mutating func hide() { if phase == .armed || phase == .live { phase = .hiddenForTask } }

    var isOpen: Bool { phase == .live }

    /// Whether the current connection has delivered a snapshot since the last rebase.
    var isConfirmed: Bool { (state?.version ?? -1) >= 0 }

    /// The control epoch a send may pin to: only one the current connection confirmed.
    var confirmedControlGeneration: Int? { isConfirmed ? state?.controlGeneration : nil }

    /// The computer whose stills the open card streams: only once the current connection confirmed it.
    var streamingComputerID: String? { isOpen && isConfirmed && state?.availability == "available" ? state?.computerID : nil }

    /// What the agent is doing while it drives, "Live" before its first action, or the last action after.
    var statusLabel: String? {
        if hostInputStopped || state?.inputStopped == true { return "Stopped via Escape" }
        if state?.controlOwnerThreadID != nil || state?.agentActive == true { return state?.activity ?? lastActionLabel ?? "Live" }
        return lastActionLabel
    }

    /// The action, its app and how it was delivered: "Click · Safari · Background action".
    static func actionLabel(_ fields: [String: JSONValue], windows: [PathwayThreadComputerState.Window]) -> String? {
        guard let action = fields["action"]?.stringValue else { return nil }
        var title = PathwayComputerTool.name(action).flatMap { PathwayComputerTool.titles[$0] }
        if title == nil {
            let fallback = action.replacing(/^computer[_.]/, with: "").replacing(/[_.]+/, with: " ").trimmingCharacters(in: .whitespaces)
            if let first = fallback.first { title = first.uppercased() + fallback.dropFirst() }
        }
        guard var label = title else { return nil }
        if fields["ok"]?.boolValue != true {
            label = fields["message"]?.stringValue.map { "\(label) failed: \($0)" } ?? "\(label) failed"
        }
        let windowID = fields["windowId"]?.stringValue
        let app = windows.first { $0.id == windowID }?.appName
        let delivery = fields["delivery"]?.objectValue?["path"]?.stringValue.map { $0.contains("foreground") ? "Temporary foreground" : "Background action" }
        return [label, app, delivery].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }
}

/// Watches one thread's Computer state while its chat is on screen and streams the
/// open card's stills. Owns its own sockets, so a closed chat costs nothing.
@MainActor
@Observable
final class PathwayThreadComputerModel {
    private(set) var session: PathwayThreadComputerSession
    let frames: PathwayComputerFrameStream
    @ObservationIgnored private let connect: PathwayConnectClient
    @ObservationIgnored private let environment: PathwayCompanyEnvironment
    /// Bumped on every connection change, so a seed read from an older socket never lands.
    @ObservationIgnored private var connection = 0

    init(threadID: String, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient) {
        session = PathwayThreadComputerSession(threadID: threadID)
        self.connect = connect
        self.environment = environment
        frames = PathwayComputerFrameStream { computerID in
            let socketURL = try await connect.prepare(environment: environment).webSocketURL
            guard let url = pathwayComputerFrameSocketURL(rpcSocketURL: socketURL, computerID: computerID) else { throw URLError(.badURL) }
            return url
        }
    }

    /// Runs until cancelled: subscribes to Computer events, re-seeds this thread's
    /// state on every (re)connect, and streams stills only while the card is open.
    func watch() async {
        let connect = connect, environment = environment, threadID = session.threadID
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        var seed: Task<Void, Never>?
        defer {
            seed?.cancel()
            connectionChanged()
            frames.stream(nil)
            Task { await rpc.stop() }
        }
        do {
            // Thread states are whole snapshots, so a burst may drop older ones.
            for try await value in await rpc.subscribe("computer.subscribeEvents", payload: .object([:]), bufferingPolicy: .bufferingNewest(64)) {
                if let transport = value.objectValue?["_pathwayTransport"]?.stringValue {
                    connectionChanged()
                    seed?.cancel()
                    guard transport == "connecting" else { continue }
                    // Also registers this socket's interest in the thread's pushes.
                    seed = Task { [weak self] in
                        await self?.applySeed { try? await rpc.request("computer.getThreadState", payload: .object(["threadId": .string(threadID)])) }
                    }
                } else {
                    update { $0.apply(event: value) }
                }
            }
        } catch {}
    }

    /// A lost or new socket: what shows stays, but nothing from before it is trusted,
    /// and stills pause until this connection's seed confirms the computer again.
    func connectionChanged() {
        connection += 1
        update { $0.rebase() }
    }

    /// Lands one seed read, unless it was cancelled or its connection has since changed.
    func applySeed(_ read: () async -> JSONValue?) async {
        let connection = connection
        guard let value = await read(), !Task.isCancelled, connection == self.connection,
              let state = PathwayThreadComputerState(value) else { return }
        update { $0.upsert(state) }
    }

    /// The chat rendering the card: an armed preview opens.
    func viewed() { update { $0.viewed() } }
    func hide() { update { $0.hide() } }

    private func update(_ change: (inout PathwayThreadComputerSession) -> Void) {
        var next = session
        change(&next)
        if next != session { session = next }
        frames.stream(session.streamingComputerID)
    }
}
