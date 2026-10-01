import CoreGraphics
import Foundation
import ImageIO

/// One frame from `/ws/environment-surface`: 24 little-endian header bytes, then one JPEG
/// (`@spiritdevs/shared/environmentSurface`, version 1; change them together).
struct PathwaySurfaceFrameHeader: Equatable, Sendable {
    enum DecodeError: Error, Equatable { case invalidLength, unsupported, invalidHeader }

    static let magic: UInt16 = 0x5350
    static let headerBytes = 24
    static let maxFrameBytes = 8 * 1024 * 1024

    let sequence: UInt32
    /// JPEG pixels.
    let width: Int
    let height: Int
    /// Pixels per page CSS pixel.
    let deviceScale: Double
    let timestampMs: Double

    /// The page's CSS size, the coordinate space input is sent in.
    var pageSize: CGSize { CGSize(width: Double(width) / deviceScale, height: Double(height) / deviceScale) }

    init(data: Data) throws(DecodeError) {
        guard data.count > Self.headerBytes, data.count <= Self.maxFrameBytes else { throw .invalidLength }
        let header = [UInt8](data.prefix(Self.headerBytes))
        func integer<T: FixedWidthInteger>(_ offset: Int, _: T.Type) -> T {
            (0..<MemoryLayout<T>.size).reduce(T.zero) { $0 | T(header[offset + $1]) << ($1 * 8) }
        }
        guard integer(0, UInt16.self) == Self.magic, header[2] == 1, header[3] == 1 else { throw .unsupported }
        sequence = integer(4, UInt32.self)
        width = Int(integer(8, UInt16.self))
        height = Int(integer(10, UInt16.self))
        deviceScale = Double(Float(bitPattern: integer(12, UInt32.self)))
        timestampMs = Double(bitPattern: integer(16, UInt64.self))
        guard width > 0, height > 0, deviceScale.isFinite, deviceScale > 0, timestampMs.isFinite else { throw .invalidHeader }
    }
}

/// The page size this client asks for: the view's points at the screen scale. The environment
/// caps the scale at 2, so asking for more only costs bandwidth. The largest viewer wins.
struct PathwaySurfaceViewport: Equatable, Sendable {
    let width: Int
    let height: Int
    let deviceScale: Double

    init?(size: CGSize, displayScale: CGFloat) {
        width = min(4_096, Int(size.width.rounded()))
        height = min(4_096, Int(size.height.rounded()))
        guard width >= 1, height >= 1 else { return nil }
        deviceScale = (min(2, max(1, displayScale.isFinite ? Double(displayScale) : 1)) * 100).rounded() / 100
    }
}

/// Whether a viewer's viewport sizes the page (`active`) or it only watches (`passive`), like
/// a small preview that must not shrink the page the agent is using.
enum PathwaySurfaceSizing: String, Sendable { case active, passive }

/// `failed` keeps retrying in the background; `stopped` was refused and waits for Reconnect.
enum PathwaySurfaceState: Equatable, Sendable {
    case connecting, live, stale, failed, stopped

    /// No frames are coming, so the viewer should offer Reconnect.
    var isDown: Bool { self == .failed || self == .stopped }
}

struct PathwaySurfaceQuality: Equatable, Sendable {
    let fps: Int
    let latencyMs: Double
}

/// The corner label, worded like web's `surfaceIndicator`. Latency includes clock skew between
/// machines, so it is rounded and only flagged once clearly noticeable.
struct PathwaySurfaceIndicator: Equatable {
    enum Tone: Equatable { case live, degraded, offline }
    let tone: Tone
    let label: String

    init(state: PathwaySurfaceState, quality: PathwaySurfaceQuality?) {
        switch state {
        case .failed: (tone, label) = (.offline, "Offline · retrying")
        case .stopped: (tone, label) = (.offline, "Disconnected")
        case .stale: (tone, label) = (.degraded, "Reconnecting…")
        case .connecting: (tone, label) = (.degraded, "Connecting…")
        case .live:
            guard let quality else { (tone, label) = (.degraded, "Connecting…"); return }
            // A still page sends no frames, and its last latency is history.
            guard quality.fps > 0 else { (tone, label) = (.live, "Live"); return }
            let latency = Int((quality.latencyMs / 10).rounded()) * 10
            tone = quality.latencyMs >= 400 ? .degraded : .live
            label = latency > 0 ? "\(quality.fps) fps · \(latency) ms" : "\(quality.fps) fps"
        }
    }
}

