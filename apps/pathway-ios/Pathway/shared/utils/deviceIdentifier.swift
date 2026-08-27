//
//  deviceIdentifier.swift
//  Pathway
//
//  Created by Corey Baines on 30/11/2024.
//

import Foundation
import KeychainAccess

@MainActor
final class DeviceIdentifier {
    static let shared = DeviceIdentifier()
    private let keychain: Keychain
    private let uuidKey = "deviceUUID"

    private init() {
        // Create a keychain service for your app
        keychain = Keychain(service: Bundle.main.bundleIdentifier ?? "com.spiritdevs.pathway")
    }

    /// Get the UUID for the device. Generates one if it doesn't exist.
    func getDeviceUUID() -> String {
        if let existingUUID = keychain[uuidKey] {
            return existingUUID
        } else {
            let newUUID = UUID().uuidString
            keychain[uuidKey] = newUUID
            return newUUID
        }
    }

    /// Remove the UUID from Keychain (useful for testing or resetting)
    func clearUUID() {
        try? keychain.remove(uuidKey)
    }
}
