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
