import Foundation
@testable import Pathway
import Testing

@MainActor
struct CompactThreadChromeStateTests {
    @Test func outgoingThreadCannotResetIncomingThread() {
        let chrome = CompactThreadChromeState()
        let parent = UUID(), child = UUID()
        chrome.enterThreadDetail(owner: parent, composerExpanded: false)
        chrome.expandNavigation()
        chrome.enterThreadDetail(owner: child, composerExpanded: false)
        chrome.leaveThreadDetail(owner: parent)
        chrome.setComposerExpanded(true, owner: parent)
        #expect(chrome.isThreadDetailActive)
        #expect(!chrome.isNavigationExpanded)
        #expect(!chrome.isComposerExpanded)
        chrome.enterThreadDetail(owner: parent, composerExpanded: true)
        chrome.leaveThreadDetail(owner: child)
        chrome.setComposerExpanded(false, owner: child)
        #expect(chrome.isThreadDetailActive)
        #expect(chrome.isComposerExpanded)
        chrome.leaveThreadDetail(owner: parent)
        #expect(!chrome.isThreadDetailActive)
        #expect(!chrome.isComposerExpanded)
    }

    @Test func returningThreadRestoresItsComposerAndResetsNavigation() {
        let chrome = CompactThreadChromeState()
        let owner = UUID()
        chrome.enterThreadDetail(owner: owner, composerExpanded: false)
        chrome.expandNavigation()
        chrome.leaveThreadDetail(owner: owner)
        chrome.enterThreadDetail(owner: owner, composerExpanded: true)
        #expect(chrome.isThreadDetailActive)
        #expect(chrome.isComposerExpanded)
        #expect(!chrome.isNavigationExpanded)
        chrome.setComposerExpanded(false, owner: owner)
        #expect(!chrome.isComposerExpanded)
    }
}
