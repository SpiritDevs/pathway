import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayThreadComputerTests {
    @Test func decodesTheFrameEnvelope() throws {
        let frame = try PathwayComputerFrame(data: envelope(sequence: 0x0102_0304, computerID: "mac-1", flags: 1, payload: [9, 8]))
        #expect(frame.keyframe && !frame.codecConfig)
        #expect(frame.sequence == 0x0102_0304)
        #expect(frame.timestampMs == 1_700_000_000_123)
        #expect(frame.computerID == "mac-1")
        #expect(frame.payload == Data([9, 8]))
    }

    @Test func refusesMalformedFrames() {
        #expect(throws: PathwayComputerFrame.DecodeError.tooShort) { try PathwayComputerFrame(data: Data(count: 16)) }
        var badMagic = envelope(sequence: 1, computerID: "mac")
        badMagic[0] = 0
        #expect(throws: PathwayComputerFrame.DecodeError.badMagic) { try PathwayComputerFrame(data: badMagic) }
        var future = envelope(sequence: 1, computerID: "mac")
        future[2] = 2
        #expect(throws: PathwayComputerFrame.DecodeError.unsupportedVersion) { try PathwayComputerFrame(data: future) }
        #expect(throws: PathwayComputerFrame.DecodeError.truncatedComputerID) { try PathwayComputerFrame(data: envelope(sequence: 1, computerID: "mac").prefix(18)) }
        #expect(throws: PathwayComputerFrame.DecodeError.truncatedComputerID) { try PathwayComputerFrame(data: envelope(sequence: 1, computerID: "")) }
    }

    @Test func gateDropsStaleFramesAndAsksForAKeyframeAfterAGap() {
        var gate = PathwayComputerFrameGate()
        #expect(gate.step(sequence: 10, computerID: "other", expected: "mac") == (.ignore, false))
        #expect(gate.step(sequence: 10, computerID: "mac", expected: "mac") == (.decode, false))
        #expect(gate.step(sequence: 10, computerID: "mac", expected: "mac") == (.dropStale, false))
        #expect(gate.step(sequence: 9, computerID: "mac", expected: "mac") == (.dropStale, false))
        #expect(gate.step(sequence: 11, computerID: "mac", expected: "mac") == (.decode, false))
        #expect(gate.step(sequence: 14, computerID: "mac", expected: "mac") == (.decode, true))
        var wrapping = PathwayComputerFrameGate()
        _ = wrapping.step(sequence: .max, computerID: "mac", expected: "mac")
        #expect(wrapping.step(sequence: 0, computerID: "mac", expected: "mac") == (.decode, false))
    }

    @Test func reconnectBacksOffThenGivesUp() {
        var reconnect = PathwayComputerFrameReconnect()
        #expect(reconnect.closed(deliveredFrame: false) == .retry(after: .milliseconds(500), remint: true))
        #expect(reconnect.closed(deliveredFrame: false) == .retry(after: .milliseconds(1_000), remint: true))
        reconnect.frameReceived()
        #expect(reconnect.closed(deliveredFrame: true) == .retry(after: .milliseconds(500), remint: false))
        for _ in 2...PathwayComputerFrameReconnect.maxAttempts { _ = reconnect.closed(deliveredFrame: false) }
        #expect(reconnect.closed(deliveredFrame: false) == .giveUp)
    }

    @Test func frameSocketSitsBesideTheRPCSocketWithItsTicket() throws {
        let rpc = try #require(URL(string: "wss://relay.example/env/ws?wsTicket=abc&other=1#x"))
        let url = pathwayComputerFrameSocketURL(rpcSocketURL: rpc, computerID: "mac 1")
        #expect(url?.absoluteString == "wss://relay.example/env/ws/computer-frames?wsTicket=abc&computerId=mac%201")
        let direct = try #require(URL(string: "ws://192.168.1.4:3773/ws/"))
        #expect(pathwayComputerFrameSocketURL(rpcSocketURL: direct, computerID: "mac")?.absoluteString == "ws://192.168.1.4:3773/ws/computer-frames?computerId=mac")
    }

    @Test func aDriveTurnArmsThenOpensAndEndsThePreview() throws {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 1, agentActive: false))
        #expect(session.phase == nil)
        session.apply(event: stateEvent(version: 2, agentActive: true))
        #expect(session.phase == .armed)
        #expect(session.streamingComputerID == nil)
        session.viewed()
        #expect(session.isOpen)
        #expect(session.streamingComputerID == "mac")
        #expect(session.statusLabel == "Live")
        session.apply(event: stateEvent(version: 1, agentActive: false))
        #expect(session.isOpen)
        session.apply(event: stateEvent(version: 3, agentActive: false))
        #expect(session.phase == .ended)
        #expect(session.streamingComputerID == nil)
    }

    @Test func hidingLastsUntilTheNextDriveTurn() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 1, agentActive: true))
        session.viewed()
        session.hide()
        #expect(session.phase == .hiddenForTask)
        session.apply(event: .object(["type": .string("computer.open-pane-requested"), "threadId": .string("other")]))
        #expect(session.phase == .hiddenForTask)
        session.apply(event: stateEvent(version: 2, agentActive: false))
        session.apply(event: stateEvent(version: 3, agentActive: true))
        #expect(session.phase == .armed)
    }

    @Test func anotherThreadsLeaseDoesNotDriveThisOne() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 1, agentActive: true, owner: "other", controlledByOther: true))
        #expect(session.phase == nil)
        session.apply(event: stateEvent(version: 2, agentActive: false, owner: "thread"))
        #expect(session.phase == .armed)
    }

    @Test func actionsLabelTheCardAndEscapeOutranksThem() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 1, agentActive: true))
        session.apply(event: .object(["type": .string("computer.action"), "action": .string("computer_click"), "ok": .bool(true),
            "windowId": .string("w1"), "delivery": .object(["path": .string("ax-background")]), "threadId": .string("other")]))
        #expect(session.lastActionLabel == nil)
        session.apply(event: .object(["type": .string("computer.action"), "action": .string("computer_click"), "ok": .bool(true),
            "windowId": .string("w1"), "delivery": .object(["path": .string("ax-background")]), "threadId": .string("thread")]))
        #expect(session.statusLabel == "Click · Safari · Background action")
        session.apply(event: .object(["type": .string("computer.input-stopped"), "stopped": .bool(true)]))
        #expect(session.statusLabel == "Stopped via Escape")
        session.rebase()
        #expect(session.statusLabel == "Stopped via Escape")
        session.apply(event: stateEvent(version: 1, agentActive: true))
        #expect(session.statusLabel == "Click · Safari · Background action")
    }

    @Test func actionLabelsMatchTheWebClient() {
        func label(_ fields: [String: JSONValue]) -> String? { PathwayThreadComputerSession.actionLabel(fields, windows: []) }
        #expect(label(["action": .string("mcp__pathway__computer_type_text"), "ok": .bool(true)]) == "Type")
        #expect(label(["action": .string("computer.window_focus"), "ok": .bool(false), "message": .string("gone")]) == "Window focus failed: gone")
        #expect(label(["action": .string("computer_zoom"), "ok": .bool(false),
                       "delivery": .object(["path": .string("temporary-foreground")])]) == "Zoom into a window failed · Temporary foreground")
        #expect(label(["action": .string("computer_"), "ok": .bool(true)]) == nil)
    }

    @Test func anActionArmsAPreviewThatHadNotStarted() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: .object(["type": .string("computer.action"), "action": .string("computer_scroll"), "ok": .bool(true), "threadId": .string("thread")]))
        #expect(session.phase == .armed)
    }

    @Test func aReconnectLetsAnySnapshotReplaceTheOldOne() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 9, agentActive: true))
        session.apply(event: stateEvent(version: 2, agentActive: true, availability: "unavailable"))
        #expect(session.state?.availability == "available")
        session.rebase()
        session.apply(event: stateEvent(version: 2, agentActive: true, availability: "unavailable"))
        #expect(session.state?.availability == "unavailable")
        #expect(session.state?.version == 2)
    }

    @Test func aSeedFromAnOlderConnectionOrACancelledWatchNeverLands() async throws {
        let model = PathwayThreadComputerModel(threadID: "thread", environment: computerTestEnvironment(),
                                               connect: PathwayConnectClient(relayURL: URL(string: "https://relay.test")!, clerkTokenProvider: { "unused" }))
        let gate = ComputerReadGate()
        let state = try #require(stateEvent(version: 4, agentActive: true).objectValue?["state"])
        let stale = Task { await model.applySeed { await gate.read() } }
        await gate.started(1)
        model.connectionChanged()
        gate.finish(state)
        await stale.value
        #expect(model.session.state == nil)
        let cancelled = Task { await model.applySeed { await gate.read() } }
        await gate.started(2)
        cancelled.cancel()
        gate.finish(state)
        await cancelled.value
        #expect(model.session.state == nil)
        await model.applySeed { state }
        #expect(model.session.state?.version == 4)
    }

    @Test func aConnectionChangePausesStillsUntilItsSeedConfirmsTheComputer() {
        var session = PathwayThreadComputerSession(threadID: "thread")
        session.apply(event: stateEvent(version: 9, agentActive: true))
        session.viewed()
        #expect(session.streamingComputerID == "mac")
        session.rebase()
        #expect(session.isOpen)
        #expect(session.streamingComputerID == nil)
        session.apply(event: stateEvent(version: 0, agentActive: true))
        #expect(session.streamingComputerID == "mac")
    }

    @Test func stoppingOrSwitchingAQuietStreamClosesItsSocket() async throws {
        let session = try #require((NSClassFromString("PathwayFakeFrameSession") as? NSObject.Type)?.init() as? URLSession)
        let frames = PathwayComputerFrameStream(session: session) { _ in URL(string: "wss://unused.invalid/ws/computer-frames")! }
        func quietSocket(_ start: () -> Void) async throws -> NSObject {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let ready: @convention(block) () -> Void = { continuation.resume() }
                session.setValue(ready, forKey: "onReceive")
                start()
            }
            return try #require((session.value(forKey: "sockets") as? [NSObject])?.last)
        }
        let stopped = try await quietSocket { frames.stream("mac") }
        frames.stream(nil)
        #expect(stopped.value(forKey: "cancelCount") as? Int == 1)
        let switched = try await quietSocket { frames.stream("mac") }
        frames.stream("mini")
        #expect(switched.value(forKey: "cancelCount") as? Int == 1)
        frames.stream(nil)
    }

    private func stateEvent(version: Int, agentActive: Bool, owner: String? = nil, controlledByOther: Bool = false,
                            availability: String = "available") -> JSONValue {
        var state: [String: JSONValue] = [
            "threadId": .string("thread"), "version": .number(Double(version)), "computerId": .string("mac"),
            "windows": .array([.object(["id": .string("w1"), "title": .string("Start"), "appName": .string("Safari")])]),
            "agentActive": .bool(agentActive), "controlledByOtherThread": .bool(controlledByOther),
            "availability": .object(["kind": .string(availability)]), "controlGeneration": .number(3)
        ]
        if let owner { state["controlOwnerThreadId"] = .string(owner) }
        return .object(["type": .string("computer.thread-state"), "state": .object(state)])
    }

    private func envelope(sequence: UInt32, computerID: String, flags: UInt8 = 0, payload: [UInt8] = [1]) -> Data {
        var bytes: [UInt8] = [0x43, 0x53, 1, flags]
        bytes += withUnsafeBytes(of: sequence.littleEndian, Array.init)
        bytes += withUnsafeBytes(of: Double(1_700_000_000_123).bitPattern.littleEndian, Array.init)
        let id = Array(computerID.utf8)
        bytes.append(UInt8(id.count))
        return Data(bytes + id + payload)
    }
}
