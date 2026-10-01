import Foundation

// Wire types for `@spiritdevs/contracts/xcode` and the Apple ID session in `@spiritdevs/contracts/apple`.

enum PathwayXcodePlatform: String, Codable, CaseIterable, Identifiable, Sendable {
    case iOS, watchOS, tvOS
    var id: String { rawValue }
}

struct PathwayXcodeFailure: Codable, Equatable, Sendable {
    let code: String
    let message: String
}

struct PathwayInstalledXcode: Codable, Equatable, Identifiable, Sendable {
    let path: String
    let version: String
    let build: String
    let beta: Bool
    let selected: Bool
    var id: String { path }
}

struct PathwayAvailableXcode: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let version: String
    let build: String
    let beta: Bool
    let downloadBytes: Double?
    let requiredBytes: Double
}

struct PathwayXcodeRuntime: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let platform: PathwayXcodePlatform
    let version: String
    let build: String?
    let installed: Bool
    let available: Bool
    let downloadBytes: Double?
}

struct PathwayXcodeProgress: Codable, Equatable, Sendable {
    let bytes: Double
    let total: Double?
    let bytesPerSecond: Double
}

enum PathwayXcodeStepID: String, Codable, Sendable {
    case check, download, expand, move, license, select
    case firstLaunch = "first-launch"
    case runtimes, helpers

    var label: String {
        switch self {
        case .check: "Check the Mac"
        case .download: "Download Xcode"
        case .expand: "Expand and verify"
        case .move: "Move to Applications"
        case .license: "Accept the license"
        case .select: "Select Xcode"
        case .firstLaunch: "Install components"
        case .runtimes: "Download platforms"
        case .helpers: "Install device support"
        }
    }
}

enum PathwayXcodeStepState: String, Codable, Sendable {
    case pending, running
    case needsAdmin = "needs-admin"
    case completed, skipped, failed, cancelled

    /// Spoken with each step, since the step icons are decorative.
    var label: String {
        switch self {
        case .pending: "Not started"
        case .running: "In progress"
        case .needsAdmin: "Needs admin approval"
        case .completed: "Done"
        case .skipped: "Skipped"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }
}

struct PathwayXcodeStep: Codable, Equatable, Identifiable, Sendable {
    let id: PathwayXcodeStepID
    let state: PathwayXcodeStepState
    let error: PathwayXcodeFailure?
    let progress: PathwayXcodeProgress?
}

enum PathwayXcodeJobKind: String, Codable, Sendable { case install, select, runtimes }

enum PathwayXcodeJobState: String, Codable, Sendable {
    case running
    case needsAdmin = "needs-admin"
    case needsReauth = "needs-reauth"
    case interrupted, failed, cancelling, cancelled, completed

    var label: String {
        switch self {
        case .running: "In progress"
        case .needsAdmin: "Needs admin approval on the Mac"
        case .needsReauth: "Sign in to your Apple ID again"
        case .interrupted: "Interrupted"
        case .failed: "Failed"
        case .cancelling: "Cancelling…"
        case .cancelled: "Cancelled"
        case .completed: "Done"
        }
    }
}

struct PathwayXcodeTarget: Codable, Equatable, Hashable, Sendable {
    let companyId: String
    let accountId: String

    var payload: [String: JSONValue] { ["companyId": .string(companyId), "accountId": .string(accountId)] }
}

struct PathwayXcodeJob: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let kind: PathwayXcodeJobKind
    let account: PathwayXcodeTarget
    let versionId: String?
    let path: String
    let platforms: [PathwayXcodePlatform]
    let state: PathwayXcodeJobState
    let steps: [PathwayXcodeStep]
    let createdAt: Double
    let updatedAt: Double
}

struct PathwayXcodeDisk: Codable, Equatable, Sendable {
    let freeBytes: Double?
    let requiredBytes: Double
}

struct PathwayXcodeStatus: Codable, Equatable, Sendable {
    let host: String
    let installed: [PathwayInstalledXcode]
    let available: [PathwayAvailableXcode]
    let runtimes: [PathwayXcodeRuntime]
    let disk: PathwayXcodeDisk
    let job: PathwayXcodeJob?
    let error: PathwayXcodeFailure?
}

/// `xcode.subscribe` values: inventory initially and after completion, otherwise only the job.
enum PathwayXcodeUpdate: Decodable, Equatable, Sendable {
    case status(PathwayXcodeStatus)
    case job(PathwayXcodeJob?)

    private enum CodingKeys: String, CodingKey { case kind, status, job }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "status": self = try .status(container.decode(PathwayXcodeStatus.self, forKey: .status))
        case "job": self = try .job(container.decodeIfPresent(PathwayXcodeJob.self, forKey: .job))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown update \(kind)")
        }
    }
}

struct PathwayAppleIdPhone: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let destination: String
}

struct PathwayAppleFailure: Codable, Equatable, Sendable {
    let code: String
    let message: String
    let retryAfterSeconds: Double?
}

/// `AppleIdSessionState`. Only flow IDs, expiry and masked phone labels cross the wire.
enum PathwayAppleIdSession: Decodable, Equatable, Sendable {
    enum ChallengeKind: String, Decodable, Sendable {
        case trustedDevice = "trusted-device"
        case sms
        case smsChoice = "sms-choice"
    }

    struct Challenge: Equatable, Sendable {
        let flowId: String
        let expiresAt: Double
        let destination: String?
        let kind: ChallengeKind
        let phoneNumbers: [PathwayAppleIdPhone]
    }

    case signedOut
    case authenticating(flowId: String, expiresAt: Double)
    case challenge(Challenge)
    case authenticated(expiresAt: Double)
    case expired
    case failed(PathwayAppleFailure)

    private enum CodingKeys: String, CodingKey {
        case state, flowId, expiresAt, destination, kind, phoneNumbers, error
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .state) {
        case "signed-out": self = .signedOut
        case "authenticating":
            self = try .authenticating(
                flowId: container.decode(String.self, forKey: .flowId),
                expiresAt: container.decode(Double.self, forKey: .expiresAt)
            )
        case "challenge":
            self = try .challenge(.init(
                flowId: container.decode(String.self, forKey: .flowId),
                expiresAt: container.decode(Double.self, forKey: .expiresAt),
                destination: container.decodeIfPresent(String.self, forKey: .destination),
                kind: container.decode(ChallengeKind.self, forKey: .kind),
                phoneNumbers: container.decode([PathwayAppleIdPhone].self, forKey: .phoneNumbers)
            ))
        case "authenticated": self = try .authenticated(expiresAt: container.decode(Double.self, forKey: .expiresAt))
        case "expired": self = .expired
        case "failed": self = try .failed(container.decode(PathwayAppleFailure.self, forKey: .error))
        case let state:
            throw DecodingError.dataCorruptedError(forKey: .state, in: container, debugDescription: "Unknown state \(state)")
        }
    }

    var isAuthenticated: Bool {
        if case .authenticated = self { return true }
        return false
    }
}

struct PathwayAppleAccount: Decodable, Equatable, Identifiable, Sendable {
    enum Scope: Decodable, Equatable, Sendable {
        case user
        case company(String)

        private enum CodingKeys: String, CodingKey { case kind, companyId }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self = try container.decode(String.self, forKey: .kind) == "company"
                ? .company(container.decode(String.self, forKey: .companyId))
                : .user
        }
    }

    let id: String
    let email: String
    let displayName: String
    let scope: Scope

    var label: String { displayName == email ? email : "\(displayName) (\(email))" }
}