/// When to reopen the surface socket, mirroring `createEnvironmentSurfaceStream`: exponential
/// backoff with jitter up to 30s, shown as failed after 8 failures in a row but still retrying.
/// A refusal no retry can change (bad target, missing scope, a policy close) waits for Reconnect.
/// A refused ticket (401) mints a fresh URL; otherwise the ticket URL is reused.
struct PathwaySurfaceReconnect: Equatable {
    enum Close: Equatable { case refusedTicket, refused, dropped }
    enum Decision: Equatable {
        case retry(after: Duration, state: PathwaySurfaceState, remint: Bool)
        case stop
    }
    private(set) var failures = 0

    static func close(status: Int?, closeCode: Int) -> Close {
        switch status {
        case 401: .refusedTicket
        case 400, 403, 404: .refused
        default: closeCode == URLSessionWebSocketTask.CloseCode.policyViolation.rawValue ? .refused : .dropped
        }
    }

    /// A frame decoded: the stream works again.
    mutating func usableFrame() { failures = 0 }

    /// `jitter` is in 0.8...1.2.
    mutating func closed(_ close: Close, jitter: Double = 1) -> Decision {
        guard close != .refused else { return .stop }
        failures += 1
        let base = min(30_000, 500 * (1 << min(failures - 1, 6)))
        return .retry(after: .milliseconds(Int(Double(base) * jitter)), state: failures >= 8 ? .failed : .stale,
                      remint: close == .refusedTicket)
    }
}

/// The newest undecoded frame and which socket's decoder, if any, owns it. Each socket
/// (generation) gets a fresh queue; a decoder only ever takes and releases its own slot, so one
/// unwinding from an earlier socket can neither steal frames nor block the next decoder.
struct PathwaySurfaceDecodeQueue: Equatable {
    private(set) var pending: Data?
    private(set) var decoder: Int?

    /// A new socket: the old socket's frame and decoder no longer count.
    mutating func install() { pending = nil; decoder = nil }

    /// Keeps only the newest frame. True when `generation` must start a decoder for it.
    mutating func enqueue(_ frame: Data, generation: Int) -> Bool {
        pending = frame
        guard decoder == nil else { return false }
        decoder = generation
        return true
    }

    /// The frame for the decoder of `generation` to decode next, if it still owns the slot.
    mutating func next(generation: Int) -> Data? {
        guard decoder == generation, let frame = pending else { return nil }
        pending = nil
        return frame
    }

    /// The decoder of `generation` stopped; frees the slot only if it is still that decoder's.
    mutating func finished(generation: Int) {
        if decoder == generation { decoder = nil }
    }
}

/// The surface route beside the RPC socket, keeping its ticket: tickets last minutes and are not
/// consumed, so the prepared `/ws?wsTicket=` URL authorizes the surface socket too.
/// Mirrors `resolveSurfaceSocketUrl` in `packages/client-runtime/src/surface/socketUrl.ts`.
func pathwaySurfaceSocketURL(rpcSocketURL: URL, threadID: String, tabID: String, viewport: PathwaySurfaceViewport,
                             sizing: PathwaySurfaceSizing) -> URL? {
    guard var components = URLComponents(url: rpcSocketURL, resolvingAgainstBaseURL: false) else { return nil }
    var path = components.path
    while path.hasSuffix("/") { path.removeLast() }
    if path.hasSuffix("/ws") { path.removeLast(3) }
    components.path = path + "/ws/environment-surface"
    components.fragment = nil
    var query = (components.queryItems ?? []).filter { $0.name == "wsTicket" }
    query += [
        URLQueryItem(name: "kind", value: "browser"),
        URLQueryItem(name: "threadId", value: threadID),
        URLQueryItem(name: "tabId", value: tabID),
        URLQueryItem(name: "width", value: String(viewport.width)),
        URLQueryItem(name: "height", value: String(viewport.height)),
        URLQueryItem(name: "deviceScale", value: String(viewport.deviceScale)),
        URLQueryItem(name: "sizing", value: sizing.rawValue)
    ]
    components.queryItems = query
    return components.url
}

