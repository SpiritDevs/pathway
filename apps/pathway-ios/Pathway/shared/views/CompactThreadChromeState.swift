import Observation
import SwiftUI

@MainActor
@Observable
final class CompactThreadChromeState {
    private(set) var isThreadDetailActive = false
    private(set) var isNavigationExpanded = false
    private(set) var isComposerExpanded = false

    func enterThreadDetail() {
        isThreadDetailActive = true
        isNavigationExpanded = false
        isComposerExpanded = false
    }

    func leaveThreadDetail() {
        isThreadDetailActive = false
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

    func setComposerExpanded(_ isExpanded: Bool) {
        isComposerExpanded = isExpanded
        if isExpanded {
            isNavigationExpanded = false
        }
    }
}

extension EnvironmentValues {
    @Entry var compactThreadChrome: CompactThreadChromeState?
}
