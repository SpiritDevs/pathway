import CoreGraphics
import Foundation
import ImageIO
import os

/// One frame from `/ws/environment-surface`: a 24-byte little-endian header, then one JPEG
/// (`@spiritdevs/shared/environmentSurface`). Width and height are encoded pixels; for a
/// computer, `deviceScale` is encoded pixels per desktop point.
struct PathwaySurfaceFrame: Equatable, Sendable {
    enum DecodeError: Error, Equatable { case badLength, unsupported, badHeader }

    static let magic: UInt16 = 0x5350
    static let headerBytes = 24
    static let maxBytes = 8 * 1024 * 1024

    let sequence: UInt32
    let width: Int
    let height: Int
    let deviceScale: Double
    let timestampMs: Double
    let jpeg: Data

    init(data: Data) throws(DecodeError) {
        guard data.count > Self.headerBytes, data.count <= Self.maxBytes else { throw .badLength }
        let bytes = [UInt8](data.prefix(Self.headerBytes))
        func integer<T: FixedWidthInteger>(_ offset: Int, _: T.Type) -> T {
            (0..<MemoryLayout<T>.size).reduce(T.zero) { $0 | T(bytes[offset + $1]) << ($1 * 8) }
        }
        guard integer(0, UInt16.self) == Self.magic, bytes[2] == 1, bytes[3] == 1 else { throw .unsupported }
        sequence = integer(4, UInt32.self)
        width = Int(integer(8, UInt16.self))
        height = Int(integer(10, UInt16.self))
        deviceScale = Double(Float(bitPattern: integer(12, UInt32.self)))
        timestampMs = Double(bitPattern: integer(16, UInt64.self))
        guard width > 0, height > 0, deviceScale.isFinite, deviceScale > 0, timestampMs.isFinite else { throw .badHeader }
        jpeg = data.subdata(in: data.startIndex + Self.headerBytes..<data.endIndex)
    }

    /// The primary display in desktop points: the space surface input coordinates use.
    var screenSize: CGSize { CGSize(width: Double(width) / deviceScale, height: Double(height) / deviceScale) }
}

/// Mirrors `ENVIRONMENT_SURFACE_WS_PATH` in `packages/contracts/src/environmentSurface.ts`.
enum PathwayEnvironmentSurfaceSocket {
    static let path = "/ws/environment-surface"
}

/// The surface route beside the RPC socket for one computer, keeping the prepared URL's ticket
/// as the Computer frame route does. The viewport is only an encoding budget.
func pathwayComputerSurfaceSocketURL(rpcSocketURL: URL, computerID: String, viewport: CGSize, deviceScale: Double) -> URL? {
    guard var components = URLComponents(url: rpcSocketURL, resolvingAgainstBaseURL: false) else { return nil }
    var path = components.path
    while path.hasSuffix("/") { path.removeLast() }
    if path.hasSuffix("/ws") { path.removeLast(3) }
    components.path = path + PathwayEnvironmentSurfaceSocket.path
    components.fragment = nil
    let clamp = { (value: Double) in String(Int(min(max(value.rounded(), 1), 4096))) }
    var query = (components.queryItems ?? []).filter { $0.name == "wsTicket" }
    query += [
        URLQueryItem(name: "kind", value: "computer"),
        URLQueryItem(name: "computerId", value: computerID),
        URLQueryItem(name: "width", value: clamp(viewport.width)),
        URLQueryItem(name: "height", value: clamp(viewport.height)),
        URLQueryItem(name: "deviceScale", value: String(min(max(deviceScale, 0.5), 4)))
    ]
    components.queryItems = query
    return components.url
}

/// Streams one computer's primary screen while the computer view shows it. Decodes off the
/// main actor, one frame at a time, keeping only the newest that arrived meanwhile. Answers the
/// server's `ping` receipts, and reconnects with backoff until eight failures in a row.
@MainActor
@Observable
final class PathwayComputerSurfaceStream {
    enum State: Equatable { case connecting, live, stale, failed }
    typealias ResolveURL = @Sendable (_ computerID: String) async throws -> URL
    typealias Decode = @Sendable (Data) async -> CGImage?
    nonisolated static let maxPixelSize = 2_048
    static let maxFailures = 8

