import Foundation
import Testing
@testable import Pathway

@Suite(.serialized)
@MainActor struct PathwayLoginErrorReporterTests {
    @Test func sendsDiagnosticsAutomaticallyWithoutCredentialsOrRawErrorText() async throws {
        let suite = "pathway-login-report-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoginReportURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        LoginReportURLProtocol.state.reset(status: "success")
        let reporter = PathwayLoginErrorReporter(deploymentURL: URL(string: "https://cloud.example.test"), session: session, defaults: defaults)
        let issue = PathwayAuthenticationIssue(signInError: NSError(domain: "test.auth", code: 17,
            userInfo: [NSLocalizedDescriptionKey: "token=private-token"]))

        #expect(await reporter.report(issue))
        let request = try #require(LoginReportURLProtocol.state.requests.first)
        #expect(request.url?.absoluteString == "https://cloud.example.test/api/mutation")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let data = try #require(LoginReportURLProtocol.state.bodies.first)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["path"] as? String == "loginErrorReports:submit")
        let args = try #require(body["args"] as? [String: Any])
        #expect(args["reportId"] as? String == issue.id.uuidString)
        #expect(args["errorDomain"] as? String == "test.auth")
        #expect(args["errorCode"] as? Int == 17)
        #expect(!String(decoding: data, as: UTF8.self).contains("private-token"))
        await reporter.retryPendingReports()
        #expect(LoginReportURLProtocol.state.requests.count == 1)
    }

    @Test func failedCloudReceiptPersistsAndRetriesWithTheSameReportIDAfterRestart() async throws {
        let suite = "pathway-login-retry-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LoginReportURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let url = try #require(URL(string: "https://cloud.example.test"))
        LoginReportURLProtocol.state.reset(status: "error")
        let issue = PathwayAuthenticationIssue(signInError: URLError(.notConnectedToInternet))
        let first = PathwayLoginErrorReporter(deploymentURL: url, session: session, defaults: defaults)
        #expect(await first.report(issue) == false)
        let firstBody = try #require(LoginReportURLProtocol.state.bodies.first)
        LoginReportURLProtocol.state.reset(status: "success")
        let restarted = PathwayLoginErrorReporter(deploymentURL: url, session: session, defaults: defaults)
        await restarted.retryPendingReports()
        let retryBody = try #require(LoginReportURLProtocol.state.bodies.first)
        let firstJSON = try JSONSerialization.jsonObject(with: firstBody) as? NSDictionary
        let retryJSON = try JSONSerialization.jsonObject(with: retryBody) as? NSDictionary
        #expect(firstJSON == retryJSON)
        let third = PathwayLoginErrorReporter(deploymentURL: url, session: session, defaults: defaults)
        await third.retryPendingReports()
        #expect(LoginReportURLProtocol.state.requests.count == 1)
    }
}

private final class LoginReportURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = ReportRequestState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let status = Self.state.record(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"status\":\"\(status)\",\"value\":null}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

private final class ReportRequestState: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedRequests: [URLRequest] = []
    private var recordedBodies: [Data] = []
    private var status = "success"
    var requests: [URLRequest] { lock.withLock { recordedRequests } }
    var bodies: [Data] { lock.withLock { recordedBodies } }
    func reset(status: String) {
        lock.withLock { recordedRequests = []; recordedBodies = []; self.status = status }
    }
    func record(_ request: URLRequest) -> String {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return lock.withLock {
            recordedRequests.append(request); recordedBodies.append(data)
            return status
        }
    }
}
