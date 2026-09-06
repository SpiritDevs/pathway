import Foundation
import SwiftUI
import Testing
@testable import Pathway

@MainActor struct PathwayNativePreferencesTests {
    @Test func defaultKeyboardBindingsAreDistinctAndValid() {
        let bindings = PathwayKeyboardAction.allCases.map(\.defaultBinding)
        #expect(Set(bindings.map(\.display)).count == PathwayKeyboardAction.allCases.count)
        #expect(bindings.allSatisfy { $0.validationMessage == nil })
    }

    @Test func keyboardEditorRejectsConflictsTypingAndReservedEditingCommands() throws {
        let domain = "pathway-preferences-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = PathwayKeyboardPreferences(defaults: defaults)
        #expect(model.validationMessage(for: .newThreadDefault, action: .running) != nil)
        #expect(!model.update(.newThreadDefault, for: .running))
        #expect(!model.update(.init(key: "x"), for: .running))
        #expect(!model.update(.init(key: "c", command: true), for: .running))
        #expect(!model.update(.init(key: "ab", command: true), for: .running))
        #expect(!model.update(.init(key: "?", command: true), for: .running))
        #expect(model.binding(for: .running) == PathwayKeyboardAction.running.defaultBinding)
    }

    @Test func keyboardEditsNormalizePersistAndResetWithoutChangingOtherActions() throws {
        let domain = "pathway-preferences-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = PathwayKeyboardPreferences(defaults: defaults)
        #expect(model.update(.init(key: "K", command: true, option: true), for: .running))
        let restored = PathwayKeyboardPreferences(defaults: defaults)
        #expect(restored.binding(for: .running) == .init(key: "k", command: true, option: true))
        #expect(restored.binding(for: .newThread) == PathwayKeyboardAction.newThread.defaultBinding)
        restored.reset()
        #expect(PathwayKeyboardPreferences(defaults: defaults).binding(for: .running) == PathwayKeyboardAction.running.defaultBinding)
        restored.invoke(.attention)
        #expect(restored.pendingAction?.action == .attention)
    }

    @Test func malformedSavedKeyboardBindingsCannotOverrideStandardEditing() throws {
        let domain = "pathway-preferences-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let invalid: [PathwayKeyboardAction: PathwayKeyboardBinding] = [.running: .init(key: "v", command: true)]
        defaults.set(try JSONEncoder().encode(invalid), forKey: "pathway.native.keyboardBindings.v1")
        let restored = PathwayKeyboardPreferences(defaults: defaults)
        #expect(restored.binding(for: .running) == PathwayKeyboardAction.running.defaultBinding)
    }

    @Test func appTextPreferencesNeverReduceSystemAccessibilitySizes() {
        let sizes: [DynamicTypeSize] = [.xSmall, .large, .xxxLarge, .accessibility1, .accessibility3, .accessibility5]
        for size in sizes {
            #expect(PathwayTextSizePreference.system.effectiveSize(system: size) == size)
            for preference in PathwayTextSizePreference.allCases { #expect(preference.effectiveSize(system: size) >= size) }
        }
        #expect(PathwayTextSizePreference.larger.effectiveSize(system: .large) == .xLarge)
    }

    @Test func appearanceControlsPersistAndResetToSystemDefaults() throws {
        let domain = "pathway-preferences-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let model = PathwayAppearancePreferences(defaults: defaults)
        model.style = .dark; model.textSize = .extraLarge
        let restored = PathwayAppearancePreferences(defaults: defaults)
        #expect(restored.style == .dark)
        #expect(restored.textSize == .extraLarge)
        restored.reset()
        #expect(PathwayAppearancePreferences(defaults: defaults).style == .system)
        #expect(PathwayAppearancePreferences(defaults: defaults).textSize == .system)
    }
}

private extension PathwayKeyboardBinding {
    static var newThreadDefault: Self { PathwayKeyboardAction.newThread.defaultBinding }
}
