import Observation
import SwiftUI

@MainActor
@Observable
final class CompactThreadChromeState {
    private var activeOwner: UUID?
    var isThreadDetailActive: Bool { activeOwner != nil }
    private(set) var isNavigationExpanded = false
    private(set) var isComposerExpanded = false

    func enterThreadDetail(owner: UUID, composerExpanded: Bool) {
        activeOwner = owner
        isNavigationExpanded = false
        isComposerExpanded = composerExpanded
    }

    func leaveThreadDetail(owner: UUID) {
        guard activeOwner == owner else { return }
        activeOwner = nil
        isNavigationExpanded = false
        isComposerExpanded = false
    }

    func expandNavigation() {
        guard isThreadDetailActive else { return }
        isNavigationExpanded = true
    }

    func collapseNavigation() {
        isNavigationExpanded = false
    }

    func setComposerExpanded(_ isExpanded: Bool, owner: UUID) {
        guard activeOwner == owner else { return }
        isComposerExpanded = isExpanded
        if isExpanded {
            isNavigationExpanded = false
        }
    }
}

extension EnvironmentValues {
    @Entry var compactThreadChrome: CompactThreadChromeState?
}
