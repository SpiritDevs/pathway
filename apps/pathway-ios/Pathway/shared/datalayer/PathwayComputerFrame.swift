import Foundation
import ImageIO

/// One still from `/ws/computer-frames`: a 17-byte little-endian header, the
/// UTF-8 computer id, then a PNG payload (`@spiritdevs/shared/computerFrame`).
struct PathwayComputerFrame: Equatable, Sendable {
    enum DecodeError: Error, Equatable { case tooShort, badMagic, unsupportedVersion, truncatedComputerID, invalidComputerID }

    static let magic: UInt16 = 0x5343
    static let version: UInt8 = 1
    static let headerBytes = 17

    let keyframe: Bool
    let codecConfig: Bool
    let sequence: UInt32
    let timestampMs: Double
    let computerID: String
    let payload: Data

    init(data: Data) throws(DecodeError) {
        let bytes = [UInt8](data)
        guard bytes.count >= Self.headerBytes else { throw .tooShort }
        func integer<T: FixedWidthInteger>(_ offset: Int, _: T.Type) -> T {
            (0..<MemoryLayout<T>.size).reduce(T.zero) { $0 | T(bytes[offset + $1]) << ($1 * 8) }
        }
        guard integer(0, UInt16.self) == Self.magic else { throw .badMagic }
        guard bytes[2] == Self.version else { throw .unsupportedVersion }
        let idLength = Int(bytes[16])
        let payloadOffset = Self.headerBytes + idLength
        guard idLength > 0, bytes.count >= payloadOffset else { throw .truncatedComputerID }
        guard let computerID = String(bytes: bytes[Self.headerBytes..<payloadOffset], encoding: .utf8) else { throw .invalidComputerID }
        keyframe = bytes[3] & 1 != 0
        codecConfig = bytes[3] & 2 != 0
        sequence = integer(4, UInt32.self)
        timestampMs = Double(bitPattern: integer(8, UInt64.self))
        self.computerID = computerID
        payload = data.subdata(in: data.startIndex + payloadOffset..<data.endIndex)
    }
}

/// Drops frames for another computer and stale or repeated sequences; asks for a
/// keyframe when frames were skipped. Sequences wrap at 2^32.
struct PathwayComputerFrameGate: Equatable {
    enum Action: Equatable { case decode, ignore, dropStale }
    private(set) var lastSequence: UInt32?

    mutating func step(sequence: UInt32, computerID: String, expected: String) -> (action: Action, resync: Bool) {
        guard computerID == expected else { return (.ignore, false) }
        guard let last = lastSequence else { lastSequence = sequence; return (.decode, false) }
        let distance = sequence &- last
        if distance == 0 || distance >= 0x8000_0000 { return (.dropStale, false) }
        lastSequence = sequence
        return (.decode, distance > 1)
    }
}

/// When to reopen the frame socket. The ticket URL is reused until the upgrade itself
/// says it was refused (401). A refusal a retry cannot change (a missing scope, no such
/// route or computer, a policy close) ends the stream at once. Anything else retries
/// with backoff: five retries in a row without a usable frame, and the sixth failure gives up.
struct PathwayComputerFrameReconnect: Equatable {
    enum Close: Equatable { case refusedTicket, refused, dropped }
    enum Decision: Equatable { case retry(after: Duration, remint: Bool), giveUp }
    static let maxRetries = 5
    private(set) var failures = 0

    /// Reads the upgrade's HTTP status (when it was refused) and the close code.
    static func close(status: Int?, closeCode: Int) -> Close {
        switch status {
        case 401: .refusedTicket
        case 400, 403, 404: .refused
        default: closeCode == URLSessionWebSocketTask.CloseCode.policyViolation.rawValue ? .refused : .dropped
        }
    }

    /// A frame for this computer decoded into an image: the stream works again.
    mutating func usableFrame() { failures = 0 }

    mutating func closed(_ close: Close) -> Decision {
        guard close != .refused else { return .giveUp }
        failures += 1
        guard failures <= Self.maxRetries else { return .giveUp }
        return .retry(after: .milliseconds(min(500 * (1 << (failures - 1)), 5_000)), remint: close == .refusedTicket)
    }
}

/// The frame route beside the RPC socket, keeping its ticket: tickets last minutes and
/// are not consumed, so the prepared `/ws?wsTicket=` URL authorizes the frame socket too.
func pathwayComputerFrameSocketURL(rpcSocketURL: URL, computerID: String) -> URL? {
    guard var components = URLComponents(url: rpcSocketURL, resolvingAgainstBaseURL: false) else { return nil }
    var path = components.path
    while path.hasSuffix("/") { path.removeLast() }
    if path.hasSuffix("/ws") { path.removeLast(3) }
    components.path = path + "/ws/computer-frames"
    components.fragment = nil
    var query = (components.queryItems ?? []).filter { $0.name == "wsTicket" }
    query.append(URLQueryItem(name: "computerId", value: computerID))
    components.queryItems = query
    return components.url
}

/// Streams stills for one computer while something shows them. Decodes off the main
/// actor, at most one frame at a time, keeping only the newest frame that arrived meanwhile.
@MainActor
@Observable
final class PathwayComputerFrameStream {
    typealias ResolveURL = @Sendable (_ computerID: String) async throws -> URL
    typealias Sleep = @Sendable (Duration) async throws -> Void
    typealias Decode = @Sendable (Data) async -> CGImage?
    static let unavailableMessage = "Live view unavailable"
    static let unreadableMessage = "The computer stream sent a frame Pathway could not read."
    nonisolated static let maxPixelSize = 1_600
    /// The largest still the socket buffers. The host sends each PNG whole with no cap of its own,
    /// and a detailed 1080p still already passes Foundation's 1 MiB default. Anything larger
    /// closes the socket like a dropped connection, never as a refused ticket.
    static let maxMessageBytes = 16 * 1024 * 1024

