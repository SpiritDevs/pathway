import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayAdministrationSettingsTests {
    private var settings: JSONValue {
        .object([
            "enableProviderUpdateChecks": .bool(true),
            "defaultThreadEnvMode": .string("local"),
            "newWorktreesStartFromOrigin": .bool(true),
            "addProjectBaseDirectory": .string("/repos"),
            "textGenerationModelSelection": .object(["instanceId": .string("codex"), "model": .string("m"), "options": .array([.object(["id": .string("effort"), "value": .string("high")])])]),
            "sourceControlWritingStyle": .object(["mode": .string("custom"), "customInstructions": .string("Keep concise"), "followChangeRequestTemplates": .bool(true)]),
            "backgroundActivity": .object(["profile": .string("custom"), "baseProfile": .string("balanced"), "overrides": .object(["automaticGitFetchInterval": .number(90_000), "pauseWhenHostLocked": .bool(false)])]),
            "providerInstances": .object(["opaque": .object(["secret": .string("redacted")])])
        ])
    }

    @Test func unchangedSettingsHaveNoPatchAndKeepOpaqueModels() throws {
        let draft = PathwayAdministrationSettingsDraft(settings)
        #expect(try draft.patch().isEmpty)
        #expect(draft.textModel == settings.objectValue?["textGenerationModelSelection"])
        #expect(draft.gitFetchSeconds == 90)
        #expect(draft.providerHealthSeconds == 300)
    }

    @Test func writingChangesUseOnlyChangedLeaves() throws {
        var draft = PathwayAdministrationSettingsDraft(settings)
        draft.followTemplates = false
        #expect(try draft.patch() == ["sourceControlWritingStyle": .object(["followChangeRequestTemplates": .bool(false)])])
    }

    @Test func intervalChangesUseAtomicServerMergeLeavesInMilliseconds() throws {
        var draft = PathwayAdministrationSettingsDraft(settings)
        draft.gitFetchSeconds = 0
        #expect(try draft.patch() == ["automaticGitFetchInterval": .number(0)])
        draft.providerHealthSeconds = 60
        #expect(try draft.patch()["providerHealthRefreshInterval"] == .number(60_000))
        #expect(try draft.patch()["backgroundActivity"] == nil)
    }

    @Test func selectingPresetResetsCustomPolicyWithoutSendingOldOverrides() throws {
        var draft = PathwayAdministrationSettingsDraft(settings)
        draft.selectBackgroundProfile("battery-saver")
        #expect(draft.gitFetchSeconds == 0)
        #expect(draft.providerHealthSeconds == 900)
        #expect(try draft.patch() == ["backgroundActivityProfile": .string("battery-saver")])
    }

    @Test func advancedHostEditPreservesFreshConcurrentOverride() throws {
        var draft = PathwayAdministrationSettingsDraft(settings)
        draft.setHostValue(.battery, value: .bool(true))
        var latest = settings.objectValue ?? [:]
        latest["backgroundActivity"] = .object(["profile": .string("custom"), "baseProfile": .string("performance"), "overrides": .object(["automaticGitFetchInterval": .number(120_000), "pauseWhenHostLocked": .bool(false), "idleClientTtl": .number(80_000)])])
        let patch = try draft.patch(latest: .object(latest))
        let background = patch["backgroundActivity"]?.objectValue
        #expect(background?["baseProfile"] == .string("performance"))
        #expect(background?["overrides"] == .object(["automaticGitFetchInterval": .number(120_000), "pauseWhenHostLocked": .bool(false), "idleClientTtl": .number(80_000), "pauseWhenOnBattery": .bool(true)]))
        #expect(patch["providerInstances"] == nil)
    }

    @Test func invalidIntervalsAndIncompleteModelsCannotBeSaved() {
        var draft = PathwayAdministrationSettingsDraft(settings)
        draft.gitFetchSeconds = -.infinity
        #expect(throws: (any Error).self) { try draft.patch() }
        draft.gitFetchSeconds = 90
        draft.textModel = .object(["instanceId": .string("codex"), "model": .string("")])
        #expect(throws: (any Error).self) { try draft.patch() }
    }

    @Test func sourceControlDiscoveryDecodesEffectOptionsAndUnavailableDrivers() throws {
        let json = #"{"versionControlSystems":[{"kind":"jj","label":"Jujutsu","implemented":false,"status":"missing","version":{"_tag":"None"},"installHint":"Install jj","detail":{"_tag":"Some","value":"Missing tool"}}],"sourceControlProviders":[{"kind":"github","label":"GitHub","status":"available","version":{"_tag":"Some","value":"2.0"},"installHint":"Install gh","detail":{"_tag":"None"},"auth":{"status":"unauthenticated","account":{"_tag":"None"},"host":{"_tag":"Some","value":"github.com"},"detail":{"_tag":"Some","value":"Run gh auth login on the host"}}}]}"#
        let discovery = try JSONDecoder().decode(PathwaySourceControlDiscovery.self, from: Data(json.utf8))
        #expect(discovery.versionControlSystems.first?.implemented == false)
        #expect(PathwaySourceControlDiscovery.option(discovery.versionControlSystems.first?.version) == nil)
        #expect(PathwaySourceControlDiscovery.option(discovery.sourceControlProviders.first?.auth?.detail) == "Run gh auth login on the host")
    }
}
