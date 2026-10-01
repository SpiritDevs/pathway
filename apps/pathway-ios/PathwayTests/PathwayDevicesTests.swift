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
        let all: [PathwayDeviceControl] = [.unknown, .taking, .you, .agent, .viewer, .nobody, .finishing, .unsupported]
        #expect(all.filter { $0.acceptsInput } == [.you])
    }

    @Test func environmentsWithoutLeasesOnlyWatch() throws {
        let unleased = try #require(state(sessions: [session("thread-1", device: "UDID-1", openedAt: "2026-01-01T00:00:00Z")]))
        #expect(!unleased.supportsDeviceControl)
        let held = PathwayDeviceControlState(control(4, "held", owner: viewer("me")))
        for acquiring in [false, true] {
            #expect(PathwayDeviceControl.resolve(unleased, hostID: "local", deviceID: "UDID-1", viewerID: "me",
                                                 lease: held, acquiring: acquiring) == .unsupported)
        }
        #expect(!PathwayDeviceControl.unsupported.acceptsInput)
        #expect(!PathwayDeviceControl.unsupported.canTake)
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
        let lease = server.lease()
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
        let lease = server.lease()
        server.respond = { _, _ in self.control(7, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        server.respond = { _, _ in throw PathwayRPCError.deviceControl(code: "stale_generation", message: "") }
        await lease.renew()
        #expect(lease.proof == nil)
        #expect(server.closed == 1)
        #expect(lease.notice == PathwayDeviceControl.message(for: PathwayRPCError.deviceControl(code: "stale_generation", message: "")))
        // Nothing is held, so release has nothing to send.
        try await lease.release()
        #expect(server.calls.count == 2)
    }

    @Test func losingTheConnectionEndsTheLease() async throws {
        let server = FakeDeviceControlServer()
        let lease = server.lease()
        server.respond = { _, _ in self.control(7, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        // A renewal that can't reach the environment is not transient: the socket's leases are gone.
        server.respond = { _, _ in throw PathwayRPCError.disconnected }
        await lease.renew()
        #expect(lease.proof == nil)
        #expect(lease.notice == PathwayDeviceControl.lostConnectionMessage)

        // A socket that closes on its own ends the lease without any request failing.
        lease.notice = nil
        server.respond = { _, _ in self.control(9, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        #expect(lease.proof?.generation == 9)
        server.dropSocket()
        while lease.proof != nil { await Task.yield() }
        #expect(lease.notice == PathwayDeviceControl.lostConnectionMessage)
        #expect(lease.target == nil)

        // Device state that stops being live ends it too.
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        await lease.invalidate()
        #expect(lease.proof == nil)
        await server.waitUntilClosed(3)
    }

    @Test func releasingWhileTakingControlHandsTheLateGrantBack() async throws {
        let server = FakeDeviceControlServer()
        let lease = server.lease()
        server.holdsAcquire = true
        server.respond = { tag, _ in
            tag == "device.releaseControl" ? self.control(8, "idle") : self.control(7, "held", owner: self.viewer(lease.viewerID))
        }
        let taking = Task { try await lease.acquire(hostID: "local", deviceID: "UDID-1") }
        await server.waitUntilAcquiring()
        #expect(lease.acquiring)
        #expect(lease.target == .init(hostID: "local", deviceID: "UDID-1"))
        // The viewer is hidden or switches devices while the previous owner's input finishes.
        try await lease.release()
        #expect(!lease.acquiring)
        #expect(lease.target == nil)
        server.grant()
        try await taking.value
        #expect(lease.proof == nil)
        #expect(server.calls.map(\.0) == ["device.acquireControl", "device.releaseControl"])
        #expect(server.calls[1].1.objectValue?["generation"] == .number(7))
        #expect(server.closed == 1)
    }

    @Test func aRefusedReleaseIsNotAHandBack() async throws {
        let server = FakeDeviceControlServer()
        let lease = server.lease()
        server.respond = { _, _ in self.control(7, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        server.respond = { _, _ in throw PathwayRPCError.deviceControl(code: "input_unconfirmed", message: "") }
        do {
            try await lease.release()
            Issue.record("The refused release was reported as acknowledged.")
        } catch {
            #expect(PathwayDeviceControl.needsToolRestart(error))
        }
        // Input stops either way.
        #expect(lease.proof == nil)
        await server.waitUntilClosed(1)
    }

    @Test func mutationsAndStreamTicketsUseTheLeasesSession() async throws {
        let server = FakeDeviceControlServer()
        let lease = server.lease()
        // Without a lease, mutations are refused locally and the stream watches on its own session.
        await #expect(throws: PathwayRPCError.self) { try await lease.request("device.close", [:]) }
        #expect(try await lease.ticketed().accessToken == "watching")
        server.respond = { _, _ in self.control(7, "held", owner: self.viewer(lease.viewerID)) }
        try await lease.acquire(hostID: "local", deviceID: "UDID-1")
        #expect(try await lease.ticketed().accessToken == "lease")
        _ = try await lease.request("device.close", ["hostId": .string("local"), "deviceId": .string("UDID-1")])
        #expect(server.calls.last?.0 == "device.close")
        #expect(server.calls.last?.1.objectValue?["control"] == PathwayDeviceControlProof(viewerID: lease.viewerID, generation: 7).json)
        #expect(server.opened == 1)

        // A session that can no longer mint tickets ends the lease.
        server.ticketFails = true
        await #expect(throws: PathwayConnectError.self) { try await lease.ticketed() }
        #expect(lease.proof == nil)
        #expect(lease.notice == PathwayDeviceControl.lostConnectionMessage)
    }

    @Test func aSessionOpensOnceAndRefreshesTicketsWithinIt() async throws {
        let counter = DeviceSessionCounter()
        let session = PathwayDeviceEnvironmentSession(
            open: { await counter.open() },
            refresh: { connection in await counter.refresh(connection) }
        )
        async let first = session.ticketed()
        async let second = session.ticketed()
        let tickets = try await [first, second].map(\.webSocketURL.query)
        let third = try await session.ticketed()
        #expect(await counter.opened == 1)
        #expect(Set(tickets) == ["wsTicket=opened", "wsTicket=refreshed-1"])
        #expect(third.webSocketURL.query == "wsTicket=refreshed-2")
        #expect(third.accessToken == "session-token")
    }

    @Test func aNewGrantReconnectsTheStreamWithItsProof() async {
        var minted = 0
        let controller = PathwayDeviceStreamController { minted += 1; return self.prepared(ticket: "ticket-\(minted)") }
        await controller.start(iPhone, hubBasePath: "/api/device-hub").value
        #expect(controller.configuration?["control"] is NSNull)
        // The input socket needs a ticket from the session that holds the lease, not the watching one.
        controller.setInput(enabled: true, proof: PathwayDeviceControlProof(viewerID: "me", generation: 4))
        while controller.configuration == nil { await Task.yield() }
        #expect(minted == 2)
        #expect((controller.configuration?["access"] as? [String: Any])?["query"] as? [String: String]
            == ["wsTicket": "ticket-2", "hostId": "local"])
        #expect(controller.configuration?["inputEnabled"] as? Bool == true)
        #expect((controller.configuration?["control"] as? [String: Any])?["generation"] as? Int == 4)
        // Renewals keep the proof and the stream.
        controller.setInput(enabled: true, proof: PathwayDeviceControlProof(viewerID: "me", generation: 4))
        #expect(minted == 2)
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

/// Opens one fake environment session and refreshes tickets within it.
private actor DeviceSessionCounter {
    private(set) var opened = 0
    private var refreshed = 0

    func open() async -> PathwayPreparedEnvironmentConnection {
        opened += 1
        await Task.yield()
        return Self.connection(ticket: "opened")
    }
    func refresh(_ connection: PathwayPreparedEnvironmentConnection) -> PathwayPreparedEnvironmentConnection {
        refreshed += 1
        return Self.connection(ticket: "refreshed-\(refreshed)", token: connection.accessToken)
    }
    static func connection(ticket: String, token: String = "session-token") -> PathwayPreparedEnvironmentConnection {
        .init(environmentID: "environment", label: "Mac", httpBaseURL: URL(string: "https://env.example")!,
              webSocketURL: URL(string: "wss://env.example/ws?wsTicket=\(ticket)")!, accessToken: token,
              proofKeyThumbprint: "thumbprint", scopes: [], ticketExpiresAt: nil)
    }
}

/// Answers device control RPCs and counts the connections the lease opens and closes.
@MainActor private final class FakeDeviceControlServer {
    var respond: (String, JSONValue) throws -> JSONValue = { _, _ in .null }
    /// Holds acquire requests until `grant`, like an environment waiting for the previous owner's input.
    var holdsAcquire = false
    var ticketFails = false
    private(set) var calls: [(String, JSONValue)] = []
    private(set) var opened = 0
    private(set) var closed = 0
    private var held: CheckedContinuation<Void, Never>?
    private var socket: CheckedContinuation<Void, Never>?

    func lease() -> PathwayDeviceControlLease {
        PathwayDeviceControlLease(watching: { DeviceSessionCounter.connection(ticket: "watching", token: "watching") }) { self.connection() }
    }
    func connection() -> PathwayDeviceControlLease.Connection {
        opened += 1
        return .init(
            request: { tag, payload in try await self.handle(tag, payload) },
            ticketed: { try await self.ticket() },
            closed: { await self.waitForSocket() },
            close: { await self.close() }
        )
    }
    func waitUntilClosed(_ count: Int) async {
        while closed < count { await Task.yield() }
    }
    func waitUntilAcquiring() async {
        while held == nil { await Task.yield() }
    }
    func grant() { held?.resume(); held = nil }
    func dropSocket() { socket?.resume(); socket = nil }

    private func handle(_ tag: String, _ payload: JSONValue) async throws -> JSONValue {
        calls.append((tag, payload))
        if tag == "device.acquireControl", holdsAcquire { await withCheckedContinuation { held = $0 } }
        return try respond(tag, payload)
    }
    private func ticket() throws -> PathwayPreparedEnvironmentConnection {
        if ticketFails { throw PathwayConnectError.response(status: 401, message: "expired", traceID: nil) }
        return DeviceSessionCounter.connection(ticket: "lease", token: "lease")
    }
    private func waitForSocket() async {
        await withCheckedContinuation { socket = $0 }
    }
    private func close() {
        closed += 1
        dropSocket()
    }
}
