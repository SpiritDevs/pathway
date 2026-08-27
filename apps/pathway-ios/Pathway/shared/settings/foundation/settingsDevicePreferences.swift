import Foundation
import Observation

enum SettingsAppearancePreference: String, CaseIterable, Equatable, Sendable {
    case system
    case light
    case dark
}

@MainActor
@Observable
final class SettingsDevicePreferences {
    static let supportedLanguageCodes: [String] = [
        "en", "es", "de", "fr", "pt", "ja", "it", "zh", "id", "uk", "hi",
        "ru", "nl", "pl", "tr", "vi", "cs", "ko", "hu", "ar", "sv", "ro",
        "el", "da", "fi", "sk", "th", "bg", "hr", "lt", "sr", "sl", "et",
        "lv", "no", "ms", "bn", "ur", "tl", "is", "ne"
    ]

    private(set) var appearance: SettingsAppearancePreference
    /// `nil` follows the device language. Dynamic Type always follows iOS and is not persisted here.
    private(set) var appLanguageCode: String?

    var locale: Locale {
        appLanguageCode.map(Locale.init(identifier:)) ?? .autoupdatingCurrent
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let appearanceKey: String
    @ObservationIgnored private let languageKey: String

    init(
        defaults: UserDefaults = .standard,
        keyPrefix: String = "pathway.settings.device"
    ) {
        self.defaults = defaults
        appearanceKey = "\(keyPrefix).appearance"
        languageKey = "\(keyPrefix).language"

        let storedAppearance = defaults.string(forKey: appearanceKey)
        appearance = SettingsAppearancePreference(rawValue: storedAppearance ?? "") ?? .system

        let storedLanguage = defaults.string(forKey: languageKey)
        appLanguageCode = Self.normalizedSupportedLanguage(storedLanguage)
    }

    func setAppearance(_ value: SettingsAppearancePreference) {
        appearance = value
        defaults.set(value.rawValue, forKey: appearanceKey)
    }

    /// Pass `nil` to return to the device language. Unsupported codes are ignored.
    func setAppLanguage(code: String?) {
        guard let code else {
            appLanguageCode = nil
            defaults.removeObject(forKey: languageKey)
            return
        }
        guard let normalized = Self.normalizedSupportedLanguage(code) else { return }
        appLanguageCode = normalized
        defaults.set(normalized, forKey: languageKey)
    }

    private static func normalizedSupportedLanguage(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return supportedLanguageCodes.contains(normalized) ? normalized : nil
    }
}
