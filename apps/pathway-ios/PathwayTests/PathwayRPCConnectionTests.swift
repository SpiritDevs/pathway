import Foundation
import Network
import Testing
@testable import Pathway

struct PathwayRPCConnectionTests {
    @Test func olderServerCompletesAfterItsSnapshot() async throws {
        try await loadThread(completionMarker: false, textBytes: 128)
    }

    @Test func currentServerLoadsHistoryLargerThanTheDefaultSocketLimit() async throws {
        try await loadThread(completionMarker: true, textBytes: 2 * 1024 * 1024)
    }

    private func loadThread(completionMarker: Bool, textBytes: Int) async throws {
        let server = RPCFixtureServer(completionMarker: completionMarker, textBytes: textBytes)
        let url = try await server.start()
        let rpc = PathwayRPCClient { url }
        do {
            var receivedSnapshot = false
            for try await value in await rpc.subscribeToThread("fixture") {
                if value.objectValue?["kind"]?.stringValue == "snapshot" {
                    receivedSnapshot = true
                    #expect(value.objectValue?["projection"]?.objectValue?["text"]?.stringValue?.utf8.count == textBytes)
                    if completionMarker {
                        // The server deliberately withholds completion until this assertion.
                        do {
                            _ = try await rpc.request("fixture.operation", payload: .object([:]),
                                requiresSubscription: true, waitForSubscription: false)
                            Issue.record("A snapshot alone must not release operations on a current server")
                        } catch PathwayRPCError.disconnected {}
                        try await server.completeSubscription()
                    }
                }
                if value.objectValue?["kind"]?.stringValue == "synchronized" {
                    #expect(receivedSnapshot)
                    let result = try await rpc.request("fixture.operation", payload: .object([:]),
                        requiresSubscription: true, waitForSubscription: false)
                    #expect(result == .string("accepted"))
                    let requestedCompletionMarker = await server.requestedCompletionMarker
                    #expect(requestedCompletionMarker == completionMarker)
                    await rpc.stop()
                    await server.stop()
                    return
                }
            }
            Issue.record("The subscription ended before synchronization")
        } catch {
            await rpc.stop()
            await server.stop()
            throw error
        }
        await rpc.stop()
        await server.stop()
    }
}

private actor RPCFixtureServer {
    let completionMarker: Bool
    let textBytes: Int
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var subscription: (NWConnection, Int)?
    private(set) var requestedCompletionMarker = false

    init(completionMarker: Bool, textBytes: Int) {
        self.completionMarker = completionMarker
        self.textBytes = textBytes
    }

    func start() async throws -> URL {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let ready = AsyncThrowingStream<UInt16, Error> { continuation in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let port = listener.port { continuation.yield(port.rawValue) }
                    continuation.finish()
                case let .failed(error): continuation.finish(throwing: error)
                case .cancelled: continuation.finish(throwing: CancellationError())
                default: break
                }
            }
        }
        listener.newConnectionHandler = { connection in
            Task { await self.accept(connection) }
        }
        listener.start(queue: .global())
        var iterator = ready.makeAsyncIterator()
        guard let port = try await iterator.next(), let url = URL(string: "ws://127.0.0.1:\(port)") else {
            throw PathwayRPCError.disconnected
        }
        return url
    }

    func stop() {
        listener?.cancel()
        for connection in connections { connection.cancel() }
    }

    func completeSubscription() async throws {
        guard let (connection, id) = subscription else { throw PathwayRPCError.disconnected }
        try await send(.object(["_tag": .string("Chunk"), "requestId": .number(Double(id)),
            "values": .array([.object(["kind": .string("synchronized")])])]), on: connection)
    }

    private func accept(_ connection: NWConnection) async {
        connections.append(connection)
        connection.start(queue: .global())
        do {
            while true {
                let data: Data = try await withCheckedThrowingContinuation { continuation in
                    connection.receiveMessage { data, _, _, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let data { continuation.resume(returning: data) }
                        else { continuation.resume(throwing: PathwayRPCError.disconnected) }
                    }
                }
                let message = try JSONDecoder().decode(JSONValue.self, from: data).objectValue ?? [:]
                if message["_tag"]?.stringValue == "Ping" {
                    try await send(.object(["_tag": .string("Pong")]), on: connection)
                }
                guard let id = message["id"]?.intValue, let tag = message["tag"]?.stringValue else { continue }
                if tag == "orchestration.subscribeThread" {
                    subscription = (connection, id)
                    requestedCompletionMarker = message["payload"]?.objectValue?["requestCompletionMarker"]?.boolValue == true
                    try await send(.object(["_tag": .string("Chunk"), "requestId": .number(Double(id)),
                        "values": .array([.object(["kind": .string("snapshot"),
                            "projection": .object(["text": .string(String(repeating: "x", count: textBytes))])])])]), on: connection)
                } else {
                    let config: JSONValue = completionMarker ? .object(["threadResumeCompletionMarker": .bool(true)]) : .object([:])
                    try await send(.object(["_tag": .string("Exit"), "requestId": .number(Double(id)),
                        "exit": .object(["_tag": .string("Success"), "value": tag == "server.getConfig" ? config : .string("accepted")])]), on: connection)
                }
            }
        } catch { connection.cancel() }
    }

    private func send(_ value: JSONValue, on connection: NWConnection) async throws {
        let context = NWConnection.ContentContext(identifier: "rpc", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        let data = try JSONEncoder().encode(value)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            })
        }
    }
}
