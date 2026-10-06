import Darwin
import Foundation

final class ParentProcessMonitor {
    private let originalParentProcessIdentifier = getppid()
    private var timer: Timer?
    /// Runs on the main thread before the helper exits, for modes that must
    /// close out their protocol (the workflow recorder ends as cancelled).
    private let onParentExit: (() -> Void)?

    init(onParentExit: (() -> Void)? = nil) {
        self.onParentExit = onParentExit
    }

    func start() {
        guard originalParentProcessIdentifier > 1 else {
            parentStopped()
        }

        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.exitIfParentStopped()
        }
        // Common modes: event tracking (a dragged panel, a held button) must not defer exit.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        exitIfParentStopped()
    }

    private func exitIfParentStopped() {
        if getppid() != originalParentProcessIdentifier {
            parentStopped()
        }

        if Darwin.kill(originalParentProcessIdentifier, 0) != 0, errno == ESRCH {
            parentStopped()
        }
    }

    private func parentStopped() -> Never {
        // A closed stdout must not kill the helper before onParentExit finishes.
        signal(SIGPIPE, SIG_IGN)
        onParentExit?()
        exit(EXIT_SUCCESS)
    }
}
