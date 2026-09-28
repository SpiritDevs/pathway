import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayEnvironmentUpdateTests {
    @Test func checkShowsAvailableVersionAndNotes() async {
        let model = updates(capabilities: ["serverSelfUpdate": .string("boot-service")]) { method, _ in
            #expect(method == "server.checkForUpdate")
            return self.check(available: "1.1.0")
        }
        await model.checkNow()
        #expect(model.availableVersion == "1.1.0")
        #expect(model.check?.releaseNotes.first?.items == ["Faster thread list"])
        #expect(model.canUpdate)
        #expect(model.updateHint == nil)
    }

    @Test func manualServersOfferNotesButNotUpdate() async {
        let model = updates(capabilities: [:]) { _, _ in self.check(available: "1.1.0") }
        await model.checkNow()
        #expect(!model.canUpdate)
        #expect(model.updateHint?.contains("pathway service install") == true)
        await model.update()
        #expect(model.version == "1.0.0")
    }

    @Test func desktopUpdateTreatsCommitDisconnectAsHandoffThenConfirmsVersion() async {
        var calls: [String] = []
        var restarted = false
        let model = updates(capabilities: ["serverSelfUpdate": .string("desktop-managed"), "desktopAppUpdate": .bool(true)]) { method, fields in
            calls.append(method)
            switch method {
            case "server.checkForUpdate": return self.check(available: "1.1.0")
            case "server.updateServer":
                #expect(fields["targetVersion"] == .string("1.1.0"))
                return .object(["targetVersion": .string("1.1.0"), "method": .string("desktop-app"), "desktopUpdateToken": .string("token")])
            case "server.commitDesktopUpdate":
                #expect(fields["requestId"] == .string("token"))
                restarted = true
                throw PathwayRPCError.disconnected
            default:
                return self.config(version: restarted ? "1.1.0" : "1.0.0")
            }
        }
        await model.checkNow()
        await model.update()
        #expect(calls == ["server.checkForUpdate", "server.updateServer", "server.commitDesktopUpdate", "server.getConfig"])
        #expect(model.version == "1.1.0")
        #expect(model.availableVersion == nil)
        #expect(model.message == "Updated to 1.1.0")
        #expect(model.error == nil)
    }

    private func updates(capabilities: [String: JSONValue],
                         request: @escaping @MainActor (String, [String: JSONValue]) async throws -> JSONValue) -> PathwayEnvironmentUpdateModel {
        let environment = PathwayCompanyEnvironment(companyId: "company", environment: PathwayEnvironment(id: "environment", environmentId: "environment",
            descriptor: PathwayEnvironmentDescriptor(environmentId: "environment", label: "Mac", serverVersion: "1.0.0", capabilities: capabilities),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        let client = PathwayAdministrationClient(environment: environment,
            request: { _, method, payload, _ in try await request(method, payload.objectValue ?? [:]) },
            http: { _, _, _, _ in .null })
        return PathwayEnvironmentUpdateModel(client: client, pause: { _ in })
    }

    private func check(available: String?) -> JSONValue {
        .object([
            "currentVersion": .string("1.0.0"),
            "availableVersion": available.map(JSONValue.string) ?? .null,
            "releaseNotes": .array([.object(["version": .string("1.1.0"), "items": .array([.string("Faster thread list")])])]),
        ])
    }

    private func config(version: String) -> JSONValue {
        .object(["providers": .array([]), "cwd": .string("/"),
                 "environment": .object(["label": .string("Mac"), "serverVersion": .string(version)])])
    }
}