    private(set) var image: CGImage?
    /// The latest frame's screen in desktop points; changes only with the host's geometry.
    private(set) var screenSize: CGSize?
    private(set) var state = State.connecting

    @ObservationIgnored private let resolveURL: ResolveURL
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let decodeFrame: Decode
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var decoding: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var lifetime = 0
    /// Whether the current socket has shown a frame, which resets the failure count.
    @ObservationIgnored private var delivered = false
    @ObservationIgnored private(set) var computerID: String?

    init(session: URLSession = .shared, decode: @escaping Decode = { PathwayComputerSurfaceStream.decode($0) },
         resolveURL: @escaping ResolveURL) {
        self.session = session
        decodeFrame = decode
        self.resolveURL = resolveURL
    }

    isolated deinit {
        task?.cancel()
        decoding?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    /// Streams `computerID`, or stops when nil. The same computer again is a no-op; use
    /// `reconnect()` to start over after a failure. The last image stays while paused.
    func stream(_ computerID: String?) {
        guard computerID != self.computerID else { return }
        self.computerID = computerID
        restart()
    }

    func reconnect() { restart() }

    private func restart() {
        lifetime += 1
        task?.cancel(); task = nil
        decoding?.cancel(); decoding = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        guard let computerID else { state = .stale; return }
        state = .connecting
        task = Task { [weak self, lifetime] in await self?.run(computerID, lifetime: lifetime) }
    }

    private func run(_ computerID: String, lifetime: Int) async {
        var failures = 0
        while !Task.isCancelled {
            state = failures == 0 ? .connecting : .stale
            var refused = false
            delivered = false
            do {
                let url = try await resolveURL(computerID)
                try Task.checkCancellation()
                refused = await connect(to: url, lifetime: lifetime)
            } catch is CancellationError { return } catch {}
            guard !Task.isCancelled, lifetime == self.lifetime else { return }
            failures = delivered ? 1 : failures + 1
            if refused || failures >= Self.maxFailures { state = .failed; task = nil; return }
            state = .stale
            let delay = min(30_000, 500 * (1 << min(failures - 1, 6)))
            do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
        }
    }

    /// Runs one socket until it ends; true when the server refused it for good.
    private func connect(to url: URL, lifetime: Int) async -> Bool {
        let socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = PathwaySurfaceFrame.maxBytes
        self.socket = socket
        socket.resume()
        defer {
            socket.cancel(with: .goingAway, reason: nil)
            if self.socket === socket { self.socket = nil }
            if lifetime == self.lifetime { decoding?.cancel(); decoding = nil }
        }
        var pending: PathwaySurfaceFrame?
        do {
            try await socket.send(.string("ready"))
            while !Task.isCancelled, lifetime == self.lifetime {
                let message = try await socket.receive()
                guard lifetime == self.lifetime else { break }
                switch message {
                case let .string(text):
                    // Also the server's backpressure receipt after each frame.
                    if text == "ping" { socket.send(.string("pong")) { _ in } }
                case let .data(data):
                    guard let frame = try? PathwaySurfaceFrame(data: data) else { continue }
                    if decoding != nil { pending = frame; continue }
                    var next: PathwaySurfaceFrame? = frame
                    let decodeFrame = decodeFrame
                    decoding = Task { [weak self] in
                        while let frame = next {
                            let decoded = await Task.detached(priority: .userInitiated) { await decodeFrame(frame.jpeg) }.value
                            guard let self, !Task.isCancelled, self.lifetime == lifetime else { return }
                            if let decoded {
                                self.image = decoded
                                if self.screenSize != frame.screenSize { self.screenSize = frame.screenSize }
                                if self.state != .live { self.state = .live }
                                self.delivered = true
                            }
                            next = pending; pending = nil
                        }
                        self?.decoding = nil
                    }
                @unknown default:
                    continue
                }
            }
        } catch {}
        let status = (socket.response as? HTTPURLResponse)?.statusCode
        return [400, 403, 404].contains(status ?? 0) || socket.closeCode == .policyViolation
    }

    /// Decodes a JPEG frame, downsampled so a large display never costs a full-size bitmap.
    nonisolated static func decode(_ payload: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(payload as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ] as CFDictionary)
    }
}

