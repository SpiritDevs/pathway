import CoreGraphics
import Foundation
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
            threadID: "thread 1", tabID: "tab-1", viewport: viewport))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "wss")
        #expect(components.path == "/env/abc/ws/environment-surface")
        #expect(components.fragment == nil)
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == ["wsTicket": "t+1", "kind": "browser", "threadId": "thread 1", "tabId": "tab-1",
                          "width": "390", "height": "600", "deviceScale": "2.0"])
    }

    @Test func tapsMapThroughTheAspectFitToCSSPixels() throws {
        let page = CGSize(width: 800, height: 600)
        let view = CGSize(width: 400, height: 400) // 0.5 scale, letterboxed 50pt top and bottom
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 200, y: 200), in: view, page: page) == CGPoint(x: 400, y: 300))
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 0, y: 50), in: view, page: page) == CGPoint(x: 0, y: 0))
        #expect(PathwayRemoteBrowserGeometry.point(CGPoint(x: 200, y: 20), in: view, page: page) == nil)
        #expect(PathwayRemoteBrowserGeometry.point(.zero, in: view, page: .zero) == nil)
    }
}
