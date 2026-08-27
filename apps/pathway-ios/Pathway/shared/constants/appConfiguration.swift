import Foundation

enum AppConfiguration {
    static let clerkPublishableKey = nonemptyString(forInfoKey: "PATHWAY_CLERK_PUBLISHABLE_KEY")
    static let convexDeploymentURL = optionalURL(forInfoKey: "PATHWAY_CONVEX_URL")
    static let relayURL = optionalURL(forInfoKey: "PATHWAY_RELAY_URL")
    static let pathwaySiteURL = optionalURL(forInfoKey: "PATHWAY_SITE_URL")
        ?? URL(string: "https://app.spiritdevs.com")!
    static let convexJWTTemplate = "convex"

    static var missingRequiredKeys: [String] {
        [
            clerkPublishableKey == nil ? "PATHWAY_CLERK_PUBLISHABLE_KEY" : nil,
            convexDeploymentURL == nil ? "PATHWAY_CONVEX_URL" : nil,
            relayURL == nil ? "PATHWAY_RELAY_URL" : nil,
        ].compactMap { $0 }
    }

    private static func nonemptyString(forInfoKey key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func optionalURL(forInfoKey key: String) -> URL? {
        nonemptyString(forInfoKey: key).flatMap(URL.init(string:))
    }
}