/// One `ComputerSurfaceSessionState`: who holds the screen, from this connection's point of view.
struct PathwayComputerSurfaceSession: Equatable, Sendable {
    enum Controller: Equatable, Sendable { case idle, agent(threadID: String), client(id: String) }
    enum Tone: Equatable, Sendable { case agent, mine, other, idle }

    let clientID: String
    let computerID: String
    let controller: Controller
    let activeThreadIDs: [String]
    let capture: Bool
    let input: Bool
    let pointerPhases: Bool

    init?(_ value: JSONValue) {
        guard let fields = value.objectValue, let clientID = fields["clientId"]?.stringValue,
              let state = fields["state"]?.objectValue, let computerID = state["computerId"]?.stringValue,
              let controller = state["controller"]?.objectValue else { return nil }
        self.clientID = clientID
        self.computerID = computerID
        switch controller["kind"]?.stringValue {
        case "agent": self.controller = .agent(threadID: controller["threadId"]?.stringValue ?? "")
        case "client": self.controller = .client(id: controller["clientId"]?.stringValue ?? "")
        default: self.controller = .idle
        }
        activeThreadIDs = (state["activeTurns"]?.arrayValue ?? []).compactMap { $0.objectValue?["threadId"]?.stringValue }
        let capabilities = state["capabilities"]?.objectValue
        capture = capabilities?["capture"]?.boolValue == true
        input = capabilities?["input"]?.boolValue == true
        pointerPhases = capabilities?["pointerPhases"]?.boolValue == true
    }

    /// This connection holds control, so its input reaches the screen.
    var mine: Bool { controller == .client(id: clientID) }

    var tone: Tone {
        switch controller {
        case .agent: .agent
        case let .client(id): id == clientID ? .mine : .other
        case .idle: .idle
        }
    }

    var label: String {
        switch tone {
        case .agent: "Agent is using the computer"
        case .mine: activeThreadIDs.isEmpty ? "Agent idle — you have control" : "You have control"
        case .other: "Another device has control"
        case .idle: "Agent idle"
        }
    }

    /// The thread a hand-back follow-up goes to: the agent paused behind this control period,
    /// else the thread the view was opened from.
    func handBackThreadID(fallback: String) -> String {
        if case let .agent(threadID) = controller, !threadID.isEmpty { return threadID }
        return activeThreadIDs.first ?? fallback
    }
}

/// Computer surface input, in primary-display desktop points.
enum PathwayComputerSurfaceInput {
    /// Maps a location in an aspect-fitted box to desktop points, excluding letterboxing.
    static func point(_ location: CGPoint, in box: CGSize, screen: CGSize) -> CGPoint? {
        PathwayRemoteBrowserGeometry.point(location, in: box, page: screen)
    }

    static func click(_ point: CGPoint, button: String = "left", clickCount: Int = 1) -> JSONValue {
        var fields: [String: JSONValue] = ["type": .string("pointer.click"), "x": .number(point.x), "y": .number(point.y), "button": .string(button)]
        if clickCount == 2 { fields["clickCount"] = .number(2) }
        return .object(fields)
    }

    static func wheel(_ point: CGPoint, deltaX: Double, deltaY: Double) -> JSONValue {
        let clamp = { (value: Double) in min(max(value, -10_000), 10_000) }
        return .object(["type": .string("wheel"), "x": .number(point.x), "y": .number(point.y),
                        "deltaX": .number(clamp(deltaX)), "deltaY": .number(clamp(deltaY))])
    }

    static func key(_ key: String, modifiers: [String] = []) -> JSONValue {
        var fields: [String: JSONValue] = ["type": .string("key"), "key": .string(key)]
        if !modifiers.isEmpty { fields["modifiers"] = .array(modifiers.map(JSONValue.string)) }
        return .object(fields)
    }

