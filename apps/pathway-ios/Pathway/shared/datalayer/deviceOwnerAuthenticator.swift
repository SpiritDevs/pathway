import Foundation
import LocalAuthentication

@MainActor
protocol DeviceOwnerAuthenticating: AnyObject {
    func authenticateAdminAuthorization() async throws
    func authenticateDeviceOwner(localizedReason: String) async throws
    func cancelAdminAuthorizationAuthentication()
}

extension DeviceOwnerAuthenticating {
    func authenticateDeviceOwner(localizedReason: String) async throws {
        try await authenticateAdminAuthorization()
    }
}

@MainActor
final class DeviceOwnerAuthenticator: DeviceOwnerAuthenticating {
    private var activeContext: LAContext?

    func authenticateAdminAuthorization() async throws {
        try await authenticateDeviceOwner(
            localizedReason: "Confirm that you requested access to the Pathway Admin Dashboard."
        )
    }

    func authenticateDeviceOwner(localizedReason: String) async throws {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        activeContext = context
        defer {
            if activeContext === context {
                activeContext = nil
            }
        }
        do {
            try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: localizedReason
            )
        } catch let error as LAError where [
            .appCancel,
            .systemCancel,
            .userCancel
        ].contains(error.code) {
            throw CancellationError()
        }
    }

    func cancelAdminAuthorizationAuthentication() {
        activeContext?.invalidate()
        activeContext = nil
    }
}
