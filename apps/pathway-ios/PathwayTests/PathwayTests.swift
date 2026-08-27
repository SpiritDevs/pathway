@testable import Pathway
import Testing

struct PathwayTests {
    @Test func authSessionRetainsClerkToken() {
        let session = PathwayAuthSession(idToken: "test-token")

        #expect(session.idToken == "test-token")
    }

    @MainActor
    @Test func endedSessionReturnsAppToSignedOutState() {
        let appModel = PathwayAppModel()

        appModel.sessionDidEnd()

        #expect(appModel.authenticationState == .signedOut)
        #expect(appModel.authenticationErrorMessage != nil)
    }
}
