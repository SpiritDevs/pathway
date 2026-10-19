import Foundation

enum PathwayLoginReportState {
    case sending, received, pending

    var message: String {
        switch self {
        case .sending: "Reporting this problem to our support team…"
        case .received: "Report saved for our support team."
        case .pending: "Report saved. We'll try sending it again automatically."
        }
    }
}

@MainActor protocol PathwayLoginErrorReporting {
    func report(_ issue: PathwayAuthenticationIssue) async -> Bool
    func retryPendingReports() async
}

/// Reports login diagnostics without an account token. Pending reports survive app restarts.
@MainActor final class PathwayLoginErrorReporter: PathwayLoginErrorReporting {
    private struct Report: Codable {
        let reportId: String
        let installationId: String
        let occurredAt: String
        let appVersion: String
        let osVersion: String
        let errorDomain: String
        let errorCode: Int
        let kind: String
    }
    private struct RequestBody: Encodable {
        let path = "loginErrorReports:submit"
        let format = "json"
        let args: Report
    }
    private struct ResponseBody: Decodable { let status: String }

    private let deploymentURL: URL?
    private let session: URLSession
    private let defaults: UserDefaults
    private let queueKey: String
    private var sending = false
    private var acceptedReportIDs: Set<String> = []
    private var pending: [Report]

    init(deploymentURL: URL?, session: URLSession = .shared, defaults: UserDefaults = .standard) {
        self.deploymentURL = deploymentURL
        self.session = session
        self.defaults = defaults
        queueKey = "pathway.loginErrorReports.\(deploymentURL?.absoluteString ?? "unconfigured")"
        pending = defaults.data(forKey: queueKey).flatMap { try? JSONDecoder().decode([Report].self, from: $0) } ?? []
    }

    func report(_ issue: PathwayAuthenticationIssue) async -> Bool {
        guard deploymentURL != nil else { return false }
        if acceptedReportIDs.contains(issue.id.uuidString) { return true }
        if !pending.contains(where: { $0.reportId == issue.id.uuidString }) {
            let installationKey = "pathway.loginErrorReports.installationId"
            let installationId = defaults.string(forKey: installationKey) ?? UUID().uuidString
            defaults.set(installationId, forKey: installationKey)
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
            let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
            pending.append(Report(
                reportId: issue.id.uuidString, installationId: installationId,
                occurredAt: issue.occurredAt.ISO8601Format(), appVersion: "\(version) (\(build))",
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                errorDomain: issue.errorDomain ?? "Pathway", errorCode: issue.errorCode ?? 0,
                kind: issue.isCancellation ? "cancelled" : issue.errorDomain == NSURLErrorDomain ? "connection" : "unknown"
            ))
            // Bound local diagnostics during a prolonged outage.
            pending = Array(pending.suffix(20))
            persist()
        }
        await retryPendingReports()
        return acceptedReportIDs.contains(issue.id.uuidString)
    }

    func retryPendingReports() async {
        guard let deploymentURL, !sending else { return }
        sending = true
        defer { sending = false }
        while let report = pending.first {
            do {
                var request = URLRequest(url: deploymentURL.appending(path: "api/mutation"))
                request.httpMethod = "POST"
                request.timeoutInterval = 10
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONEncoder().encode(RequestBody(args: report))
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                      try JSONDecoder().decode(ResponseBody.self, from: data).status == "success"
                else { return }
                acceptedReportIDs.insert(report.reportId)
                pending.removeAll { $0.reportId == report.reportId }
                persist()
            } catch { return }
        }
    }

    private func persist() {
        if pending.isEmpty { defaults.removeObject(forKey: queueKey) }
        else if let data = try? JSONEncoder().encode(pending) { defaults.set(data, forKey: queueKey) }
    }
}