    static let textLimit = 16_384
    static func type(_ text: String) -> JSONValue { .object(["type": .string("type"), "text": .string(String(text.prefix(textLimit)))]) }

    /// The follow-up text a hand-back sends, as `computerHandBackText` in client-runtime builds it.
    static func handBackText(message: String, summary: String) -> String {
        let head = "/computer-use \(message.trimmingCharacters(in: .whitespacesAndNewlines))"
        let summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return summary.isEmpty ? head : "\(head)\n\n\(summary)"
    }
}

/// A hand-back whose follow-up has not reached the agent yet. Its message and command ids are
/// fixed at hand-back, so a retry after a lost response is the same command, never a second run.
struct PathwayComputerHandBackFollowUp: Equatable, Sendable {
    let threadID: String
    let messageID: String
    let commandID: String
    let message: String
    let summary: String
    let attachment: JSONValue

    var command: JSONValue {
        .object([
            "type": .string("message.dispatch"), "commandId": .string(commandID),
            "threadId": .string(threadID), "messageId": .string(messageID),
            "createdBy": .string("user"), "creationSource": .string("mobile"),
            "text": .string(PathwayComputerSurfaceInput.handBackText(message: message, summary: summary)),
            "attachments": .array([attachment]),
            "dispatchMode": .object(["type": .string("queue_after_active")])
        ])
    }
}

/// The view's size and display scale: the encoding budget a stream connection asks for.
struct PathwayComputerSurfaceViewport: Equatable, Sendable {
    /// How long the view must hold a new size before the stream reconnects for it.
    static let settle = Duration.milliseconds(300)

    var size: CGSize
    var scale: Double

    /// Whether a stream sized for `self` should reconnect for `next`: the display scale changed,
    /// or the screen, aspect-fitted into the view, changed width by a fifth. Rotation reconnects;
    /// a keyboard that only trims letterboxing does not.
    func needsReconnect(for next: Self, screen: CGSize?) -> Bool {
        guard next.scale == scale else { return true }
        let aspect = screen.flatMap { $0.height > 0 ? $0.width / $0.height : nil } ?? 1.6
        let fitted = { (size: CGSize) in min(size.width, size.height * aspect) }
        let before = fitted(size), after = fitted(next.size)
        return before <= 0 || abs(after - before) / before >= 0.2
    }
}

/// A thread's unsent computer view text, kept in memory for the life of the app. Every view of
/// the thread edits the same instance, so there is no copy for a closed view to write back.
@MainActor
@Observable
final class PathwayComputerSurfaceDrafts {
    var typing = ""
    var draft = ""
    /// Says typed text came back undelivered. Only sending the field again or dismissing clears
    /// it, so an unrelated input succeeding cannot hide it.
    var restored: String?

    private static var threads: [String: PathwayComputerSurfaceDrafts] = [:]

    static func thread(_ threadID: String) -> PathwayComputerSurfaceDrafts {
        if let drafts = threads[threadID] { return drafts }
        let drafts = PathwayComputerSurfaceDrafts()
        threads[threadID] = drafts
        return drafts
    }
}

/// The persistent computer view's connection. One RPC socket carries the state subscription,
/// control, input and hand-back, because the server ties control to that socket's client id.
@MainActor
@Observable
final class PathwayComputerSurfaceModel {
    typealias Request = @Sendable (_ method: String, _ payload: JSONValue) async throws -> JSONValue
    static let maxQueuedInputs = 32
    /// How long the state subscription may stay down before the view gives up and says so.
    static let reconnectGrace = Duration.seconds(15)

    private(set) var session: PathwayComputerSurfaceSession?
    /// The state subscription failed or could not recover; Reconnect starts it again.
    private(set) var disconnected: String?
    private(set) var busy = false
    var error: String?
    var notice: String?
    /// This thread's unsent text, shared with any other computer view of it.
    let drafts: PathwayComputerSurfaceDrafts
    var typing: String {
        get { drafts.typing }
        set { drafts.typing = newValue }
    }
    var draft: String {
        get { drafts.draft }
        set { drafts.draft = newValue }
    }
    private(set) var pendingFollowUp: PathwayComputerHandBackFollowUp?
    let frames: PathwayComputerSurfaceStream

