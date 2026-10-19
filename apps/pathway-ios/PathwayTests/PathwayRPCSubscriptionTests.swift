import Foundation
import Network
@testable import Pathway
import Testing

struct PathwayRPCSubscriptionTests {
    @Test func transportChangesDoNotTerminateAFullBrowserFrameBuffer() async throws {
        let pair = AsyncThrowingStream<JSONValue, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
        pair.continuation.yield(.string("old frame"))
        pathwayRPCYieldTransportState("connecting", to: pair.continuation, policy: .bufferingNewest(1))
        var iterator = pair.stream.makeAsyncIterator()
        let connecting = try await iterator.next()
        #expect(connecting?.objectValue?["_pathwayTransport"]?.stringValue == "connecting")
        pair.continuation.yield(.string("new connection frame"))
        let latest = try await iterator.next()
        #expect(latest?.stringValue == "new connection frame")
        pair.continuation.finish()
    }

    @Test func browserFramesCoalesceWithoutForcingAReconnect() async throws {
        let pair = AsyncThrowingStream<JSONValue, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
        pair.continuation.yield(.string("old frame"))
        let result = pair.continuation.yield(.string("latest frame"))
        #expect(!pathwayRPCBufferOverflowIsFatal(result, policy: .bufferingNewest(1)))
        var iterator = pair.stream.makeAsyncIterator()
        let latest = try await iterator.next()
        #expect(latest?.stringValue == "latest frame")
        pair.continuation.finish()
    }

    @Test func aTransportChangeThatCannotEnterAFullConversationQueueEndsItRecoverably() async throws {
        let pair = AsyncThrowingStream<JSONValue, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        pair.continuation.yield(.string("buffered event"))
        let ended = pathwayRPCYieldTransportState("disconnected", to: pair.continuation, policy: .bufferingOldest(1))
        #expect(ended)
        var iterator = pair.stream.makeAsyncIterator()
        let buffered = try await iterator.next()
        #expect(buffered?.stringValue == "buffered event")
        await #expect {
            _ = try await iterator.next()
        } throws: { error in
            if case PathwayRPCError.overflowed = error { true } else { false }
        }
    }

    @Test func aFullConversationQueueEndsTheStreamInOrderAndClosesTheIdleSocket() async throws {
        let server = try await RPCTestServer.start()
        defer { server.stop() }
        let rpc = PathwayRPCClient { server.url }
        let stream = await rpc.subscribeToThread("thread-1")
        let subscription = try await server.receiveJSON()
        #expect(subscription["tag"]?.stringValue == "orchestration.subscribeThread")
        let requestID = try #require(subscription["id"]?.intValue)
        // The consumer is paused; one chunk carries more events than the queue holds.
        let events = (1 ... 300).map { sequence in
            JSONValue.object(["kind": .string("event"), "sequence": .number(Double(sequence))])
        }
        try await server.send(.object(["_tag": .string("Chunk"), "requestId": .number(Double(requestID)), "values": .array(events)]))
        // The client asks the server to stop the abandoned stream instead of acknowledging it.
        var control = try await server.receiveJSON()
        while control["_tag"]?.stringValue == "Ping" { control = try await server.receiveJSON() }
        #expect(control["_tag"]?.stringValue == "Interrupt")
        #expect(control["requestId"]?.intValue == requestID)
        // Nothing else needs the socket, so the client closes it rather than reconnecting for nobody.
        await #expect(throws: (any Error).self) {
            while true {
                if try await server.receiveJSON()["_tag"]?.stringValue != "Ping" { break }
            }
        }

        var sequences: [Int] = []
        var thrown: Error?
        do {
            for try await value in stream {
                if let sequence = value.objectValue?["sequence"]?.intValue { sequences.append(sequence) }
            }
        } catch { thrown = error }
        #expect(!sequences.isEmpty)
        #expect(sequences == Array(1 ... sequences.count))
        let ended = if case PathwayRPCError.overflowed? = thrown { true } else { false }
        #expect(ended)
        await rpc.stop()
    }

    @Test func lostConversationEventsStillRequireAReconnect() {
        let pair = AsyncThrowingStream<JSONValue, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        pair.continuation.yield(.string("first event"))
        let result = pair.continuation.yield(.string("lost event"))
        #expect(pathwayRPCBufferOverflowIsFatal(result, policy: .bufferingOldest(1)))
        pair.continuation.finish()
    }

    @Test func issueRequestsWaitForTheCurrentSocketsProtocolAcknowledgement() {
        var gate = PathwayRPCSubscriptionGate()
        #expect(gate.allowsRequest(requiresSubscription: false))
        #expect(!gate.allowsRequest(requiresSubscription: true))
        gate.open(requestID: 8)
        let received1 = gate.receiveChunk(requestID: 7)
        #expect(!received1)
        let received2 = gate.receiveChunk(requestID: nil)
        #expect(!received2)
        #expect(!gate.allowsRequest(requiresSubscription: true))
        let received3 = gate.receiveChunk(requestID: 8)
        #expect(received3)
        #expect(gate.allowsRequest(requiresSubscription: true))
        let received4 = gate.receiveChunk(requestID: 8)
        #expect(!received4)
    }

    @Test func reconnectRequiresANewHandshakeAndIgnoresThePreviousSocketsChunks() {
        var gate = PathwayRPCSubscriptionGate()
        gate.open(requestID: 8)
        let received5 = gate.receiveChunk(requestID: 8)
        #expect(received5)
        gate.reset()
        #expect(!gate.allowsRequest(requiresSubscription: true))
        gate.open(requestID: 12)
        let received6 = gate.receiveChunk(requestID: 8)
        #expect(!received6)
        #expect(!gate.allowsRequest(requiresSubscription: true))
        #expect(gate.allowsRequest(requiresSubscription: false))
        let received7 = gate.receiveChunk(requestID: 12)
        #expect(received7)
        #expect(gate.allowsRequest(requiresSubscription: true))
    }
}

