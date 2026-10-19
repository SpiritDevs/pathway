import Foundation
@testable import Pathway
import Testing

struct PathwayConvexSyncProtocolTests {
    @Test func startupMatchesSDKConnectAuthAndQuerySetFrames() throws {
        let connect = try #require(PathwayConvexSyncProtocol.connect(sessionID: "session", count: 0, lastCloseReason: nil).objectValue)
        #expect(connect["type"] == .string("Connect"))
        #expect(connect["sessionId"] == .string("session"))
        #expect(connect["connectionCount"] == .number(0))
        #expect(connect["lastCloseReason"] == .null)
        #expect(connect["clientTs"] != nil)
        #expect(PathwayConvexSyncProtocol.authenticate(token: "jwt", baseVersion: 0) == .object([
            "type": .string("Authenticate"), "tokenType": .string("User"), "value": .string("jwt"), "baseVersion": .number(0)]))
        let query = PathwayConvexSyncProtocol.addQuery(id: 0, name: "companies:listMine", arguments: .object([:]))
        #expect(query == .object(["type": .string("Add"), "queryId": .number(0), "udfPath": .string("companies:listMine"),
            "args": .array([.object([:])]), "journal": .null]))
        #expect(PathwayConvexSyncProtocol.modifyQueries(baseVersion: 0, modifications: [query]) == .object([
            "type": .string("ModifyQuerySet"), "baseVersion": .number(0), "newVersion": .number(1), "modifications": .array([query])]))
    }

    @Test func transitionVersionsAdvanceTogetherAndReconnectRequiresInitialVersion() throws {
        var wire = PathwayConvexSyncProtocol()
        let first = transition(start: version(0, 0), end: version(1, 1), modifications: [updated])
        #expect(try wire.applyTransition(first) == [updated])
        #expect(wire.remoteVersion == PathwayConvexSyncVersion(querySet: 1, timestamp: "AAAAAAAAAAA=", identity: 1))
        #expect(throws: PathwayConvexWireError.self) { try wire.applyTransition(first) }
        let refresh = transition(start: version(1, 1), end: version(1, 2), modifications: [])
        #expect(try wire.applyTransition(refresh).isEmpty)
        wire.reset()
        #expect(wire.remoteVersion == .initial)
        #expect(throws: PathwayConvexWireError.self) { try wire.applyTransition(refresh) }
        #expect(try wire.applyTransition(first) == [updated])
    }

    @Test func orderedTransitionChunksAllowPingsAndAssembleExactlyOnce() throws {
        var wire = PathwayConvexSyncProtocol()
        let value = transition(start: version(0, 0), end: version(1, 1), modifications: [updated])
        let encoded = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        let midpoint = encoded.index(encoded.startIndex, offsetBy: encoded.count / 2)
        let first = chunk(String(encoded[..<midpoint]), part: 0, total: 2)
        let second = chunk(String(encoded[midpoint...]), part: 1, total: 2)
        #expect(try wire.decode(JSONEncoder().encode(first)) == nil)
        #expect(try wire.decode(Data(#"{"type":"Ping"}"#.utf8)) == .object(["type": .string("Ping")]))
        #expect(try wire.decode(JSONEncoder().encode(second)) == value)
        #expect(try wire.applyTransition(value) == [updated])
    }

    @Test func rejectsMissingChunksInterleavedFramesAndInvalidTimestamps() throws {
        var wire = PathwayConvexSyncProtocol()
        #expect(throws: PathwayConvexWireError.self) { try wire.decode(JSONEncoder().encode(chunk("{}", part: 1, total: 2))) }
        wire.reset()
        _ = try wire.decode(JSONEncoder().encode(chunk("{", part: 0, total: 2)))
        #expect(throws: PathwayConvexWireError.self) { try wire.decode(Data(#"{"type":"Transition"}"#.utf8)) }
        #expect(throws: PathwayConvexWireError.self) {
            try PathwayConvexSyncVersion(.object(["querySet": .number(0), "ts": .string("bad"), "identity": .number(0)]))
        }
    }

    @Test func journalsAndFloat64ArgumentsMatchReconnectAndHTTPContracts() throws {
        let arguments: JSONValue = .object(["companyId": .string("company"), "cursor": .number(42), "limit": .number(100)])
        let query = PathwayConvexSyncProtocol.addQuery(id: 7, name: "sync:listChanges", arguments: arguments, journal: .string("page-journal"))
        #expect(query.objectValue?["journal"] == .string("page-journal"))
        #expect(query.objectValue?["args"] == .array([arguments]))
        #expect(PathwayConvexSyncProtocol.httpBody(name: "sync:listChanges", arguments: arguments) == .object([
            "path": .string("sync:listChanges"), "format": .string("convex_encoded_json"), "args": .array([arguments])]))
        #expect(try PathwayConvexSyncProtocol.httpResult(Data(#"{"status":"success","value":{"cursor":42}}"#.utf8)) == .object(["cursor": .number(42)]))
        #expect(throws: PathwayConvexWireError.self) {
            try PathwayConvexSyncProtocol.httpResult(Data(#"{"status":"error","errorMessage":"Permission denied"}"#.utf8))
        }
    }

    @Test func tokenExpirationUsesJWTBase64URLPayload() throws {
        let data = Data(#"{"exp":2000000000,"sub":"test"}"#.utf8)
        let payload = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        #expect(PathwayConvexSyncProtocol.tokenExpiration("header.\(payload).signature") == Date(timeIntervalSince1970: 2_000_000_000))
        #expect(PathwayConvexSyncProtocol.tokenExpiration("invalid") == nil)
    }

    private var updated: JSONValue { .object(["type": .string("QueryUpdated"), "queryId": .number(0),
        "value": .array([]), "journal": .null, "logLines": .array([])]) }
    private func version(_ querySet: Int, _ identity: Int) -> JSONValue {
        .object(["querySet": .number(Double(querySet)), "ts": .string("AAAAAAAAAAA="), "identity": .number(Double(identity))])
    }
    private func transition(start: JSONValue, end: JSONValue, modifications: [JSONValue]) -> JSONValue {
        .object(["type": .string("Transition"), "startVersion": start, "endVersion": end, "modifications": .array(modifications)])
    }
    private func chunk(_ text: String, part: Int, total: Int) -> JSONValue {
        .object(["type": .string("TransitionChunk"), "transitionId": .string("transition"), "chunk": .string(text),
            "partNumber": .number(Double(part)), "totalParts": .number(Double(total))])
    }
}
