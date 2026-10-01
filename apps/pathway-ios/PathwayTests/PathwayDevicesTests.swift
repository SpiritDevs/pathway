import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayDevicesTests {
    private func session(_ thread: String, host: String = "local", device: String, platform: String = "ios", openedAt: String) -> JSONValue {
        .object(["threadId": .string(thread), "hostId": .string(host), "deviceId": .string(device),
                 "platform": .string(platform), "openedAt": .string(openedAt)])
    }

    private func state(sessions: [JSONValue], hosts: [(String, String)] = [("local", "This Mac")]) -> PathwayDeviceState? {
        PathwayDeviceState(.object([
            "revision": .number(3), "hubBasePath": .string("/api/device-hub"),
            "sessions": .array(sessions),
            "devices": .array([
                .object(["hostId": .string("local"), "id": .string("UDID-1"), "name": .string("iPhone 17"), "version": .string("iOS 26.0")]),
                .object(["hostId": .string("ssh-mini"), "id": .string("UDID-1"), "name": .string("iPhone 16e"), "version": .string("iOS 18.4")])
            ]),
            "hosts": .array(hosts.map { .object(["id": .string($0.0), "label": .string($0.1)]) })
        ]))
    }

    @Test func listsOnlyThisThreadsDevicesOldestFirst() throws {
        let state = try #require(state(sessions: [
            session("thread-1", device: "emulator-5554", platform: "android", openedAt: "2026-10-01T10:05:00Z"),
            session("thread-2", device: "UDID-9", openedAt: "2026-10-01T10:00:00Z"),
            session("thread-1", device: "UDID-1", openedAt: "2026-10-01T10:00:00Z")
        ]))
        let previews = PathwayThreadDevicePreview.previews(state, threadID: "thread-1")
        #expect(previews.map(\.deviceID) == ["UDID-1", "emulator-5554"])
        #expect(previews[0].name == "iPhone 17")
        #expect(previews[0].detail == "iOS 26.0")
        // An unknown device still gets a name the user recognizes.
        #expect(previews[1].name == "Android Emulator")
        #expect(previews[1].detail.isEmpty)
    }

    @Test func keysDevicesByHostAndNamesTheHostOnlyWhenThereAreSeveral() throws {
        let state = try #require(state(sessions: [
            session("thread-1", device: "UDID-1", openedAt: "1"),
            session("thread-1", host: "ssh-mini", device: "UDID-1", openedAt: "2")
        ], hosts: [("local", "This Mac"), ("ssh-mini", "Mac mini")]))
        let previews = PathwayThreadDevicePreview.previews(state, threadID: "thread-1")
        #expect(Set(previews.map(\.id)).count == 2)
        #expect(previews.map(\.detail) == ["iOS 26.0 · This Mac", "iOS 18.4 · Mac mini"])
        #expect(PathwayThreadDevicePreview.buttonTitle(count: 1) == "One device open")
        #expect(PathwayThreadDevicePreview.buttonTitle(count: 2) == "2 devices open")
    }

    @Test func rejectsSnapshotsWithoutTheFieldsTheViewerNeeds() {
        #expect(PathwayDeviceState(.object(["revision": .number(1)])) == nil)
        let state = PathwayDeviceState(.object(["revision": .number(1), "hubBasePath": .string("/api/device-hub"),
            "sessions": .array([session("thread-1", device: "x", platform: "watchos", openedAt: "1")])]))
        #expect(state?.sessions.isEmpty == true)
    }

    private func control(_ generation: Int, _ phase: String, owner: JSONValue = .null, device: String = "UDID-1") -> JSONValue {
        .object(["hostId": .string("local"), "deviceId": .string(device), "generation": .number(Double(generation)),
                 "phase": .string(phase), "owner": owner, "expiresAt": .null])
    }
    private func viewer(_ id: String) -> JSONValue {
        .object(["kind": .string("viewer"), "sessionId": .string("session"), "viewerId": .string(id)])
    }
    private let agent: JSONValue = .object(["kind": .string("agent"), "threadId": .string("thread-1"), "runId": .string("run-1")])

    private func leased(_ controls: [JSONValue]) throws -> PathwayDeviceState {
        try #require(PathwayDeviceState(.object(["revision": .number(1), "hubBasePath": .string("/api/device-hub"),
                                                 "supportsDeviceControl": .bool(true), "controls": .array(controls)])))
    }

    @Test func readsControlLeasesFromTheSnapshot() throws {
        let state = try leased([control(4, "held", owner: viewer("me")), control(2, "draining", owner: agent, device: "UDID-2"),
                                control(1, "idle")])
        #expect(state.supportsDeviceControl)
        #expect(state.controls.map(\.owner) == [.viewer(viewerID: "me"), .agent, nil])
        #expect(state.controls.map(\.phase) == [.held, .draining, .idle])
        #expect(PathwayDeviceState(.object(["revision": .number(1), "hubBasePath": .string("/x")]))?.supportsDeviceControl == false)
    }

    @Test func inputNeedsThisViewersHeldLease() throws {
        func resolve(_ controls: [JSONValue], lease: JSONValue? = nil, acquiring: Bool = false) throws -> PathwayDeviceControl {
            .resolve(try leased(controls), hostID: "local", deviceID: "UDID-1", viewerID: "me",
                     lease: lease.flatMap(PathwayDeviceControlState.init), acquiring: acquiring)
        }
        #expect(try resolve([]) == .nobody)
        #expect(try resolve([control(1, "idle")]) == .nobody)
        #expect(try resolve([control(2, "held", owner: agent)]) == .agent)
        #expect(try resolve([control(2, "held", owner: viewer("other"))]) == .viewer)
        #expect(try resolve([control(2, "held", owner: agent)], acquiring: true) == .taking)
        #expect(try resolve([control(3, "draining", owner: agent)]) == .finishing)
        // The acquire response can arrive before the snapshot that reports it.
        #expect(try resolve([control(3, "draining", owner: agent)], lease: control(4, "held", owner: viewer("me"))) == .you)
        #expect(try resolve([control(4, "held", owner: viewer("me"))], lease: control(4, "held", owner: viewer("me"))) == .you)
        // A snapshot naming this viewer is not control without the matching grant.
        #expect(try resolve([control(4, "held", owner: viewer("me"))]) == .viewer)
        // A newer snapshot supersedes a grant the environment already ended.
        #expect(try resolve([control(5, "held", owner: agent)], lease: control(4, "held", owner: viewer("me"))) == .agent)
        #expect(try resolve([control(4, "held", owner: viewer("me"), device: "UDID-2")],
                            lease: control(4, "held", owner: viewer("me"), device: "UDID-2")) == .nobody)
        let all: [PathwayDeviceControl] = [.unknown, .taking, .you, .agent, .viewer, .nobody, .finishing, .idle]
        #expect(all.filter { $0.acceptsInput } == [.you, .idle])
    }

    @Test func environmentsWithoutLeasesWatchWhileTheAgentRuns() {
        #expect(PathwayDeviceControl.unleased(runStateKnown: false, activeRunID: nil) == .unknown)
        #expect(PathwayDeviceControl.unleased(runStateKnown: true, activeRunID: "run-1") == .agent)
        #expect(PathwayDeviceControl.unleased(runStateKnown: true, activeRunID: nil) == .idle)
        #expect(!PathwayDeviceControl.idle.canTake)
    }

    @Test func explainsEachControlRefusal() {
        let codes = ["control_required", "control_held", "stale_generation", "control_draining", "run_stopped",
                     "invalid_grant", "input_unconfirmed"]
        let messages = codes.map { PathwayDeviceControl.message(for: PathwayRPCError.deviceControl(code: $0, message: "raw")) }
        #expect(Set(messages).count == codes.count)
        #expect(!messages.contains("raw"))
        #expect(PathwayDeviceControl.message(for: PathwayRPCError.deviceControl(code: "new_code", message: "raw")) == "raw")
    }

    @Test func leaseRenewsOnItsConnectionAndReleasesBeforeClosingIt() async throws {
        let server = FakeDeviceControlServer()
        let lease = PathwayDeviceControlLease { server.connection() }
        server.respond = { tag, _ in
            switch tag {
            case "device.releaseControl": self.control(8, "idle")
            default: self.control(7, "held", owner: self.viewer(lease.viewerID))
            }
        }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        #expect(lease.proof == PathwayDeviceControlProof(viewerID: lease.viewerID, generation: 7))
        #expect(!lease.acquiring)
        await lease.renew()
        #expect(lease.proof?.generation == 7)
        try await lease.release()
        #expect(lease.proof == nil)
        #expect(server.calls.map(\.0) == ["device.acquireControl", "device.renewControl", "device.releaseControl"])
        #expect(server.calls[2].1.objectValue?["generation"] == .number(7))
        #expect(server.calls.allSatisfy { $0.1.objectValue?["viewerId"] == .string(lease.viewerID) })
        await server.waitUntilClosed(1)
        #expect(server.opened == 1)
    }

    @Test func aRefusedRenewalEndsTheLease() async throws {
        let server = FakeDeviceControlServer()
        let lease = PathwayDeviceControlLease { server.connection() }
        server.respond = { _, _ in self.control(7, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        server.respond = { _, _ in throw PathwayRPCError.deviceControl(code: "stale_generation", message: "") }
        await lease.renew()
        #expect(lease.proof == nil)
        #expect(server.closed == 1)
        // Nothing is held, so release has nothing to send.
        try await lease.release()
        #expect(server.calls.count == 2)
    }

    @Test func aNewGrantReconnectsTheStreamWithItsProof() async {
        let controller = PathwayDeviceStreamController { self.prepared() }
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        #expect(controller.configuration?["control"] is NSNull)
        controller.setInput(enabled: true, proof: PathwayDeviceControlProof(viewerID: "me", generation: 4))
        #expect(controller.configuration?["inputEnabled"] as? Bool == true)
        #expect((controller.configuration?["control"] as? [String: Any])?["generation"] as? Int == 4)
        controller.setInput(enabled: false, proof: nil)
        #expect(controller.configuration?["inputEnabled"] as? Bool == false)
        #expect(controller.configuration?["control"] is NSNull)
    }

    @Test func buildsHubAccessFromTheConnectionTicket() throws {
        let expires = Date(timeIntervalSince1970: 1_300)
        let access = try #require(PathwayDeviceHubAccess.make(
            httpBaseURL: URL(string: "https://relay.example/env/abc/")!,
            webSocketURL: URL(string: "wss://relay.example/env/abc/ws?wsTicket=ticket-1")!,
            hubBasePath: "/api/device-hub", hostID: "ssh-mini", expiresAt: expires))
        #expect(access["httpBase"] as? String == "https://relay.example/api/device-hub")
        #expect(access["wsBase"] as? String == "wss://relay.example/api/device-hub")
        #expect(access["query"] as? [String: String] == ["wsTicket": "ticket-1", "hostId": "ssh-mini"])
        #expect(access["credentials"] as? Bool == false)
        #expect(access["expiresAt"] as? Double == 1_300_000)

        let local = try #require(PathwayDeviceHubAccess.make(
            httpBaseURL: URL(string: "http://192.168.1.4:3773")!, webSocketURL: URL(string: "ws://192.168.1.4:3773/ws?wsTicket=t")!,
            hubBasePath: "/api/device-hub", hostID: "local", expiresAt: expires))
        #expect(local["wsBase"] as? String == "ws://192.168.1.4:3773/api/device-hub")
        #expect(PathwayDeviceHubAccess.origin(URL(string: "https://relay.example/env/abc/?x=1")!)?.absoluteString == "https://relay.example/")
    }

    @Test func refusesAccessWithoutATicket() {
        #expect(PathwayDeviceHubAccess.make(httpBaseURL: URL(string: "https://env.example")!, webSocketURL: URL(string: "wss://env.example/ws")!,
                                            hubBasePath: "/api/device-hub", hostID: "local", expiresAt: .now) == nil)
    }

    @Test func pageAllowsOnlyItsOwnOrigin() {
        let html = PathwayDeviceStreamWebView.html(origin: URL(string: "https://env.example:8443/")!)
        #expect(html.contains("connect-src https://env.example:8443 wss://env.example:8443;"))
        #expect(html.contains("script-src 'none'"))
    }

    private let iPhone = PathwayThreadDevicePreview(hostID: "local", deviceID: "UDID-1", platform: "ios", name: "iPhone 17", detail: "")
    private let pixel = PathwayThreadDevicePreview(hostID: "local", deviceID: "emulator-5554", platform: "android", name: "Pixel", detail: "")

    private func prepared(ticket: String = "ticket", expiresAt: Date? = nil) -> PathwayPreparedEnvironmentConnection {
        .init(environmentID: "environment", label: "Mac", httpBaseURL: URL(string: "https://env.example")!,
              webSocketURL: URL(string: "wss://env.example/ws?wsTicket=\(ticket)")!, accessToken: "token",
              proofKeyThumbprint: "thumbprint", scopes: [], ticketExpiresAt: expiresAt)
    }

    @Test func refreshesCredentialsABoundedNumberOfTimesUntilTheStreamConnects() async {
        var clock = Date(timeIntervalSince1970: 1_000)
        let connection = prepared(expiresAt: Date(timeIntervalSince1970: 1_300))
        let controller = PathwayDeviceStreamController(now: { clock }) { connection }
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        let page = controller.page
        // However slowly each rejection arrives, a failing sequence refreshes at most `maxRefreshes` times.
        for _ in 0..<PathwayDeviceStreamController.maxRefreshes {
            clock += 60
            #expect(controller.received(["type": "unauthorized"], page: page))
            await controller.start(iPhone, hubBasePath: "/api/device-hub", refreshingCredentials: true).value
        }
        #expect(!controller.received(["type": "unauthorized"], page: page))
        #expect(controller.status == .failed(PathwayDeviceStreamController.rejectedMessage))

        // An explicit retry starts a new sequence; a working stream refills it.
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        #expect(controller.received(["type": "unauthorized"], page: page))
        await controller.start(iPhone, hubBasePath: "/api/device-hub", refreshingCredentials: true).value
        _ = controller.received(["type": "status", "status": "streaming"], page: page)
        _ = controller.received(["type": "input", "connected": true], page: page)
        #expect(controller.status == .streaming)
        for _ in 0..<PathwayDeviceStreamController.maxRefreshes {
            #expect(controller.received(["type": "unauthorized"], page: page))
            await controller.start(iPhone, hubBasePath: "/api/device-hub", refreshingCredentials: true).value
        }
        // Past the ticket's real expiry the failure reads as expiry.
        clock = Date(timeIntervalSince1970: 2_000)
        #expect(!controller.received(["type": "unauthorized"], page: page))
        #expect(controller.status == .failed(PathwayDeviceStreamController.expiredMessage))
    }

    @Test func usesTheInputPermissionCurrentWhenTheTicketArrives() async {
        let gate = DevicePrepareGate()
        let controller = PathwayDeviceStreamController { try await gate.prepare() }
        controller.setInputEnabled(true)
        let pending = controller.start(iPhone, hubBasePath: "/api/device-hub")
        await gate.waitUntilPending(1)
        #expect(controller.configuration == nil)
        // The agent starts a run while the ticket is minted.
        controller.setInputEnabled(false)
        gate.release(prepared())
        await pending.value
        #expect(controller.configuration?["inputEnabled"] as? Bool == false)
        #expect(controller.configuration?["deviceId"] as? String == "UDID-1")
    }

    @Test func aSupersededTicketNeverStartsTheOldDevice() async {
        let gate = DevicePrepareGate()
        let controller = PathwayDeviceStreamController { try await gate.prepare() }
        let first = controller.start(iPhone, hubBasePath: "/api/device-hub")
        await gate.waitUntilPending(1)
        let second = controller.start(pixel, hubBasePath: "/api/device-hub")
        await gate.waitUntilPending(2)
        // The first request ignores cancellation and returns after the switch.
        gate.release(prepared(ticket: "late"))
        await first.value
        #expect(controller.configuration == nil)
        gate.release(prepared(ticket: "current"))
        await second.value
        #expect(controller.configuration?["deviceId"] as? String == "emulator-5554")
        #expect((controller.configuration?["access"] as? [String: Any])?["query"] as? [String: String]
            == ["wsTicket": "current", "hostId": "local"])
    }

    @Test func reconnectAfterTheViewerStopsLoadsANewPage() async {
        let connection = prepared()
        let controller = PathwayDeviceStreamController { connection }
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        let first = controller.page
        #expect(controller.origin?.absoluteString == "https://env.example/")
        controller.didLoad(page: first)

        // Rotating credentials keeps the page.
        await controller.start(iPhone, hubBasePath: "/api/device-hub", refreshingCredentials: true).value
        #expect(controller.page == first)

        // WebKit terminates the page's content process.
        controller.failed("The device viewer stopped.", page: first)
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        #expect(controller.page != first)
        #expect(controller.status == .connecting)
        // The terminated page's late callbacks change nothing.
        _ = controller.received(["type": "status", "status": "streaming"], page: first)
        controller.failed("late", page: first)
        #expect(controller.status == .connecting)
        _ = controller.received(["type": "status", "status": "streaming"], page: controller.page)
        #expect(controller.status == .streaming)
    }

    @Test func resumingHandsTheDeviceBackWithAFollowUp() async throws {
        var dispatched: [String: JSONValue] = [:]
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let model = PathwayAgentThreadModel(thread: thread, environment: environment, request: { method, payload in
            if method == "orchestration.dispatchCommand" { dispatched = payload.objectValue ?? [:] }
            return .object([:])
        })
        model.installSnapshot(.object(["thread": .object(["id": .string(thread.threadId)]), "runs": .array([]), "visibleTurnItems": .array([])]))
        try await model.resumeAfterDeviceControl("  ")
        #expect(dispatched["type"] == .string("message.dispatch"))
        #expect(dispatched["text"] == .string(PathwayDeviceControl.defaultResumeMessage))
        #expect(dispatched["creationSource"] == .string("mobile"))
        #expect(dispatched["dispatchMode"]?.objectValue?["type"] == .string("start_immediately"))
    }
}