    @ObservationIgnored let threadID: String
    @ObservationIgnored private let connect: PathwayConnectClient
    @ObservationIgnored private let environment: PathwayCompanyEnvironment
    /// The RPC connection's requests while `watch()` runs.
    @ObservationIgnored var request: Request?
    @ObservationIgnored private var stop: (@Sendable () async -> Void)?
    @ObservationIgnored private var inputs: [JSONValue] = []
    @ObservationIgnored private var draining: Task<Void, Never>?
    @ObservationIgnored private var wheel: (point: CGPoint, deltaX: Double, deltaY: Double)?
    @ObservationIgnored private var wheelFlush: Task<Void, Never>?
    /// Set before this client gives control up itself, so only a loss it did not ask for reads
    /// as one. Input stops here too, so nothing new overtakes a release or hand-back.
    @ObservationIgnored private var leaving = false
    @ObservationIgnored private var escaped = false
    @ObservationIgnored private var lost: Task<Void, Never>?
    @ObservationIgnored private var resize: Task<Void, Never>?
    /// The view's latest viewport, and the one the current stream connected with.
    @ObservationIgnored private let viewport: OSAllocatedUnfairLock<(current: PathwayComputerSurfaceViewport, streamed: PathwayComputerSurfaceViewport?)>

    init(threadID: String, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient) {
        self.threadID = threadID
        drafts = PathwayComputerSurfaceDrafts.thread(threadID)
        self.connect = connect
        self.environment = environment
        let viewport = OSAllocatedUnfairLock(initialState: (
            current: PathwayComputerSurfaceViewport(size: CGSize(width: 1280, height: 800), scale: 2),
            streamed: PathwayComputerSurfaceViewport?.none
        ))
        self.viewport = viewport
        frames = PathwayComputerSurfaceStream { computerID in
            let socketURL = try await connect.prepare(environment: environment).webSocketURL
            let budget = viewport.withLock { state in state.streamed = state.current; return state.current }
            guard let url = pathwayComputerSurfaceSocketURL(rpcSocketURL: socketURL, computerID: computerID,
                                                            viewport: budget.size, deviceScale: budget.scale) else { throw URLError(.badURL) }
            return url
        }
    }

    /// Records the view's size. When it settles far enough from what the stream asked for, as
    /// after rotation, the stream reconnects so the host encodes for the new shape.
    func setViewport(_ size: CGSize, scale: Double) {
        guard size.width > 0, size.height > 0 else { return }
        let next = PathwayComputerSurfaceViewport(size: size, scale: scale)
        let streamed = viewport.withLock { state in state.current = next; return state.streamed }
        resize?.cancel(); resize = nil
        guard frames.computerID != nil, let streamed, streamed.needsReconnect(for: next, screen: frames.screenSize) else { return }
        resize = Task { [weak self] in
            try? await Task.sleep(for: PathwayComputerSurfaceViewport.settle)
            guard !Task.isCancelled, let self else { return }
            resize = nil
            if frames.computerID != nil { frames.reconnect() }
        }
    }

    /// Runs until cancelled, which is when the view leaves the screen or the app backgrounds:
    /// then it releases control it holds and closes both sockets.
    func watch() async {
        let connect = connect, environment = environment
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        request = { method, payload in try await rpc.request(method, payload: payload) }
        stop = { await rpc.stop() }
        disconnected = nil
        defer {
            let releases = session?.mine == true
            leaving = true
            request = nil
            stop = nil
            lost?.cancel(); lost = nil
            resize?.cancel(); resize = nil
            clearInput()
            frames.stream(nil)
            session = nil
            Task {
                if releases { _ = try? await rpc.request("computer.surface.releaseControl", payload: .object([:]), timeout: .seconds(3)) }
                await rpc.stop()
            }
        }
        do {
            for try await value in await rpc.subscribe("computer.surface.subscribe", payload: .object([:]), bufferingPolicy: .bufferingNewest(1)) {
                receive(value)
            }
        } catch is CancellationError {} catch {
            if !Task.isCancelled { disconnected = error.localizedDescription }
        }
        if !Task.isCancelled, disconnected == nil { disconnected = "The computer view disconnected." }
    }

