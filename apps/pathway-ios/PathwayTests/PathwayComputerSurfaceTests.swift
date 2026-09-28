import CoreGraphics
import Foundation
@testable import Pathway
import Testing

struct PathwayComputerSurfaceTests {
    @Test func decodesTheSurfaceHeader() throws {
        let frame = try PathwaySurfaceFrame(data: surfaceFrame(width: 2880, height: 1800, deviceScale: 2, jpeg: [0xFF, 0xD8, 1]))
        #expect(frame.sequence == 7)
        #expect(frame.width == 2880 && frame.height == 1800)
        #expect(frame.deviceScale == 2)
        #expect(frame.timestampMs == 1_700_000_000_123)
        #expect(frame.jpeg == Data([0xFF, 0xD8, 1]))
        #expect(frame.screenSize == CGSize(width: 1440, height: 900))
    }

    @Test func refusesMalformedSurfaceFrames() {
        #expect(throws: PathwaySurfaceFrame.DecodeError.badLength) { try PathwaySurfaceFrame(data: Data(count: 24)) }
        var badMagic = surfaceFrame()
        badMagic[0] = 0
        #expect(throws: PathwaySurfaceFrame.DecodeError.unsupported) { try PathwaySurfaceFrame(data: badMagic) }
        #expect(throws: PathwaySurfaceFrame.DecodeError.badHeader) { try PathwaySurfaceFrame(data: surfaceFrame(width: 0)) }
        #expect(throws: PathwaySurfaceFrame.DecodeError.badHeader) { try PathwaySurfaceFrame(data: surfaceFrame(deviceScale: 0)) }
    }

