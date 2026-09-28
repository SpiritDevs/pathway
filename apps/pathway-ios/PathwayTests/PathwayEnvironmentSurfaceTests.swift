import CoreGraphics
import Foundation
import Network
import os
import Testing
@testable import Pathway

struct PathwayEnvironmentSurfaceTests {
    private func frame(magic: UInt16 = 0x5350, version: UInt8 = 1, codec: UInt8 = 1, sequence: UInt32 = 7,
                       width: UInt16 = 1_600, height: UInt16 = 1_200, deviceScale: Float = 2,
                       timestampMs: Double = 1_700_000_000_000, payload: [UInt8] = [0xFF, 0xD8]) -> Data {
        var bytes: [UInt8] = []
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { bytes += $0 } }
        append(magic)
        bytes += [version, codec]
        append(sequence)
        append(width)
        append(height)
        append(deviceScale.bitPattern)
        append(timestampMs.bitPattern)
        return Data(bytes + payload)
    }

    @Test func headerParsesTheLittleEndianLayout() throws {
        let header = try PathwaySurfaceFrameHeader(data: frame())
        #expect(header.sequence == 7)
        #expect(header.width == 1_600)
        #expect(header.height == 1_200)
        #expect(header.deviceScale == 2)
        #expect(header.timestampMs == 1_700_000_000_000)
        #expect(header.pageSize == CGSize(width: 800, height: 600))
    }

    @Test func headerRejectsMalformedFrames() {
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.invalidLength) { try PathwaySurfaceFrameHeader(data: frame(payload: [])) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.invalidLength) { try PathwaySurfaceFrameHeader(data: Data(count: 10)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.unsupported) { try PathwaySurfaceFrameHeader(data: frame(magic: 0x1234)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.unsupported) { try PathwaySurfaceFrameHeader(data: frame(version: 2)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.unsupported) { try PathwaySurfaceFrameHeader(data: frame(codec: 2)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.invalidHeader) { try PathwaySurfaceFrameHeader(data: frame(width: 0)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.invalidHeader) { try PathwaySurfaceFrameHeader(data: frame(deviceScale: 0)) }
        #expect(throws: PathwaySurfaceFrameHeader.DecodeError.invalidHeader) { try PathwaySurfaceFrameHeader(data: frame(deviceScale: .nan)) }
    }

    @Test func frameDecodeRejectsAHeaderWithoutAnImage() {
        #expect(PathwayEnvironmentSurfaceStream.decode(frame()) == nil)
    }

    @Test func viewportUsesPointsAndCapsTheScaleAtTwo() throws {
        let phone = try #require(PathwaySurfaceViewport(size: CGSize(width: 402.4, height: 700.6), displayScale: 3))
        #expect(phone.width == 402)
        #expect(phone.height == 701)
        #expect(phone.deviceScale == 2)
        #expect(try #require(PathwaySurfaceViewport(size: CGSize(width: 10, height: 10), displayScale: 0.5)).deviceScale == 1)
        #expect(try #require(PathwaySurfaceViewport(size: CGSize(width: 10, height: 10), displayScale: 1.333)).deviceScale == 1.33)
        #expect(try #require(PathwaySurfaceViewport(size: CGSize(width: 9_000, height: 9_000), displayScale: 2)).width == 4_096)
        #expect(PathwaySurfaceViewport(size: .zero, displayScale: 2) == nil)
    }

    @Test func indicatorMatchesTheWebLabels() {
        #expect(PathwaySurfaceIndicator(state: .connecting, quality: nil) == .init(state: .live, quality: nil))
        #expect(PathwaySurfaceIndicator(state: .connecting, quality: nil).label == "Connecting…")
        #expect(PathwaySurfaceIndicator(state: .stale, quality: nil).label == "Reconnecting…")
        let offline = PathwaySurfaceIndicator(state: .failed, quality: nil)
        #expect(offline.label == "Offline · retrying")
        #expect(offline.tone == .offline)
        #expect(PathwaySurfaceIndicator(state: .live, quality: .init(fps: 0, latencyMs: 900)).label == "Live")
        let live = PathwaySurfaceIndicator(state: .live, quality: .init(fps: 24, latencyMs: 83))
        #expect(live.label == "24 fps · 80 ms")
        #expect(live.tone == .live)
        #expect(PathwaySurfaceIndicator(state: .live, quality: .init(fps: 5, latencyMs: 2)).label == "5 fps")
        #expect(PathwaySurfaceIndicator(state: .live, quality: .init(fps: 5, latencyMs: 450)).tone == .degraded)
    }

    @Test func reconnectBacksOffAndStopsOnlyOnRefusal() {
        var policy = PathwaySurfaceReconnect()
        let delays = (1...8).map { _ in policy.closed(.dropped) }
        #expect(delays.first == .retry(after: .milliseconds(500), state: .stale, remint: false))
        #expect(delays[6] == .retry(after: .milliseconds(30_000), state: .stale, remint: false))
        #expect(delays[7] == .retry(after: .milliseconds(30_000), state: .failed, remint: false))
        policy.usableFrame()
        #expect(policy.closed(.refusedTicket, jitter: 1.2) == .retry(after: .milliseconds(600), state: .stale, remint: true))
        #expect(policy.closed(.refused) == .stop)
    }

    @Test func closeClassificationMatchesTheSurfaceRoute() {
        #expect(PathwaySurfaceReconnect.close(status: 401, closeCode: 0) == .refusedTicket)
        #expect(PathwaySurfaceReconnect.close(status: 403, closeCode: 0) == .refused)
        #expect(PathwaySurfaceReconnect.close(status: 404, closeCode: 0) == .refused)
        #expect(PathwaySurfaceReconnect.close(status: 101, closeCode: 1008) == .refused)
        #expect(PathwaySurfaceReconnect.close(status: 101, closeCode: 1006) == .dropped)
        #expect(PathwaySurfaceReconnect.close(status: nil, closeCode: 0) == .dropped)
    }

    @Test func socketURLKeepsOnlyTheTicketBesideTheRPCRoute() throws {
        let viewport = try #require(PathwaySurfaceViewport(size: CGSize(width: 390, height: 600), displayScale: 3))
        let rpc = try #require(URL(string: "wss://relay.example.com/env/abc/ws?wsTicket=t%2B1&other=x#frag"))
        let url = try #require(pathwaySurfaceSocketURL(
            rpcSocketURL: rpc,
            threadID: "thread 1", tabID: "tab-1", viewport: viewport, sizing: .active))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "wss")
        #expect(components.path == "/env/abc/ws/environment-surface")
        #expect(components.fragment == nil)
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == ["wsTicket": "t+1", "kind": "browser", "threadId": "thread 1", "tabId": "tab-1",
                          "width": "390", "height": "600", "deviceScale": "2.0", "sizing": "active"])
    }

    @Test func socketURLSendsTheSizingRoleExplicitly() throws {
        let viewport = try #require(PathwaySurfaceViewport(size: CGSize(width: 320, height: 200), displayScale: 2))
        let rpc = try #require(URL(string: "ws://192.168.1.4:3773/ws?wsTicket=t"))
        func sizing(_ role: PathwaySurfaceSizing) throws -> [String?] {
            let url = try #require(pathwaySurfaceSocketURL(rpcSocketURL: rpc, threadID: "t", tabID: "a", viewport: viewport, sizing: role))
            return (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).filter { $0.name == "sizing" }.map(\.value)
        }
        #expect(try sizing(.active) == ["active"])
        #expect(try sizing(.passive) == ["passive"])
    }

    @Test func tapsMapThroughTheAspectFitToCSSPixels() throws {
        let page = CGSize(width: 800, height: 600)
        let view = CGSize(width: 400, height: 400) // 0.5 scale, letterboxed 50pt top and bottom
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 200, y: 200), in: view, page: page) == CGPoint(x: 400, y: 300))
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 0, y: 50), in: view, page: page) == CGPoint(x: 0, y: 0))
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 200, y: 20), in: view, page: page) == nil)
        #expect(PathwayRemoteBrowserGeometry.point(.zero, in: view, page: .zero) == nil)
    }

    @MainActor @Test func aSupersededRunLeavesItsSuccessorsSocketAlone() async throws {
        let server = try await SurfaceTestServer.start()
        defer { server.stop() }
        let held = AsyncStream<CheckedContinuation<URL, Never>>.makeStream()
        let resolves = OSAllocatedUnfairLock(initialState: 0)
        let stream = PathwayEnvironmentSurfaceStream {
            // The first run's ticket is slow; the second resolves at once.
            if resolves.withLock({ $0 += 1; return $0 }) == 1 { return await withCheckedContinuation { held.continuation.yield($0) } }
            return server.rpcURL
        }
        stream.setViewport(PathwaySurfaceViewport(size: CGSize(width: 100, height: 100), displayScale: 2))

        let first = Task { await stream.run(threadID: "thread", tabID: "tab") }
        var heldResolves = held.stream.makeAsyncIterator()
        let firstTicket = try #require(await heldResolves.next())
        first.cancel()

        let second = Task { await stream.run(threadID: "thread", tabID: "tab") }
        defer { second.cancel() }
        #expect(try await server.receive() == "ready")

        // The first run's ticket lands after the second run is streaming.
        firstTicket.resume(returning: server.rpcURL)
        await first.value

        try await server.send("ping")
        #expect(try await server.receive() == "pong")
    }
}

