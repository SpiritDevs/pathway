import AuthenticationServices
import Foundation

/// Keeps recovery copy separate from the diagnostic codes included in a support report.
struct PathwayAuthenticationIssue: Identifiable {
    let id = UUID()
    let occurredAt = Date()
    let title: String
    let message: String
    let isCancellation: Bool
    let errorDomain: String?
    let errorCode: Int?
    var diagnosticCode: String? {
        guard let errorDomain, let errorCode else { return nil }
        return "\(errorDomain) (\(errorCode))"
    }

    init(title: String, message: String, error: (any Error)? = nil) {
        self.title = title
        self.message = message
        isCancellation = false
        errorDomain = error.map { ($0 as NSError).domain }
        errorCode = error.map { ($0 as NSError).code }
    }

    init(signInError error: any Error) {
        let nsError = error as NSError
        isCancellation = error is CancellationError || (
            nsError.domain == ASWebAuthenticationSessionErrorDomain
                && nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
        )
        errorDomain = nsError.domain
        errorCode = nsError.code
        if isCancellation {
            title = "Sign-in closed"
            message = "Sign-in closed before it finished. Tap Try again when you're ready."
        } else if nsError.domain == NSURLErrorDomain {
            title = "Couldn't connect"
            message = "Check your internet connection, then tap Try again."
        } else {
            title = "Couldn't sign in"
            message = (error as? PathwayAuthError)?.errorDescription
                ?? "Please try again. If sign-in still doesn't work, give it a moment and try once more."
        }
    }

    static let supportAddress = "support@pathwayos.app"

    var reportBody: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
        return """
        What happened? Add any details that might help us reproduce the problem:


        Pathway account report
        Report ID: \(id.uuidString)
        Time: \(occurredAt.ISO8601Format())
        App: \(version) (\(build))
        OS: \(ProcessInfo.processInfo.operatingSystemVersionString)
        Summary: \(title)
        Error code: \(diagnosticCode ?? "Not available")
        """
    }

    var emailURL: URL? {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = Self.supportAddress
        components.queryItems = [
            URLQueryItem(name: "subject", value: "Pathway support: \(title)"),
            URLQueryItem(name: "body", value: reportBody),
        ]
        return components.url
    }
}