/// One loopback WebSocket connection for RPC envelopes, driven from the test.
private final class RPCTestServer: @unchecked Sendable {
    let url: URL
    private let listener: NWListener
    private let connections: AsyncStream<NWConnection>
    private var connection: NWConnection?

    private init(listener: NWListener, port: UInt16, connections: AsyncStream<NWConnection>) {
        self.listener = listener
        self.connections = connections
        url = URL(string: "ws://127.0.0.1:\(port)/ws")!
    }

    static func start() async throws -> RPCTestServer {
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let (connections, continuation) = AsyncStream<NWConnection>.makeStream()
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            continuation.yield(connection)
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { ready in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: listener.stateUpdateHandler = nil; ready.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error): listener.stateUpdateHandler = nil; ready.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: .global())
        }
        return RPCTestServer(listener: listener, port: port, connections: connections)
    }

    private func current() async throws -> NWConnection {
        if let connection { return connection }
        var iterator = connections.makeAsyncIterator()
        guard let next = await iterator.next() else { throw URLError(.cannotConnectToHost) }
        connection = next
        return next
    }

    /// The next client envelope; throws once the client closes.
    func receiveJSON() async throws -> [String: JSONValue] {
        let connection = try await current()
        let data: Data = try await withCheckedThrowingContinuation { result in
            connection.receiveMessage { data, context, _, error in
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                if let error { result.resume(throwing: error) }
                else if metadata?.opcode == .close { result.resume(throwing: URLError(.networkConnectionLost)) }
                else if let data, !data.isEmpty { result.resume(returning: data) }
                else { result.resume(throwing: URLError(.networkConnectionLost)) }
            }
        }
        return try JSONDecoder().decode(JSONValue.self, from: data).objectValue ?? [:]
    }

    func send(_ value: JSONValue) async throws {
        let connection = try await current()
        let context = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        let data = try JSONEncoder().encode(value)
        try await withCheckedThrowingContinuation { (result: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error { result.resume(throwing: error) } else { result.resume() }
            })
        }
    }

    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}
