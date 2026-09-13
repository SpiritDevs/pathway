import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayMarkdownImageLifecycleTests {
    @Test func sceneAndConnectionChangesReuseTheResolvedImage() {
        let model = NSObject()
        let original = key(model, active: true, connected: true)
        #expect(original.identifiesSameImage(as: key(model, active: false, connected: true)))
        #expect(original.identifiesSameImage(as: key(model, active: true, connected: false)))
    }

    @Test func retryAndResourceChangesInvalidateTheResolvedImage() {
        let model = NSObject(), replacement = NSObject()
        let original = key(model)
        #expect(!original.identifiesSameImage(as: key(model, attempt: 1)))
        #expect(!original.identifiesSameImage(as: key(model, source: "other.png")))
        #expect(!original.identifiesSameImage(as: key(model, threadID: "other-thread")))
        #expect(!original.identifiesSameImage(as: key(model, workspaceRoot: "/other")))
        #expect(!original.identifiesSameImage(as: key(replacement)))
    }

    private func key(_ model: NSObject, active: Bool = true, connected: Bool = true,
                     source: String = "image.png", threadID: String = "thread", workspaceRoot: String? = "/workspace",
                     attempt: Int = 0) -> AgentMarkdownImage.LoadKey {
        AgentMarkdownImage.LoadKey(model: ObjectIdentifier(model), threadID: threadID, source: source,
                                   workspaceRoot: workspaceRoot, connected: connected, active: active, attempt: attempt)
    }
}
