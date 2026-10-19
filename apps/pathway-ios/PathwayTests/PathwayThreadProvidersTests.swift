import Foundation
@testable import Pathway
import Testing
import UIKit

@MainActor
struct PathwayThreadProvidersTests {
    @Test func usesConfiguredDriverInsteadOfInstanceName() {
        let providers = PathwayThreadProviders()
        let thread = makeAgentThread()
        providers.apply(event(driver: "claudeAgent"), environmentID: "other-company:environment-1")
        #expect(providers.provider(for: thread) == nil)
        providers.apply(event(driver: "claudeAgent"), environmentID: "company-1:environment-1")
        #expect(providers.provider(for: thread)?.iconAssetName == "provider-claude")
        #expect(providers.provider(for: thread)?.name == "Work provider")
        providers.apply(event(driver: "cursor", type: "configUpdated"), environmentID: "company-1:environment-1")
        #expect(providers.provider(for: thread)?.iconAssetName == "provider-cursor")
    }

    @Test func supportsBuiltInLogosAndUnknownDrivers() {
        for driver in ["codex", "claudeAgent", "cursor", "grok", "opencode"] {
            let provider = PathwayThreadProvider(driver: driver, name: driver)
            #expect(provider.iconAssetName.flatMap { UIImage(named: $0) } != nil)
        }
        #expect(PathwayThreadProvider(driver: "custom", name: "Custom").iconAssetName == nil)
    }

    @Test func ignoresOtherEventsAndRemovesDeletedInstances() {
        let providers = PathwayThreadProviders()
        providers.apply(event(driver: "codex"), environmentID: "company-1:environment-1")
        providers.apply(.object(["type": .string("settingsUpdated")]), environmentID: "company-1:environment-1")
        #expect(providers.provider(for: makeAgentThread()) != nil)
        providers.apply(.object([
            "type": .string("providerStatuses"),
            "payload": .object(["providers": .array([])])
        ]), environmentID: "company-1:environment-1")
        #expect(providers.provider(for: makeAgentThread()) == nil)
    }

    private func event(driver: String, type: String = "snapshot") -> JSONValue {
        .object([
            "type": .string(type),
            type == "snapshot" ? "config" : "payload": .object([
                "providers": .array([.object([
                    "instanceId": .string("codex-work"),
                    "driver": .string(driver),
                    "displayName": .string("Work provider"),
                    "enabled": .bool(false)
                ])])
            ])
        ])
    }
}
