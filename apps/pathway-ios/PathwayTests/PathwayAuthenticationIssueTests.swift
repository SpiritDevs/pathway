import AuthenticationServices
import Foundation
import Testing
@testable import Pathway

@MainActor struct PathwayAuthenticationIssueTests {
    @Test(arguments: [true, false])
    func cancelledLoginAutomaticallyReportsAndShowsTheReceipt(accepted: Bool) async throws {
        let reporter = RecordingLoginReporter(accepted: accepted)
        let model = PathwayAppModel(authProvider: FailingSignInAuth(), loginErrorReporter: reporter)
        await model.signIn()
        let issue = try #require(model.authenticationIssue)
        #expect(reporter.reportIDs == [issue.id])
        #expect(model.loginReportState == (accepted ? .received : .pending))
    }

    @Test func dismissedSignInOffersNeutralRecovery() {
        let error = NSError(domain: ASWebAuthenticationSessionErrorDomain, code: 1)
        let issue = PathwayAuthenticationIssue(signInError: error)
        #expect(issue.isCancellation)
        #expect(issue.title == "Sign-in closed")
        #expect(!issue.message.contains(ASWebAuthenticationSessionErrorDomain))
        #expect(PathwayAuthenticationIssue(signInError: CancellationError()).isCancellation)
    }

    @Test func presentationFailureIsNotTreatedAsCancellation() {
        let issue = PathwayAuthenticationIssue(signInError: NSError(
            domain: ASWebAuthenticationSessionErrorDomain,
            code: ASWebAuthenticationSessionError.presentationContextInvalid.rawValue
        ))
        #expect(!issue.isCancellation)
        #expect(issue.title == "Couldn't sign in")
    }

    @Test func networkFailureOffersConnectionAdvice() {
        let issue = PathwayAuthenticationIssue(signInError: URLError(.notConnectedToInternet))
        #expect(issue.title == "Couldn't connect")
        #expect(issue.message.contains("internet connection"))
    }

    @Test func supportEmailRetainsDiagnosticsWithoutErrorPayloads() throws {
        let issue = PathwayAuthenticationIssue(signInError: NSError(
            domain: "test.auth", code: 42,
            userInfo: [NSLocalizedDescriptionKey: "token=secret&email=private@example.com"]
        ))
        let url = try #require(issue.emailURL)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "mailto")
        #expect(components.path == "support@pathwayos.app")
        let body = try #require(components.queryItems?.first { $0.name == "body" }?.value)
        #expect(body == issue.reportBody)
        #expect(body.contains("test.auth (42)"))
        #expect(body.contains(issue.id.uuidString))
        #expect(!body.contains("secret"))
        #expect(!body.contains("private@example.com"))
        #expect(!issue.message.contains("secret"))
    }

    @Test func retryReplacesPreviousFailureAndSessionEndClearsDiagnosticCode() async {
        let auth = FailingSignInAuth()
        let model = PathwayAppModel(authProvider: auth)
        await model.signIn()
        #expect(model.authenticationState == .signedOut)
        #expect(model.authenticationIssue?.isCancellation == true)
        let firstID = model.authenticationIssue?.id
        auth.error = URLError(.notConnectedToInternet)
        await model.signIn()
        #expect(model.authenticationIssue?.id != firstID)
        #expect(model.authenticationIssue?.title == "Couldn't connect")
        model.sessionDidEnd()
        #expect(model.authenticationIssue?.diagnosticCode == nil)
        #expect(model.authenticationIssue?.title == "Sign in again")
    }
}

@MainActor private final class RecordingLoginReporter: PathwayLoginErrorReporting {
    let accepted: Bool
    var reportIDs: [UUID] = []
    init(accepted: Bool) { self.accepted = accepted }
    func report(_ issue: PathwayAuthenticationIssue) async -> Bool {
        reportIDs.append(issue.id)
        return accepted
    }
    func retryPendingReports() async { }
}

@MainActor private final class FailingSignInAuth: PathwayAuthenticating {
    var hasActiveSession = false
    var onSessionChanged: ((Bool) -> Void)?
    var error: any Error = NSError(domain: ASWebAuthenticationSessionErrorDomain, code: 1)
    func startHostedSignIn() async throws { throw error }
    func signOut() async throws { }
    func token(template: String?) async throws -> String { throw PathwayAuthError.missingSession }
}
