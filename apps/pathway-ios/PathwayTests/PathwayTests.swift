import Foundation
@testable import Pathway
import Testing

struct PathwayTests {
    @Test func authSessionRetainsClerkToken() {
        let session = PathwayAuthSession(idToken: "test-token")

        #expect(session.idToken == "test-token")
    }

    @MainActor
    @Test func endedSessionReturnsAppToSignedOutState() throws {
        let deploymentURL = try #require(URL(string: "https://test.convex.cloud"))
        let appModel = PathwayAppModel(convexDeploymentURL: deploymentURL)

        appModel.sessionDidEnd()

        #expect(appModel.authenticationState == .signedOut)
        #expect(appModel.authenticationErrorMessage != nil)
    }

    @MainActor
    @Test func failedSignOutPreservesAuthenticationState() async throws {
        let deploymentURL = try #require(URL(string: "https://test.convex.cloud"))
        let appModel = PathwayAppModel(
            convexDeploymentURL: deploymentURL,
            performSignOut: { throw SignOutTestError.failed }
        )

        await appModel.signOut()

        #expect(appModel.authenticationState == .restoring)
        #expect(appModel.authenticationErrorMessage == "The test sign-out failed.")
    }
}

private enum SignOutTestError: LocalizedError {
    case failed

    var errorDescription: String? {
        "The test sign-out failed."
    }
}