/// Holds ticket requests until the test releases them, oldest first.
@MainActor private final class DevicePrepareGate {
    private var pending: [CheckedContinuation<PathwayPreparedEnvironmentConnection, Error>] = []

    func prepare() async throws -> PathwayPreparedEnvironmentConnection {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func waitUntilPending(_ count: Int) async {
        while pending.count < count { await Task.yield() }
    }
    func release(_ connection: PathwayPreparedEnvironmentConnection) {
        pending.removeFirst().resume(returning: connection)
    }
}

/// Answers device control RPCs and counts the connections the lease opens and closes.
@MainActor private final class FakeDeviceControlServer {
    var respond: (String, JSONValue) throws -> JSONValue = { _, _ in .null }
    private(set) var calls: [(String, JSONValue)] = []
    private(set) var opened = 0
    private(set) var closed = 0

    func connection() -> PathwayDeviceControlLease.Connection {
        opened += 1
        return .init(request: { tag, payload in try await self.handle(tag, payload) }, close: { await self.close() })
    }
    func waitUntilClosed(_ count: Int) async {
        while closed < count { await Task.yield() }
    }
    private func handle(_ tag: String, _ payload: JSONValue) throws -> JSONValue {
        calls.append((tag, payload))
        return try respond(tag, payload)
    }
    private func close() { closed += 1 }
}
