import Foundation
import Observation
import SwiftUI

enum PathwayKeyboardAction: String, Codable, CaseIterable, Identifiable, Sendable {
    case newThread, running, attention, sharedDrafts, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .newThread: "New Agent Thread"
        case .running: "Running Agents"
        case .attention: "Needs Attention"
        case .sharedDrafts: "Shared Drafts"
        case .settings: "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .newThread: "square.and.pencil"
        case .running: "sparkles"
        case .attention: "hand.raised"
        case .sharedDrafts: "tray.and.arrow.down"
        case .settings: "gearshape"
        }
    }
    var defaultBinding: PathwayKeyboardBinding {
        switch self {
        case .newThread: .init(key: "n", command: true)
        case .running: .init(key: "r", command: true, shift: true)
        case .attention: .init(key: "a", command: true, shift: true)
        case .sharedDrafts: .init(key: "i", command: true, shift: true)
        case .settings: .init(key: ",", command: true)
        }
    }
}

struct PathwayKeyboardBinding: Codable, Equatable, Sendable {
    var key: String
    var command = false
    var option = false
    var control = false
    var shift = false

    var normalized: Self {
        var value = self
        value.key = key.lowercased()
        return value
    }
    var modifiers: EventModifiers {
        var value: EventModifiers = []
        if command { value.insert(.command) }
        if option { value.insert(.option) }
        if control { value.insert(.control) }
        if shift { value.insert(.shift) }
        return value
    }
    var display: String { "\(control ? "⌃" : "")\(option ? "⌥" : "")\(shift ? "⇧" : "")\(command ? "⌘" : "")\(key.uppercased())" }
    var equivalent: KeyEquivalent { KeyEquivalent(normalized.key.first ?? "n") }
    var validationMessage: String? {
        guard key.utf8.count == 1, let scalar = key.unicodeScalars.first,
              (33...126).contains(scalar.value),
              normalized.key.allSatisfy({ $0.isLetter || $0.isNumber || ",./;'[]\\-=`".contains($0) }) else {
            return "Choose one letter, number, or unshifted punctuation key. Use the Shift modifier for shifted shortcuts."
        }
        guard command || option || control else { return "Include Command, Option, or Control so typing stays available." }
        if command && !option && !control && !shift && ["a", "c", "v", "x", "z", "q", "w", "h"].contains(normalized.key) {
            return "This shortcut is reserved for standard editing or window controls."
        }
        if command && shift && !option && !control && normalized.key == "z" {
            return "This shortcut is reserved for Redo."
        }
        return nil
    }
}

struct PathwayKeyboardRequest: Identifiable, Equatable {
    let id = UUID()
    let action: PathwayKeyboardAction
}

@MainActor @Observable final class PathwayKeyboardPreferences {
    static let shared = PathwayKeyboardPreferences()
    private(set) var bindings: [PathwayKeyboardAction: PathwayKeyboardBinding]
    var pendingAction: PathwayKeyboardRequest?
    private let defaults: UserDefaults
    private static let storageKey = "pathway.native.keyboardBindings.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let standard = Dictionary(uniqueKeysWithValues: PathwayKeyboardAction.allCases.map { ($0, $0.defaultBinding) })
        if let data = defaults.data(forKey: Self.storageKey),
           let saved = try? JSONDecoder().decode([PathwayKeyboardAction: PathwayKeyboardBinding].self, from: data) {
            let merged = standard.merging(saved) { _, new in new.normalized }
            let unique = Set(merged.values.map { $0.display })
            bindings = merged.values.allSatisfy { $0.validationMessage == nil } && unique.count == merged.count ? merged : standard
        } else { bindings = standard }
    }

    func binding(for action: PathwayKeyboardAction) -> PathwayKeyboardBinding { bindings[action] ?? action.defaultBinding }
    func validationMessage(for binding: PathwayKeyboardBinding, action: PathwayKeyboardAction) -> String? {
        if let message = binding.validationMessage { return message }
        if let conflict = PathwayKeyboardAction.allCases.first(where: { $0 != action && self.binding(for: $0).normalized == binding.normalized }) {
            return "This shortcut is already used by \(conflict.title)."
        }
        return nil
    }
    @discardableResult func update(_ binding: PathwayKeyboardBinding, for action: PathwayKeyboardAction) -> Bool {
        guard validationMessage(for: binding, action: action) == nil else { return false }
        bindings[action] = binding.normalized
        persist()
        return true
    }
    func reset() {
        bindings = Dictionary(uniqueKeysWithValues: PathwayKeyboardAction.allCases.map { ($0, $0.defaultBinding) })
        defaults.removeObject(forKey: Self.storageKey)
    }
    func invoke(_ action: PathwayKeyboardAction) { pendingAction = .init(action: action) }
    private func persist() {
        guard let data = try? JSONEncoder().encode(bindings) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
