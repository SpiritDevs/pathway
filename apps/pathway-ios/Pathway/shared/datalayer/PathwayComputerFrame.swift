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

/// When to reopen the frame socket. Five consecutive closes without a frame end
/// the stream: a refused upgrade, a missing route and a gone computer all look
/// alike from here. A close before any frame also re-mints the ticket.
struct PathwayComputerFrameReconnect: Equatable {
    enum Decision: Equatable { case retry(after: Duration, remint: Bool), giveUp }
    static let maxAttempts = 5
    private(set) var attempts = 0

    mutating func frameReceived() { attempts = 0 }

    mutating func closed(deliveredFrame: Bool) -> Decision {
        attempts += 1
        guard attempts <= Self.maxAttempts else { return .giveUp }
        let delay = min(500 * (1 << (attempts - 1)), 5_000)
        return .retry(after: .milliseconds(delay), remint: !deliveredFrame)
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
    static let unavailableMessage = "Live view unavailable"
    static let unreadableMessage = "The computer stream sent a frame Pathway could not read."
    nonisolated static let maxPixelSize = 1_600

    private(set) var image: CGImage?
    private(set) var errorMessage: String?
    private(set) var isConnecting = false

    @ObservationIgnored private let resolveURL: ResolveURL
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private(set) var computerID: String?

    init(session: URLSession = .shared, resolveURL: @escaping ResolveURL) {
        self.session = session
        self.resolveURL = resolveURL
    }

    isolated deinit { task?.cancel() }

    /// Starts streaming `computerID`, or stops when nil. Asking for the same computer again is a
    /// no-op, even after the stream gave up: only a stop or another computer starts over.
    func stream(_ computerID: String?) {
        guard computerID != self.computerID else { return }
        task?.cancel(); task = nil
        self.computerID = computerID
        errorMessage = nil
        isConnecting = false
        guard let computerID else { return }
        task = Task { [weak self] in await self?.run(computerID) }
    }

    private func run(_ computerID: String) async {
        var reconnect = PathwayComputerFrameReconnect()
        var url: URL?
        while !Task.isCancelled {
            isConnecting = image == nil
            var deliveredFrame = false
            do {
                let target: URL
                if let url { target = url } else { target = try await resolveURL(computerID); url = target }
                let socket = session.webSocketTask(with: target)
                socket.resume()
                defer { socket.cancel(with: .goingAway, reason: nil) }
                try await receive(from: socket, computerID: computerID) {
                    deliveredFrame = true
                    reconnect.frameReceived()
                }
            } catch is CancellationError { return } catch {}
            guard !Task.isCancelled else { return }
            switch reconnect.closed(deliveredFrame: deliveredFrame) {
            case .giveUp:
                isConnecting = false
                errorMessage = Self.unavailableMessage
                task = nil
                return
            case let .retry(delay, remint):
                if remint { url = nil }
                do { try await Task.sleep(for: delay) } catch { return }
            }
        }
    }

    private func receive(from socket: URLSessionWebSocketTask, computerID: String, onFrame: () -> Void) async throws {
        var gate = PathwayComputerFrameGate()
        var lastResync = ContinuousClock.now - .seconds(1)
        var decoding: Task<Void, Never>?
        var pending: Data?
        func resync() {
            guard ContinuousClock.now - lastResync >= .seconds(1) else { return }
            lastResync = .now
            socket.send(.string(#"{"type":"computer.frame.resync"}"#)) { _ in }
        }
        defer { decoding?.cancel() }
        while !Task.isCancelled {
            guard case let .data(data) = try await socket.receive() else { continue }
            onFrame()
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
            decoding = Task { [weak self] in
                while let payload = next {
                    let decoded = await Task.detached(priority: .userInitiated) { Self.decode(payload) }.value
                    guard let self, !Task.isCancelled else { return }
                    if let decoded { self.image = decoded; self.errorMessage = nil; self.isConnecting = false }
                    else { self.errorMessage = Self.unreadableMessage; resync() }
                    next = pending; pending = nil
                }
                decoding = nil
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
