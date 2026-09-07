@testable import Pathway
import Testing

struct PathwayRPCSubscriptionTests {
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