    private(set) var image: CGImage?
    private(set) var errorMessage: String?
    private(set) var isConnecting = false

    @ObservationIgnored private let resolveURL: ResolveURL
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let sleep: Sleep
    @ObservationIgnored private let decodeFrame: Decode
    @ObservationIgnored private(set) var reconnect = PathwayComputerFrameReconnect()
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Advances on every stop or switch. A receive or decode from an earlier lifetime never
    /// publishes, even into a quick reopen of the same computer.
    @ObservationIgnored private var lifetime = 0
    /// The current socket's decode loop. It outlives a cancelled `task`, so stopping cancels it too.
    @ObservationIgnored private(set) var decoding: Task<Void, Never>?
    /// The open socket. A quiet `receive()` ignores task cancellation, so stopping closes this.
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private(set) var computerID: String?

    init(session: URLSession = .shared, sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
         decode: @escaping Decode = { PathwayComputerFrameStream.decode($0) }, resolveURL: @escaping ResolveURL) {
        self.session = session
        self.sleep = sleep
        self.decodeFrame = decode
        self.resolveURL = resolveURL
    }

    isolated deinit {
        task?.cancel()
        decoding?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    /// Starts streaming `computerID`, or stops when nil. Asking for the same computer again is a
    /// no-op, even after the stream gave up: only a stop or another computer starts over.
    /// The last image stays either way, so a paused card keeps showing it.
    func stream(_ computerID: String?) {
        guard computerID != self.computerID else { return }
        lifetime += 1
        task?.cancel(); task = nil
        decoding?.cancel(); decoding = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        self.computerID = computerID
        reconnect = PathwayComputerFrameReconnect()
        errorMessage = nil
        isConnecting = false
        guard let computerID else { return }
        task = Task { [weak self, lifetime] in await self?.run(computerID, lifetime: lifetime) }
    }

    private func run(_ computerID: String, lifetime: Int) async {
        var url: URL?
        while !Task.isCancelled {
            isConnecting = image == nil
            var close = PathwayComputerFrameReconnect.Close.dropped
            do {
                let target: URL
                if let url { target = url } else { target = try await resolveURL(computerID); url = target }
                try Task.checkCancellation()
                close = await connect(to: target, computerID: computerID, lifetime: lifetime)
            } catch is CancellationError { return } catch {}
            guard !Task.isCancelled else { return }
            switch reconnect.closed(close) {
            case .giveUp:
                isConnecting = false
                errorMessage = Self.unavailableMessage
                task = nil
                return
            case let .retry(delay, remint):
                if remint { url = nil }
                do { try await sleep(delay) } catch { return }
            }
        }
    }

    /// Runs one socket until it ends, and says how it ended.
    private func connect(to url: URL, computerID: String, lifetime: Int) async -> PathwayComputerFrameReconnect.Close {
        let socket = session.webSocketTask(with: url)
        socket.maximumMessageSize = Self.maxMessageBytes
        self.socket = socket
        socket.resume()
        defer {
            socket.cancel(with: .goingAway, reason: nil)
            if self.socket === socket { self.socket = nil }
        }
        try? await receive(from: socket, computerID: computerID, lifetime: lifetime)
        return PathwayComputerFrameReconnect.close(status: (socket.response as? HTTPURLResponse)?.statusCode, closeCode: socket.closeCode.rawValue)
    }

    private func receive(from socket: URLSessionWebSocketTask, computerID: String, lifetime: Int) async throws {
        var gate = PathwayComputerFrameGate()
        var lastResync = ContinuousClock.now - .seconds(1)
        var pending: Data?
        func resync() {
            guard ContinuousClock.now - lastResync >= .seconds(1) else { return }
            lastResync = .now
            socket.send(.string(#"{"type":"computer.frame.resync"}"#)) { _ in }
        }
        defer { if lifetime == self.lifetime { decoding?.cancel(); decoding = nil } }
        while !Task.isCancelled {
            guard case let .data(data) = try await socket.receive() else { continue }
            guard lifetime == self.lifetime else { return }
            let frame: PathwayComputerFrame
            do { frame = try PathwayComputerFrame(data: data) } catch {
                errorMessage = Self.unreadableMessage
                resync()
                continue
            }
            let step = gate.step(sequence: frame.sequence, computerID: frame.computerID, expected: computerID)
            if step.resync { resync() }
            guard step.action == .decode else { continue }
            if decoding != nil { pending = frame.payload; continue }
            var next: Data? = frame.payload
            let decodeFrame = decodeFrame
            decoding = Task { [weak self] in
                while let payload = next {
                    let decoded = await Task.detached(priority: .userInitiated) { await decodeFrame(payload) }.value
                    guard let self, !Task.isCancelled, self.lifetime == lifetime else { return }
                    if let decoded {
                        self.image = decoded; self.errorMessage = nil; self.isConnecting = false
                        self.reconnect.usableFrame()
                    }
                    else { self.errorMessage = Self.unreadableMessage; resync() }
                    next = pending; pending = nil
                }
                self?.decoding = nil
            }
        }
    }

    /// Decodes a PNG still, downsampled so a large display never costs a full-size bitmap.
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