/// Streams one environment browser tab while a view shows it. Frames decode off the main actor,
/// one at a time, keeping only the newest that arrived meanwhile, and go straight to `onFrame`
/// without an observable change; only the state and a once-a-second quality sample re-render.
/// The caller runs `run(threadID:tabID:)` in a task and cancels it to pause.
@MainActor
@Observable
final class PathwayEnvironmentSurfaceStream {
    typealias ResolveRPCSocketURL = @Sendable () async throws -> URL
    /// Viewport changes reconnect the socket, so wait for rotation or resizing to settle.
    static let viewportSettle: Duration = .milliseconds(250)
    /// Without any message (frames or the server's 15s ping) for this long, the socket is dead.
    static let silenceLimit: Duration = .seconds(35)

    private(set) var state: PathwaySurfaceState = .connecting
    private(set) var quality: PathwaySurfaceQuality?
    private(set) var hasFrame = false
    /// Bumped by `reconnect()`; views key their `run` task on it.
    private(set) var reconnects = 0

    /// Receives each decoded frame on the main actor, or nil when the tab changes. Set by the
    /// view that draws it.
    @ObservationIgnored var onFrame: ((CGImage?) -> Void)? {
        didSet { onFrame?(latestImage) }
    }
    @ObservationIgnored private(set) var latestImage: CGImage?
    /// The CSS size of the page in the latest frame, for mapping input.
    @ObservationIgnored private(set) var pageSize: CGSize?

    @ObservationIgnored private let session: URLSession
    @ObservationIgnored let sizing: PathwaySurfaceSizing
    @ObservationIgnored private let resolveRPCSocketURL: ResolveRPCSocketURL
    @ObservationIgnored private var viewport: PathwaySurfaceViewport?
    @ObservationIgnored private var viewportTask: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    /// Set when the socket was closed on purpose to apply a new viewport.
    @ObservationIgnored private var reopening = false
    /// Advances on every socket, so a late decode from an earlier one never lands.
    @ObservationIgnored private var generation = 0
    /// The newest `run`; an older one still unwinding (say, from a slow ticket) touches nothing.
    @ObservationIgnored private var activeRun = 0
    @ObservationIgnored private var frameQueue = PathwaySurfaceDecodeQueue()
    @ObservationIgnored private var decoding: Task<Void, Never>?
    @ObservationIgnored private var frames = 0
    @ObservationIgnored private var latencyMs = 0.0
    @ObservationIgnored private var lastMessage = ContinuousClock.now
    @ObservationIgnored private var tabID: String?

    init(sizing: PathwaySurfaceSizing = .active, session: URLSession = .shared, resolveRPCSocketURL: @escaping ResolveRPCSocketURL) {
        self.sizing = sizing
        self.session = session
        self.resolveRPCSocketURL = resolveRPCSocketURL
    }

