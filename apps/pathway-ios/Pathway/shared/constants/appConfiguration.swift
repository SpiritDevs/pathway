import Foundation

enum AppConfiguration {
    static let clerkPublishableKey = nonemptyString(forInfoKey: "PATHWAY_CLERK_PUBLISHABLE_KEY")
    static let clerkJWTTemplate = nonemptyString(forInfoKey: "PATHWAY_CLERK_JWT_TEMPLATE")
    static let convexDeploymentURL = optionalURL(forInfoKey: "PATHWAY_CONVEX_URL")
    static let relayURL = optionalURL(forInfoKey: "PATHWAY_RELAY_URL")
    static let convexJWTTemplate = "convex"
    static var missingRequiredKeys: [String] {
        [
            clerkPublishableKey == nil ? "PATHWAY_CLERK_PUBLISHABLE_KEY" : nil,
            clerkJWTTemplate == nil ? "PATHWAY_CLERK_JWT_TEMPLATE" : nil,
            convexDeploymentURL == nil ? "PATHWAY_CONVEX_URL" : nil,
            relayURL == nil ? "PATHWAY_RELAY_URL" : nil
        ].compactMap(\.self)
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
