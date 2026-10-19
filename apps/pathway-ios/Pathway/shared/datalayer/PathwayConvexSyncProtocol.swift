import Foundation

/// Wire shapes from the installed Convex 1.43.0 SDK's browser/sync protocol.
/// Keep this version and its fixtures aligned when updating the Convex dependency.
enum PathwayConvexWireError: LocalizedError, Sendable {
    case invalidMessage(String)
    case remote(String)
    case authentication(String)
    case timedOut

    var errorDescription: String? {
        switch self {
        case let .invalidMessage(message), let .remote(message), let .authentication(message): message
        case .timedOut: "The cloud did not respond in time. Reconnect to try again."
        }
    }
}

struct PathwayConvexSyncVersion: Equatable, Sendable {
    let querySet: Int
    let timestamp: String
    let identity: Int
    static let initial = Self(querySet: 0, timestamp: "AAAAAAAAAAA=", identity: 0)

    init(querySet: Int, timestamp: String, identity: Int) {
        self.querySet = querySet; self.timestamp = timestamp; self.identity = identity
    }

    init(_ value: JSONValue?) throws {
        guard let value = value?.objectValue, let querySet = value["querySet"]?.intValue,
              let timestamp = value["ts"]?.stringValue, Data(base64Encoded: timestamp)?.count == 8,
              let identity = value["identity"]?.intValue, querySet >= 0, identity >= 0 else {
            throw PathwayConvexWireError.invalidMessage("The cloud returned an invalid sync version.")
        }
        self.init(querySet: querySet, timestamp: timestamp, identity: identity)
    }
}

struct PathwayConvexSyncProtocol: Sendable {
    static let version = "1.43.0"
    private(set) var remoteVersion = PathwayConvexSyncVersion.initial
    private var chunks: [String] = []
    private var chunkID: String?
    private var totalChunks = 0
    private var chunkBytes = 0

    mutating func reset() { self = Self() }

    /// Chunks are ordered by the server. A gap or an interleaved frame forces a new snapshot.
    mutating func decode(_ data: Data) throws -> JSONValue? {
        let message = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let object = message.objectValue, let type = object["type"]?.stringValue else {
            throw PathwayConvexWireError.invalidMessage("The cloud returned an invalid sync message.")
        }
        if type == "Ping" { return message }
        guard type == "TransitionChunk" else {
            guard chunks.isEmpty else { throw PathwayConvexWireError.invalidMessage("The cloud interrupted a sync transition.") }
            return message
        }
        guard let part = object["partNumber"]?.intValue, let total = object["totalParts"]?.intValue,
              let identifier = object["transitionId"]?.stringValue, let chunk = object["chunk"]?.stringValue,
              total > 0, total <= 4096, part == chunks.count, part < total,
              chunkID == nil || (chunkID == identifier && totalChunks == total) else {
            throw PathwayConvexWireError.invalidMessage("The cloud returned an out-of-order sync transition.")
        }
        chunkID = identifier; totalChunks = total; chunkBytes += chunk.utf8.count
        guard chunkBytes <= 64 * 1024 * 1024 else { throw PathwayConvexWireError.invalidMessage("The cloud sync transition exceeded the device limit.") }
        chunks.append(chunk)
        guard chunks.count == total else { return nil }
        let combined = Data(chunks.joined().utf8)
        chunks = []; chunkID = nil; totalChunks = 0; chunkBytes = 0
        let transition = try JSONDecoder().decode(JSONValue.self, from: combined)
        guard transition.objectValue?["type"]?.stringValue == "Transition" else {
            throw PathwayConvexWireError.invalidMessage("The cloud returned an invalid chunked transition.")
        }
        return transition
    }

    mutating func applyTransition(_ value: JSONValue) throws -> [JSONValue] {
        guard let object = value.objectValue,
              object["type"]?.stringValue == "Transition", let modifications = object["modifications"]?.arrayValue else {
            throw PathwayConvexWireError.invalidMessage("The cloud returned an invalid transition.")
        }
        let start = try PathwayConvexSyncVersion(object["startVersion"])
        let end = try PathwayConvexSyncVersion(object["endVersion"])
        guard start == remoteVersion, end.identity >= start.identity, end.querySet >= start.querySet else {
            throw PathwayConvexWireError.invalidMessage("The cloud sync version changed unexpectedly. Reconnecting for a fresh snapshot.")
        }
        remoteVersion = end
        return modifications
    }

    static func connect(sessionID: String, count: Int, lastCloseReason: String?) -> JSONValue {
        .object(["type": .string("Connect"), "sessionId": .string(sessionID),
            "connectionCount": .number(Double(count)), "lastCloseReason": lastCloseReason.map(JSONValue.string) ?? .null,
            "clientTs": .number(Date().timeIntervalSince1970 * 1000)])
    }

    static func authenticate(token: String, baseVersion: Int) -> JSONValue {
        .object(["type": .string("Authenticate"), "tokenType": .string("User"),
            "value": .string(token), "baseVersion": .number(Double(baseVersion))])
    }

    static func addQuery(id: Int, name: String, arguments: JSONValue, journal: JSONValue = .null) -> JSONValue {
        .object(["type": .string("Add"), "queryId": .number(Double(id)), "udfPath": .string(name),
            "args": .array([arguments]), "journal": journal])
    }

    static func modifyQueries(baseVersion: Int, modifications: [JSONValue]) -> JSONValue {
        .object(["type": .string("ModifyQuerySet"), "baseVersion": .number(Double(baseVersion)),
            "newVersion": .number(Double(baseVersion + 1)), "modifications": .array(modifications)])
    }

    static func httpBody(name: String, arguments: JSONValue) -> JSONValue {
        .object(["path": .string(name), "format": .string("convex_encoded_json"), "args": .array([arguments])])
    }

    static func httpResult(_ data: Data) throws -> JSONValue {
        let object = try JSONDecoder().decode(JSONValue.self, from: data).objectValue
        switch object?["status"]?.stringValue {
        case "success": return object?["value"] ?? .null
        case "error": throw PathwayConvexWireError.remote(object?["errorMessage"]?.stringValue ?? "The cloud rejected the request.")
        default: throw PathwayConvexWireError.invalidMessage("The cloud returned an invalid function result.")
        }
    }

    static func tokenExpiration(_ token: String) -> Date? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              let object = try? JSONDecoder().decode(JSONValue.self, from: data).objectValue,
              case let .number(expiration) = object["exp"] else { return nil }
        return Date(timeIntervalSince1970: expiration)
    }
}
