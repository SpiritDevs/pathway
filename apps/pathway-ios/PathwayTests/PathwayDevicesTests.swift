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

    @Test func controlFollowsTheRunUntilTheUserTakesIt() {
        #expect(PathwayDeviceControl.resolve(agentRunning: true, activeRunID: "run-1", tookControl: false, takenFromRunID: nil) == .agent)
        #expect(PathwayDeviceControl.resolve(agentRunning: true, activeRunID: "run-1", tookControl: true, takenFromRunID: "run-1") == .user)
        #expect(PathwayDeviceControl.resolve(agentRunning: false, activeRunID: nil, tookControl: true, takenFromRunID: "run-1") == .user)
        #expect(PathwayDeviceControl.resolve(agentRunning: false, activeRunID: nil, tookControl: false, takenFromRunID: nil) == .idle)
        // A new run takes the device back.
        #expect(PathwayDeviceControl.resolve(agentRunning: true, activeRunID: "run-2", tookControl: true, takenFromRunID: "run-1") == .agent)
        #expect(!PathwayDeviceControl.agent.acceptsInput)
        #expect(PathwayDeviceControl.idle.acceptsInput)
    }

    @Test func buildsHubAccessFromTheConnectionTicket() throws {
        let minted = Date(timeIntervalSince1970: 1_000)
        let access = try #require(PathwayDeviceHubAccess.make(
            httpBaseURL: URL(string: "https://relay.example/env/abc/")!,
            webSocketURL: URL(string: "wss://relay.example/env/abc/ws?wsTicket=ticket-1")!,
            hubBasePath: "/api/device-hub", hostID: "ssh-mini", mintedAt: minted))
        #expect(access["httpBase"] as? String == "https://relay.example/api/device-hub")
        #expect(access["wsBase"] as? String == "wss://relay.example/api/device-hub")
        #expect(access["query"] as? [String: String] == ["wsTicket": "ticket-1", "hostId": "ssh-mini"])
        #expect(access["credentials"] as? Bool == false)
        #expect(access["expiresAt"] as? Double == (1_000 + PathwayDeviceHubAccess.ticketLifetime) * 1000)

        let local = try #require(PathwayDeviceHubAccess.make(
            httpBaseURL: URL(string: "http://192.168.1.4:3773")!, webSocketURL: URL(string: "ws://192.168.1.4:3773/ws?wsTicket=t")!,
            hubBasePath: "/api/device-hub", hostID: "local", mintedAt: minted))
        #expect(local["wsBase"] as? String == "ws://192.168.1.4:3773/api/device-hub")
        #expect(PathwayDeviceHubAccess.origin(URL(string: "https://relay.example/env/abc/?x=1")!)?.absoluteString == "https://relay.example/")
    }

    @Test func refusesAccessWithoutATicket() {
        #expect(PathwayDeviceHubAccess.make(httpBaseURL: URL(string: "https://env.example")!, webSocketURL: URL(string: "wss://env.example/ws")!,
                                            hubBasePath: "/api/device-hub", hostID: "local", mintedAt: .now) == nil)
    }

    @Test func pageAllowsOnlyItsOwnOrigin() {
        let html = PathwayDeviceStreamWebView.html(origin: URL(string: "https://env.example:8443/")!)
        #expect(html.contains("connect-src https://env.example:8443 wss://env.example:8443;"))
        #expect(html.contains("script-src 'none'"))
    }

    @Test func refreshesAnExpiredTicketButNotAFreshRejection() {
        let controller = PathwayDeviceStreamController()
        #expect(controller.received(["type": "unauthorized"]))
        #expect(!controller.received(["type": "input", "connected": true]))
        #expect(controller.inputConnected)
        _ = controller.received(["type": "status", "status": "streaming"])
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