    /// Applies one subscription value. A transport marker means the socket dropped. The next
    /// socket gets a new client id, so control and queued input are gone, and nothing is sent
    /// until a fresh snapshot says who holds the screen.
    func receive(_ value: JSONValue) {
        if value.objectValue?["_pathwayTransport"] != nil { lose(); return }
        guard let next = PathwayComputerSurfaceSession(value) else { return }
        lost?.cancel(); lost = nil
        apply(next)
    }

    private func lose() {
        if session?.mine == true, !leaving { notice = "The connection dropped, so you no longer have control." }
        session = nil
        leaving = false
        escaped = false
        clearInput()
        frames.stream(nil)
        guard lost == nil else { return }
        lost = Task { [weak self] in
            try? await Task.sleep(for: PathwayComputerSurfaceModel.reconnectGrace)
            guard !Task.isCancelled, let self else { return }
            lost = nil
            disconnected = "Pathway could not reach the computer."
            await stop?()
        }
    }

    private func apply(_ next: PathwayComputerSurfaceSession) {
        let wasMine = session?.mine == true
        if wasMine, !next.mine, !leaving {
            notice = escaped ? "Escape stopped your control. Take control again to continue." : "You no longer have control."
        }
        if !next.mine { leaving = false; clearInput() }
        escaped = false
        if next != session { session = next }
        frames.stream(next.capture ? next.computerID : nil)
    }

    func takeControl() async {
        notice = nil
        await run("Could not take control.") { request in _ = try await request("computer.surface.takeControl", .object([:])) }
    }

    func release() async {
        leaving = true
        await run("Could not release control.") { request in _ = try await request("computer.surface.releaseControl", .object([:])) }
        if error != nil { leaving = false }
    }

    /// An empty message only releases. Otherwise input stops, what is already queued lands, then
    /// the server captures the screen and releases, and the message goes to the agent after its
    /// current reply.
    func handBack(_ message: String) async -> Bool {
        let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { await release(); return error == nil }
        guard let session else { return false }
        let threadID = session.handBackThreadID(fallback: threadID)
        let messageID = UUID().uuidString, commandID = UUID().uuidString
        leaving = true
        flushWheel()
        await draining?.value
        var followUp: PathwayComputerHandBackFollowUp?
        await run("Could not hand back to the agent.") { request in
            let result = try await request("computer.surface.handBack", .object(["threadId": .string(threadID), "messageId": .string(messageID)]))
            guard let fields = result.objectValue, let attachment = fields["attachment"] else { throw URLError(.cannotParseResponse) }
            followUp = PathwayComputerHandBackFollowUp(threadID: threadID, messageID: messageID, commandID: commandID, message: message,
                                                        summary: fields["summary"]?.stringValue ?? "", attachment: attachment)
        }
        // Control is kept on failure, so the user can retry or just release.
        guard let followUp else { leaving = false; return false }
        await dispatch(followUp)
        return true
    }

    /// Sends the same follow-up command again without handing back again: the capture is stored.
    func retryFollowUp() async {
        guard let pendingFollowUp else { return }
        await dispatch(pendingFollowUp)
    }

    func discardFollowUp() { pendingFollowUp = nil }

    private func dispatch(_ followUp: PathwayComputerHandBackFollowUp) async {
        pendingFollowUp = followUp
        await run("Could not send your message to the agent.") { request in
            _ = try await request("orchestration.dispatchCommand", followUp.command)
        }
        if error == nil { pendingFollowUp = nil }
    }

    /// Mutations wait for a snapshot from the current socket, so none lands on a lost control.
    private func run(_ fallback: String, _ action: (Request) async throws -> Void) async {
        guard let request, session != nil else { error = "The computer view is not connected."; return }
        busy = true
        defer { busy = false }
        do { try await action(request); error = nil } catch { self.error = Self.message(error, fallback) }
    }

    // MARK: Input

