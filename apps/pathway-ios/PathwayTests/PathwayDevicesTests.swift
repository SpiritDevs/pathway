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

    @Test func inputWaitsForTheInterruptedRunToStop() {
        // A disconnected thread may still be running, so the viewer only watches.
        #expect(PathwayDeviceControl.resolve(runStateKnown: false, activeRunID: nil, interruptedRunID: nil) == .unknown)
        #expect(PathwayDeviceControl.resolve(runStateKnown: false, activeRunID: nil, interruptedRunID: "run-1") == .unknown)
        #expect(PathwayDeviceControl.resolve(runStateKnown: true, activeRunID: "run-1", interruptedRunID: nil) == .agent)
        // An accepted interrupt is not control until the run stops.
        #expect(PathwayDeviceControl.resolve(runStateKnown: true, activeRunID: "run-1", interruptedRunID: "run-1") == .stopping)
        #expect(PathwayDeviceControl.resolve(runStateKnown: true, activeRunID: nil, interruptedRunID: "run-1") == .user)
        #expect(PathwayDeviceControl.resolve(runStateKnown: true, activeRunID: nil, interruptedRunID: nil) == .idle)
        // A new run takes the device back.
        #expect(PathwayDeviceControl.resolve(runStateKnown: true, activeRunID: "run-2", interruptedRunID: "run-1") == .agent)
        #expect([PathwayDeviceControl.unknown, .agent, .stopping].allSatisfy { !$0.acceptsInput })
        #expect([PathwayDeviceControl.user, .idle].allSatisfy { $0.acceptsInput })
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