/// One loopback WebSocket connection, driven from the test.
private final class SurfaceTestServer: @unchecked Sendable {
    let rpcURL: URL
    private let listener: NWListener
    private let connections: AsyncStream<NWConnection>
    private var connection: NWConnection?

    private init(listener: NWListener, port: UInt16, connections: AsyncStream<NWConnection>) {
        self.listener = listener
        self.connections = connections
        rpcURL = URL(string: "ws://127.0.0.1:\(port)/ws?wsTicket=ticket")!
    }

    static func start() async throws -> SurfaceTestServer {
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let (connections, continuation) = AsyncStream<NWConnection>.makeStream()
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            continuation.yield(connection)
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { ready in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: listener.stateUpdateHandler = nil; ready.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error): listener.stateUpdateHandler = nil; ready.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: .global())
        }
        return SurfaceTestServer(listener: listener, port: port, connections: connections)
    }

    private func current() async throws -> NWConnection {
        if let connection { return connection }
        var iterator = connections.makeAsyncIterator()
        guard let next = await iterator.next() else { throw URLError(.cannotConnectToHost) }
        connection = next
        return next
    }

    /// The next text message; throws once the client closes.
    func receive() async throws -> String {
        let connection = try await current()
        return try await withCheckedThrowingContinuation { result in
            connection.receiveMessage { data, _, _, error in
                if let error { result.resume(throwing: error) }
                else if let data, !data.isEmpty { result.resume(returning: String(decoding: data, as: UTF8.self)) }
                else { result.resume(throwing: URLError(.networkConnectionLost)) }
            }
        }
    }

    func send(_ text: String) async throws {
        let connection = try await current()
        let context = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        try await withCheckedThrowingContinuation { (result: CheckedContinuation<Void, Error>) in
            connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error { result.resume(throwing: error) } else { result.resume() }
            })
        }
    }

    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}
