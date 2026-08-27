import Foundation

struct SettingsDestinationSearchItem: Equatable, Identifiable, Sendable {
    let route: SettingsRoute
    let title: String
    let section: MobileSettingsCatalog.Section
    let availability: MobileSettingsCatalog.Availability

    var id: SettingsRoute { route }
}

enum SettingsDestinationSearchIndex {
    static func items(
        destinations: [MobileSettingsCatalog.Destination],
        matching query: String,
        locale: Locale
    ) -> [SettingsDestinationSearchItem] {
        let needle = normalized(query)

        return destinations.compactMap { destination in
            guard let route = SettingsRoute(destination: destination) else { return nil }
            let title = route.localizedTitle(locale: locale)
            let item = SettingsDestinationSearchItem(
                route: route,
                title: title,
                section: destination.section,
                availability: destination.availability
            )
            guard !needle.isEmpty else { return item }

            let haystack = ([title] + route.localizedSearchKeywords(locale: locale))
                .map(normalized)
                .joined(separator: " ")
            return haystack.contains(needle) ? item : nil
        }
    }

    private static func normalized(_ value: String) -> String {
        value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