    @Test func socketURLKeepsThePrefixAndTicketAndNamesTheComputer() throws {
        let rpc = try #require(URL(string: "wss://relay.example/env/abc/ws?wsTicket=t1&other=x#frag"))
        let url = try #require(pathwayComputerSurfaceSocketURL(rpcSocketURL: rpc, computerID: "desktop",
                                                               viewport: CGSize(width: 390.4, height: 9000), deviceScale: 3))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.path == "/env/abc/ws/environment-surface")
        #expect(components.fragment == nil)
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query == ["wsTicket": "t1", "kind": "computer", "computerId": "desktop", "width": "390", "height": "4096", "deviceScale": "3.0"])
    }

    @Test func sessionSaysWhoHoldsTheScreen() throws {
        let mine = try #require(PathwayComputerSurfaceSession(session(controller: ["kind": .string("client"), "clientId": .string("me")])))
        #expect(mine.mine && mine.tone == .mine && mine.label == "Agent idle — you have control")
        let other = try #require(PathwayComputerSurfaceSession(session(controller: ["kind": .string("client"), "clientId": .string("them")])))
        #expect(!other.mine && other.tone == .other)
        let agent = try #require(PathwayComputerSurfaceSession(session(controller: ["kind": .string("agent"), "threadId": .string("t-agent")], turns: ["t-a", "t-b"])))
        #expect(agent.tone == .agent && agent.handBackThreadID(fallback: "t-view") == "t-agent")
        let idle = try #require(PathwayComputerSurfaceSession(session(controller: ["kind": .string("idle")], turns: ["t-a"], pointerPhases: true)))
        #expect(idle.tone == .idle && idle.handBackThreadID(fallback: "t-view") == "t-a" && idle.pointerPhases)
        let quiet = try #require(PathwayComputerSurfaceSession(session(controller: ["kind": .string("idle")])))
        #expect(quiet.handBackThreadID(fallback: "t-view") == "t-view")
        #expect(PathwayComputerSurfaceSession(.object(["clientId": .string("me")])) == nil)
    }

    @Test func pointsExcludeLetterboxingAndUseDesktopPoints() throws {
        // A 1440x900-point screen fitted into a 400x400 box: 250 tall, 75 of bars above and below.
        let screen = CGSize(width: 1440, height: 900)
        let box = CGSize(width: 400, height: 400)
        let center = try #require(PathwayComputerSurfaceInput.point(CGPoint(x: 200, y: 200), in: box, screen: screen))
        #expect(abs(center.x - 720) < 0.001 && abs(center.y - 450) < 0.001)
        let corner = try #require(PathwayComputerSurfaceInput.point(CGPoint(x: 0, y: 75), in: box, screen: screen))
        #expect(corner == .zero)
        #expect(PathwayComputerSurfaceInput.point(CGPoint(x: 200, y: 50), in: box, screen: screen) == nil)
    }

    @Test func buildsInputEvents() {
        let point = CGPoint(x: 10, y: 20)
        #expect(PathwayComputerSurfaceInput.click(point) == .object(["type": .string("pointer.click"), "x": .number(10), "y": .number(20), "button": .string("left")]))
        #expect(PathwayComputerSurfaceInput.click(point, clickCount: 2).objectValue?["clickCount"] == .number(2))
        #expect(PathwayComputerSurfaceInput.click(point, button: "right").objectValue?["button"] == .string("right"))
        #expect(PathwayComputerSurfaceInput.wheel(point, deltaX: 0, deltaY: 20_000).objectValue?["deltaY"] == .number(10_000))
        #expect(PathwayComputerSurfaceInput.key("C", modifiers: ["meta"]) == .object(["type": .string("key"), "key": .string("C"), "modifiers": .array([.string("meta")])]))
        #expect(PathwayComputerSurfaceInput.key("Enter").objectValue?["modifiers"] == nil)
        #expect(PathwayComputerSurfaceInput.type(String(repeating: "a", count: 20_000)).objectValue?["text"]?.stringValue?.count == 16_384)
    }

    @Test func handBackFollowUpQueuesAfterTheActiveRun() {
        let attachment: JSONValue = .object(["type": .string("image"), "id": .string("att-1")])
        let followUp = PathwayComputerHandBackFollowUp(threadID: "t-1", messageID: "m-1", commandID: "c-1", message: "  finish up ",
                                                       summary: "Clicked Save\n", attachment: attachment)
        let command = followUp.command.objectValue
        #expect(command?["type"] == .string("message.dispatch"))
        #expect(command?["commandId"] == .string("c-1"))
        #expect(command?["messageId"] == .string("m-1"))
        #expect(command?["creationSource"] == .string("mobile"))
        #expect(command?["text"] == .string("/computer-use finish up\n\nClicked Save"))
        #expect(command?["attachments"] == .array([attachment]))
        #expect(command?["dispatchMode"] == .object(["type": .string("queue_after_active")]))
        #expect(PathwayComputerSurfaceInput.handBackText(message: "go", summary: " ") == "/computer-use go")
    }

    @Test func rotationReconnectsTheStreamButAKeyboardDoesNot() {
        let portrait = PathwayComputerSurfaceViewport(size: CGSize(width: 390, height: 560), scale: 3)
        let screen = CGSize(width: 1440, height: 900)
        #expect(portrait.needsReconnect(for: .init(size: CGSize(width: 750, height: 330), scale: 3), screen: screen))
        #expect(!portrait.needsReconnect(for: .init(size: CGSize(width: 390, height: 280), scale: 3), screen: screen))
        #expect(!portrait.needsReconnect(for: .init(size: CGSize(width: 380, height: 560), scale: 3), screen: nil))
        #expect(portrait.needsReconnect(for: .init(size: CGSize(width: 390, height: 560), scale: 2), screen: screen))
    }

    @MainActor @Test func escapeSkipsAStalledFullQueue() async {
        let rpc = SurfaceRPC()
        let model = surfaceModel(rpc)
        model.receive(session(controller: ["kind": .string("client"), "clientId": .string("me")]))
        var started = rpc.started.makeAsyncIterator()
        model.sendKey("A")
        #expect(await started.next() == "input:A")
        for _ in 0 ..< 40 { model.sendKey("B") }
        model.sendKey("Escape")
        #expect(await started.next() == "input:Escape")
        rpc.release()
        // Hand-back waits for the drain, so by its call nothing queued before Escape can remain.
        #expect(await model.handBack("finish"))
        #expect(rpc.log == ["input:Escape", "input:A", "handBack", "dispatch"])
    }

    @MainActor @Test func handBackWaitsForQueuedInputAndStopsNewInput() async {
        let rpc = SurfaceRPC()
        let model = surfaceModel(rpc)
        model.receive(session(controller: ["kind": .string("client"), "clientId": .string("me")]))
        var started = rpc.started.makeAsyncIterator()
        model.sendKey("A")
        #expect(await started.next() == "input:A")
        model.sendKey("B")
        let handingBack = Task { await model.handBack("finish") }
        await Task.yield()
        model.sendKey("C")
        rpc.release()
        #expect(await handingBack.value)
        #expect(rpc.log == ["input:A", "input:B", "handBack", "dispatch"])
    }

    @MainActor @Test func retryResendsTheSameCommand() async throws {
        let rpc = SurfaceRPC()
        rpc.failedDispatches = 1
        let model = surfaceModel(rpc)
        model.receive(session(controller: ["kind": .string("client"), "clientId": .string("me")]))
        #expect(await model.handBack("finish"))
        #expect(model.pendingFollowUp != nil && model.error != nil)
        await model.retryFollowUp()
        #expect(model.pendingFollowUp == nil && model.error == nil)
        #expect(rpc.dispatched.count == 2)
        let first = try #require(rpc.dispatched.first?.objectValue), retry = try #require(rpc.dispatched.last?.objectValue)
        #expect(first["commandId"] != nil && first["commandId"] == retry["commandId"])
        #expect(first["messageId"] != nil && first["messageId"] == retry["messageId"])
    }

    @MainActor @Test func aDroppedConnectionEndsControlUntilAFreshSnapshotAndKeepsDrafts() async {
        let rpc = SurfaceRPC()
        let model = surfaceModel(rpc)
        let mine = session(controller: ["kind": .string("client"), "clientId": .string("me")])
        model.receive(mine)
        #expect(model.session?.mine == true)
        model.typing = "half a sentence"
        model.draft = "then run the tests"
        model.receive(.object(["_pathwayTransport": .string("disconnected")]))
        #expect(model.session == nil && model.notice != nil)
        model.sendKey("A")
        await model.takeControl()
        #expect(model.error != nil && rpc.log.isEmpty)
        model.receive(session(controller: ["kind": .string("idle")]))
        #expect(model.session?.tone == .idle)
        #expect(model.typing == "half a sentence" && model.draft == "then run the tests")
        await model.takeControl()
        #expect(rpc.log == ["takeControl"])
    }

    private func surfaceFrame(width: UInt16 = 100, height: UInt16 = 50, deviceScale: Float = 1, jpeg: [UInt8] = [1]) -> Data {
        var bytes = [UInt8]()
        func append<T: FixedWidthInteger>(_ value: T) { bytes += (0..<MemoryLayout<T>.size).map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) } }
        append(UInt16(0x5350)); bytes += [1, 1]
        append(UInt32(7)); append(width); append(height)
        append(deviceScale.bitPattern); append(Double(1_700_000_000_123).bitPattern)
        return Data(bytes + jpeg)
    }

    private func session(controller: [String: JSONValue], turns: [String] = [], pointerPhases: Bool = false) -> JSONValue {
        .object([
            "clientId": .string("me"),
            "state": .object([
                "computerId": .string("desktop"), "revision": .number(1), "controller": .object(controller),
                "activeTurns": .array(turns.map { .object(["threadId": .string($0), "runId": .string("r")]) }),
                "capabilities": .object(["capture": .bool(false), "input": .bool(true), "pointerPhases": .bool(pointerPhases)])
            ])
        ])
    }

    @MainActor private func surfaceModel(_ rpc: SurfaceRPC) -> PathwayComputerSurfaceModel {
        let connect = PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" })
        let environment = PathwayCompanyEnvironment(companyId: "company", environment: PathwayEnvironment(id: "environment", environmentId: "environment",
            descriptor: PathwayEnvironmentDescriptor(environmentId: "environment", label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let model = PathwayComputerSurfaceModel(threadID: "t-view", environment: environment, connect: connect)
        model.request = { method, payload in try await rpc.request(method, payload) }
        return model
    }
}

/// Records computer surface RPCs as they finish. The first input stalls until `release()`.
@MainActor private final class SurfaceRPC {
    let started: AsyncStream<String>
    private let startedContinuation: AsyncStream<String>.Continuation
    private(set) var log: [String] = []
    private(set) var dispatched: [JSONValue] = []
    var failedDispatches = 0
    private var stallsInput = true
    private var stalled: CheckedContinuation<Void, Never>?

    init() { (started, startedContinuation) = AsyncStream.makeStream(of: String.self) }

    func request(_ method: String, _ payload: JSONValue) async throws -> JSONValue {
        let event = payload.objectValue?["event"]?.objectValue
        let name = method == "computer.surface.input" ? "input:\(event?["key"]?.stringValue ?? "")"
            : method == "orchestration.dispatchCommand" ? "dispatch" : String(method.split(separator: ".").last ?? "")
        startedContinuation.yield(name)
        if method == "computer.surface.input", stallsInput {
            stallsInput = false
            await withCheckedContinuation { stalled = $0 }
        }
        log.append(name)
        switch method {
        case "computer.surface.handBack":
            return .object(["attachment": .object(["id": .string("capture")]), "summary": .string("Clicked Save")])
        case "orchestration.dispatchCommand":
            dispatched.append(payload)
            if failedDispatches > 0 { failedDispatches -= 1; throw URLError(.networkConnectionLost) }
        default: break
        }
        return .null
    }

    func release() { stalled?.resume(); stalled = nil }
}
