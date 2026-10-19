import Foundation
import os

/// A bounded record of app operations. Payloads, URLs and error descriptions never enter the log.
final class PathwayDiagnostics: Sendable {
    static let shared = PathwayDiagnostics()
    static let historySeconds: TimeInterval = 15 * 60
    static let maximumEvents = 500
    static let maximumBytes = 256 * 1024

    struct Event: Codable, Sendable {
        let at: Date
        let operation: String
        let outcome: String
        let errorDomain: String?
        let errorCode: Int?
    }
    struct Snapshot: Encodable, Sendable {
        let kind = "pathway-bug-report"
        let version = 1
        let capturedAt: Date
        let collectionStartedAt: Date
        var truncated: Bool
        let appVersion: String
        let osVersion: String
        let context: [String: String]
        var events: [Event]
    }
    private struct State {
        let startedAt = Date()
        var events: [Event] = []
        var dropped = false
    }
    private let state = OSAllocatedUnfairLock(initialState: State())

    func record(_ operation: String, outcome: String, error: Error? = nil, now: Date = Date()) {
        let failure = error as NSError?
        let event = Event(at: now, operation: Self.identifier(operation), outcome: Self.identifier(outcome),
                          errorDomain: failure.map { Self.identifier($0.domain) }, errorCode: failure?.code)
        state.withLock { value in
            value.events.removeAll { now.timeIntervalSince($0.at) > Self.historySeconds }
            value.events.append(event)
            if value.events.count > Self.maximumEvents {
                value.events.removeFirst(value.events.count - Self.maximumEvents)
                value.dropped = true
            }
        }
    }

    func snapshot(context: [String: String], now: Date = Date()) throws -> Data {
        var value = state.withLock { state in
            Snapshot(capturedAt: now, collectionStartedAt: state.startedAt, truncated: state.dropped,
                     appVersion: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"))",
                     osVersion: ProcessInfo.processInfo.operatingSystemVersionString, context: context.mapValues { String($0.prefix(256)) },
                     events: state.events.filter { now.timeIntervalSince($0.at) <= Self.historySeconds })
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(value)
        while data.count > Self.maximumBytes && !value.events.isEmpty {
            value.events.removeFirst(min(50, value.events.count))
            value.truncated = true
            data = try encoder.encode(value)
        }
        return data
    }

    /// Diagnostic identifiers use a small alphabet; an unexpected value is omitted wholesale.
    static func identifier(_ value: String) -> String {
        guard !value.isEmpty, value.utf8.count <= 100,
              value.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || "._:-".unicodeScalars.contains($0) })
        else { return "omitted" }
        return value
    }
}
