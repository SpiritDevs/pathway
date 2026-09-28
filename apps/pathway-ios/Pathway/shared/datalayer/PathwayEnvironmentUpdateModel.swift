import Foundation
import Observation

struct PathwayServerUpdateCheck: Decodable, Equatable {
    let currentVersion: String
    let availableVersion: String?
    let releaseNotes: [ReleaseNote]
    struct ReleaseNote: Decodable, Equatable, Identifiable {
        let version: String
        let items: [String]
        var id: String { version }
    }
}

struct PathwayServerUpdateResult: Decodable {
    let targetVersion: String
    let method: String
    let desktopUpdateToken: String?
}

/// Version, update check, and remote update for one environment's settings screen.
@MainActor
@Observable
final class PathwayEnvironmentUpdateModel {
    enum Phase: Equatable { case idle, checking, updating }

    private(set) var version: String
    private(set) var check: PathwayServerUpdateCheck?
    private(set) var phase: Phase = .idle
    private(set) var message: String?
    private(set) var error: String?
    private var capabilities: [String: JSONValue]?
    @ObservationIgnored private let client: PathwayAdministrationClient
    @ObservationIgnored private let pause: @Sendable (Duration) async throws -> Void
    /// A desktop install downloads before handing off, and a service restart can take minutes.
    nonisolated static let prepareTimeout: Duration = .seconds(25 * 60)
    nonisolated static let restartTimeout: Duration = .seconds(5 * 60)

    init(client: PathwayAdministrationClient,
         pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.client = client
        self.pause = pause
        version = client.environment.environment.descriptor.serverVersion
        capabilities = client.environment.environment.descriptor.capabilities
    }

    var availableVersion: String? { check?.availableVersion }

    /// Desktop builds update through the desktop app; other servers need the background service.
    var canUpdate: Bool {
        switch capabilities?["serverSelfUpdate"]?.stringValue {
        case "boot-service", "respawn": true
        case "desktop-managed": capabilities?["desktopAppUpdate"]?.boolValue == true
        default: false
        }
    }

    var updateHint: String? {
        guard availableVersion != nil, !canUpdate else { return nil }
        return capabilities?["serverSelfUpdate"]?.stringValue == "desktop-managed"
            ? "Update the Pathway desktop app on this machine to update this environment."
            : "Run `pathway service install` on this machine to enable remote updates."
    }

    func refresh() async {
        guard let config: PathwayAdministrationConfig = try? await client.call("server.getConfig") else { return }
        version = config.environment.serverVersion
        if let latest = config.environment.capabilities { capabilities = latest }
    }

    func checkNow() async {
        guard phase == .idle else { return }
        phase = .checking; error = nil; message = nil
        defer { phase = .idle }
        do {
            let result: PathwayServerUpdateCheck = try await client.call("server.checkForUpdate", timeout: .seconds(150))
            check = result
            version = result.currentVersion
            if result.availableVersion == nil { message = "Up to date" }
        } catch { self.error = error.localizedDescription }
    }

    func update() async {
        guard phase == .idle, canUpdate, let target = availableVersion else { return }
        phase = .updating; error = nil; message = nil
        defer { phase = .idle }
        do {
            let result: PathwayServerUpdateResult = try await client.call(
                "server.updateServer", ["targetVersion": .string(target)], timeout: Self.prepareTimeout)
            if result.method == "desktop-app", let token = result.desktopUpdateToken {
                do {
                    _ = try await client.run("server.commitDesktopUpdate", ["requestId": .string(token)], timeout: .seconds(150))
                } catch PathwayRPCError.disconnected {
                    // A successful install stops this server, so losing it is the handoff.
                }
            }
            if try await awaitVersion(result.targetVersion) {
                check = nil
                message = "Updated to \(result.targetVersion)"
            } else {
                error = "The update started, but the environment has not come back on \(result.targetVersion) yet. It may still be restarting."
            }
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }

    /// Requests queue until the environment reconnects, so each attempt waits out most of a restart.
    private func awaitVersion(_ target: String) async throws -> Bool {
        let deadline = ContinuousClock.now + Self.restartTimeout
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            if let config: PathwayAdministrationConfig = try? await client.call("server.getConfig", timeout: .seconds(60)),
               config.environment.serverVersion == target {
                version = target
                if let latest = config.environment.capabilities { capabilities = latest }
                return true
            }
            try await pause(.seconds(2))
        }
        return false
    }
}
