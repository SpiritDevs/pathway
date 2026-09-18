import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayIssueDragProviderTests {
    @Test func itemProviderRoundTripDeliversDropOnMainActor() async {
        let payload = PathwayIssueDragPayload(companyID: "company", issueID: "issue")
        let provider = payload.itemProvider()
        let received: PathwayIssueDragPayload? = await withCheckedContinuation { continuation in
            let accepted = PathwayIssueDragPayload.load(from: [provider]) { received in
                #expect(Thread.isMainThread)
                continuation.resume(returning: received)
            }
            #expect(accepted)
            if !accepted { continuation.resume(returning: nil as PathwayIssueDragPayload?) }
        }
        #expect(received == payload)
    }

    @Test func backgroundProviderDeliversDecodedPayloadOnMainActor() async throws {
        let payload = PathwayIssueDragPayload(companyID: "company", issueID: "background-issue")
        let provider = Self.backgroundProvider(data: try JSONEncoder().encode(payload))
        let received: PathwayIssueDragPayload? = await withCheckedContinuation { continuation in
            let accepted = PathwayIssueDragPayload.load(from: [provider]) { received in
                MainActor.assertIsolated()
                continuation.resume(returning: received)
            }
            #expect(accepted)
            if !accepted { continuation.resume(returning: nil as PathwayIssueDragPayload?) }
        }
        #expect(received == payload)
    }

    private nonisolated static func backgroundProvider(data: Data) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: PathwayIssueDragPayload.contentType.identifier,
                                            visibility: .ownProcess) { completion in
            DispatchQueue.global().async {
                #expect(!Thread.isMainThread)
                completion(data, nil)
            }
            return nil
        }
        return provider
    }

    @Test func unrelatedAndMultipleItemsDoNotStartADrop() {
        #expect(!PathwayIssueDragPayload.load(from: [NSItemProvider()]) { _ in
            Issue.record("An unsupported item must not invoke the drop action")
        })
        let payload = PathwayIssueDragPayload(companyID: "company", issueID: "issue")
        #expect(!PathwayIssueDragPayload.load(from: [payload.itemProvider(), payload.itemProvider()]) { _ in
            Issue.record("A multiple-item drop must not invoke a single-issue action")
        })
    }
}