    private var accepts: Bool { session?.mine == true && session?.input == true && !leaving }

    /// Queues one input while this connection has control. Inputs go out one at a time, in order.
    @discardableResult
    func send(_ event: JSONValue) -> Bool {
        guard accepts else { return false }
        flushWheel()
        return enqueue(event)
    }

    /// Types the host field's text. The field clears only once the text is queued; text the
    /// queue refuses stays, and text it later drops comes back with `drafts.restored` set.
    func sendTyping() {
        let text = String(typing.prefix(PathwayComputerSurfaceInput.textLimit))
        guard !text.isEmpty else { return }
        guard accepts else { error = "You don't have control, so your text wasn't typed."; return }
        guard send(PathwayComputerSurfaceInput.type(text)) else {
            error = "The computer is busy, so your text wasn't typed. Try again in a moment."
            return
        }
        typing.removeFirst(text.count)
        drafts.restored = nil
    }

    func sendKey(_ key: String, modifiers: [String] = []) {
        if key == "Escape", modifiers.isEmpty { escape(); return }
        send(PathwayComputerSurfaceInput.key(key, modifiers: modifiers))
    }

    /// Escape skips the queue: queued input is dropped and the press goes out now on the same
    /// connection, so a stalled input or a full queue cannot hold up the host's emergency stop.
    private func escape() {
        guard session?.mine == true, session?.input == true, let request else { return }
        escaped = true
        clearInput()
        Task { [weak self] in
            do {
                _ = try await request("computer.surface.input", .object(["event": PathwayComputerSurfaceInput.key("Escape")]))
            } catch {
                self?.error = PathwayComputerSurfaceModel.message(error, "The computer did not respond.")
            }
        }
    }

    /// Accumulates scroll at `point`; it goes out at most once per display frame.
    func scroll(at point: CGPoint, deltaX: Double, deltaY: Double) {
        guard accepts else { return }
        wheel = (point, (wheel?.deltaX ?? 0) + deltaX, (wheel?.deltaY ?? 0) + deltaY)
        guard wheelFlush == nil else { return }
        wheelFlush = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled else { return }
            self?.wheelFlush = nil
            self?.flushWheel()
        }
    }

    private func flushWheel() {
        wheelFlush?.cancel(); wheelFlush = nil
        guard let wheel else { return }
        self.wheel = nil
        enqueue(PathwayComputerSurfaceInput.wheel(wheel.point, deltaX: wheel.deltaX, deltaY: wheel.deltaY))
    }

    @discardableResult
    private func enqueue(_ event: JSONValue) -> Bool {
        guard inputs.count < Self.maxQueuedInputs else { error = "The computer is busy. Try again in a moment."; return false }
        inputs.append(event)
        if draining == nil { draining = Task { [weak self] in await self?.drain() } }
        return true
    }

    private func drain() async {
        defer { draining = nil }
        while !inputs.isEmpty, let request {
            let event = inputs.removeFirst()
            do {
                _ = try await request("computer.surface.input", .object(["event": event]))
                error = nil
            } catch {
                self.error = Self.message(error, "The computer did not respond.")
                restoreTyping([event] + inputs)
                inputs.removeAll()
            }
        }
    }

    private func clearInput() {
        restoreTyping(inputs)
        inputs.removeAll()
        wheelFlush?.cancel(); wheelFlush = nil
        wheel = nil
    }

    /// Puts text from undelivered `type` inputs back in front of the host field. It merges into
    /// the thread's current drafts, so a late failure from a closed view never replaces newer text.
    private func restoreTyping(_ events: [JSONValue]) {
        let text = events.compactMap { event -> String? in
            guard let fields = event.objectValue, fields["type"] == .string("type") else { return nil }
            return fields["text"]?.stringValue
        }.joined()
        guard !text.isEmpty else { return }
        typing = text + typing
        drafts.restored = "Some of your text wasn't typed on the computer. It's back in the text field."
    }

    private static func message(_ error: Error, _ fallback: String) -> String {
        let text = error.localizedDescription
        return text.isEmpty ? fallback : text
    }
}