    isolated deinit {
        viewportTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    /// The first viewport applies at once; later ones reconnect once they settle.
    func setViewport(_ next: PathwaySurfaceViewport?) {
        guard let next, next != viewport else { return }
        viewportTask?.cancel()
        guard viewport != nil else { viewport = next; return }
        viewportTask = Task { [weak self] in
            try? await Task.sleep(for: Self.viewportSettle)
            guard let self, !Task.isCancelled, next != self.viewport else { return }
            self.viewport = next
            guard let socket = self.socket else { return }
            self.reopening = true
            socket.cancel(with: .goingAway, reason: nil)
        }
    }

    /// Asks the view to start a fresh `run`, after a refusal or when the user retries.
    /// Clears a failure first, so a view that only mounts the stream while it is not down
    /// mounts it again.
    func reconnect() {
        if state.isDown { state = .connecting }
        reconnects += 1
    }

    /// Streams until cancelled, reconnecting with backoff. Returns early after a refusal no
    /// retry can change; run it again (a new task) to reconnect.
    func run(threadID: String, tabID: String) async {
        activeRun += 1
        let run = activeRun
        var isCurrent: Bool { run == activeRun && !Task.isCancelled }
        var reconnect = PathwaySurfaceReconnect()
        var rpcURL: URL?
        if self.tabID != tabID {
            // Another tab's page must not show, or take taps, while this one connects.
            self.tabID = tabID
            latestImage = nil
            pageSize = nil
            hasFrame = false
            onFrame?(nil)
        }
        quality = nil
        state = .connecting
        // Ending the current run strands its late decodes; a superseded run must leave the
        // generation alone, or it would end its successor's socket.
        defer { if run == activeRun { generation += 1 } }
        while isCurrent {
            guard let viewport else {
                // Nothing to ask for until the view has a size.
                try? await Task.sleep(for: .milliseconds(50))
                continue
            }
            var close = PathwaySurfaceReconnect.Close.dropped
            do {
                let base: URL
                if let rpcURL { base = rpcURL } else { base = try await resolveRPCSocketURL(); rpcURL = base }
                guard isCurrent else { return }
                guard let url = pathwaySurfaceSocketURL(rpcSocketURL: base, threadID: threadID, tabID: tabID, viewport: viewport, sizing: sizing) else { throw URLError(.badURL) }
                close = await connect(to: url, reconnect: &reconnect)
            } catch is CancellationError { return } catch {}
            guard isCurrent else { return }
            if reopening { reopening = false; continue }
            switch reconnect.closed(close, jitter: Double.random(in: 0.8...1.2)) {
            case .stop:
                state = .stopped
                return
            case let .retry(delay, next, remint):
                state = next
                if remint { rpcURL = nil }
                do { try await Task.sleep(for: delay) } catch { return }
                guard isCurrent else { return }
            }
        }
    }

    /// Runs one socket until it ends, and says how it ended.
    private func connect(to url: URL, reconnect: inout PathwaySurfaceReconnect) async -> PathwaySurfaceReconnect.Close {
        generation += 1
        let generation = generation
        // Whatever an earlier socket left decoding or queued is stale now.
        decoding?.cancel(); decoding = nil
        frameQueue.install()
        let socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = PathwaySurfaceFrameHeader.maxFrameBytes
        self.socket = socket
        socket.resume()
        socket.send(.string("ready")) { _ in }
        lastMessage = .now
        frames = 0
        let monitor = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                if self.state == .live { self.quality = PathwaySurfaceQuality(fps: self.frames, latencyMs: self.latencyMs) }
                self.frames = 0
                if ContinuousClock.now - self.lastMessage > Self.silenceLimit { socket.cancel(with: .goingAway, reason: nil); return }
            }
        }
        defer {
            monitor.cancel()
            if generation == self.generation { decoding?.cancel(); decoding = nil; frameQueue.install() }
            socket.cancel(with: .goingAway, reason: nil)
            if self.socket === socket { self.socket = nil }
        }
        try? await withTaskCancellationHandler {
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard generation == self.generation else { return }
                lastMessage = .now
                switch message {
                case let .string(text):
                    if text == "ping" { socket.send(.string("pong")) { _ in } }
                case let .data(data):
                    if frameQueue.enqueue(data, generation: generation) {
                        decoding = Task { [weak self] in await self?.decodePending(generation: generation) }
                    }
                @unknown default: continue
                }
            }
        } onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
        }
        if state == .live { reconnect.usableFrame() }
        return PathwaySurfaceReconnect.close(status: (socket.response as? HTTPURLResponse)?.statusCode, closeCode: socket.closeCode.rawValue)
    }

    /// Decodes the newest pending frame until none is left; frames that arrive meanwhile replace it.
    private func decodePending(generation: Int) async {
        defer { frameQueue.finished(generation: generation) }
        while !Task.isCancelled, generation == self.generation, let bytes = frameQueue.next(generation: generation) {
            let decoded = await Task.detached(priority: .userInitiated) { Self.decode(bytes) }.value
            guard generation == self.generation, !Task.isCancelled else { return }
            if let decoded { deliver(decoded) } else if state == .live { state = .stale }
        }
    }

    private func deliver(_ frame: (header: PathwaySurfaceFrameHeader, image: CGImage)) {
        latestImage = frame.image
        pageSize = frame.header.pageSize
        frames += 1
        latencyMs = max(0, Date().timeIntervalSince1970 * 1_000 - frame.header.timestampMs)
        if state != .live { state = .live }
        if !hasFrame { hasFrame = true }
        onFrame?(frame.image)
    }

    /// Parses and decodes one frame, fully, so drawing it never decodes on the main thread.
    nonisolated static func decode(_ data: Data) -> (header: PathwaySurfaceFrameHeader, image: CGImage)? {
        guard let header = try? PathwaySurfaceFrameHeader(data: data),
              let source = CGImageSourceCreateWithData(data.dropFirst(PathwaySurfaceFrameHeader.headerBytes) as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return nil }
        return (header, image)
    }
}
