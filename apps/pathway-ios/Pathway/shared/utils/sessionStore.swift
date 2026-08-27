import Foundation
import KeychainAccess

@MainActor
final class SessionStore {
    static let shared = SessionStore()

    private let keychain: Keychain
    private let deploymentURLKey = "userTokenDeploymentURL"
    private let tokenKey = "userToken"

    private init(bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "com.spiritdevs.pathway") {
        keychain = Keychain(service: "\(bundleIdentifier).session")
    }

    func token(for deploymentURL: URL) -> String? {
        let deployment = normalizedDeploymentURL(deploymentURL)

        guard keychain[deploymentURLKey] == deployment else {
            clearToken()
            return nil
        }

        return keychain[tokenKey]
    }

    func setToken(_ token: String, for deploymentURL: URL) {
        try? keychain.set(token, key: tokenKey)
        try? keychain.set(normalizedDeploymentURL(deploymentURL), key: deploymentURLKey)
        UserDefaults.standard.removeObject(forKey: tokenKey)
    }

    func clearToken() {
        try? keychain.remove(tokenKey)
        try? keychain.remove(deploymentURLKey)
        UserDefaults.standard.removeObject(forKey: tokenKey)
    }

    private func normalizedDeploymentURL(_ deploymentURL: URL) -> String {
        deploymentURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
