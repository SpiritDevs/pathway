@testable import Pathway
import Testing

struct PathwayRPCSubscriptionTests {
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
