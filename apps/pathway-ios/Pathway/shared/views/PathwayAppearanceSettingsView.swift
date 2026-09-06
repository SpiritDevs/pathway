import Foundation
import Observation
import SwiftUI

enum PathwayAppearanceStyle: String, Codable, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self { case .system: "System"; case .light: "Light"; case .dark: "Dark" }
    }
    var scheme: ColorScheme? {
        switch self { case .system: nil; case .light: .light; case .dark: .dark }
    }
}

enum PathwayTextSizePreference: String, Codable, CaseIterable, Identifiable {
    case system, larger, extraLarge
    var id: String { rawValue }
    var title: String {
        switch self { case .system: "System Size"; case .larger: "Larger Text"; case .extraLarge: "Extra Large Text" }
    }
    func effectiveSize(system: DynamicTypeSize) -> DynamicTypeSize {
        switch self {
        case .system: system
        case .larger: max(system, .xLarge)
        case .extraLarge: max(system, .xxxLarge)
        }
    }
}

@MainActor @Observable final class PathwayAppearancePreferences {
    static let shared = PathwayAppearancePreferences()
    var style: PathwayAppearanceStyle { didSet { defaults.set(style.rawValue, forKey: "pathway.native.appearance") } }
    var textSize: PathwayTextSizePreference { didSet { defaults.set(textSize.rawValue, forKey: "pathway.native.textSize") } }
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        style = defaults.string(forKey: "pathway.native.appearance").flatMap(PathwayAppearanceStyle.init(rawValue:)) ?? .system
        textSize = defaults.string(forKey: "pathway.native.textSize").flatMap(PathwayTextSizePreference.init(rawValue:)) ?? .system
    }
    func reset() { style = .system; textSize = .system }
}

struct PathwayAppearanceModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var systemSize
    private var preferences: PathwayAppearancePreferences { .shared }
    func body(content: Content) -> some View {
        content.preferredColorScheme(preferences.style.scheme)
            .dynamicTypeSize(preferences.textSize.effectiveSize(system: systemSize))
    }
}

struct PathwayAppearanceSettingsView: View {
    @State private var preferences = PathwayAppearancePreferences.shared
    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Color Scheme", selection: $preferences.style) {
                    ForEach(PathwayAppearanceStyle.allCases) { style in Text(style.title).tag(style) }
                }
            }
            Section {
                Picker("Text Size", selection: $preferences.textSize) {
                    ForEach(PathwayTextSizePreference.allCases) { size in Text(size.title).tag(size) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("A clearer view of your work").font(.headline)
                    Text("Review agent updates, reply to requests, and keep your projects moving.").font(.body)
                }
                .padding(.vertical, 8)
            } header: { Text("Reading") } footer: {
                Text("Pathway uses system fonts and Dynamic Type. Larger accessibility sizes from system settings always take priority.")
            }
            Section { Button("Use System Appearance") { preferences.reset() } }
        }
        .navigationTitle("Appearance")
    }
}
