// Adapted from Sotto, Copyright (c) 2026 Davis. MIT license; see ../LICENSE-Sotto.
import AVFoundation
import CoreAudio
import Foundation

/// The only state shared with the audio callback. Closing admission is
/// synchronous, even while a driver is still servicing start() on its queue.
final class AudioCaptureRequest: @unchecked Sendable {
    let id = UUID()
    private enum State { case open, released, cancelled }
    private let lock = NSLock()
    private var state: State = .open

    var acceptsAudio: Bool { lock.withLock { state == .open } }
    var isReleased: Bool { lock.withLock { state == .released } }
    var isCancelled: Bool { lock.withLock { state == .cancelled } }

    func release() {
        lock.withLock { if state == .open { state = .released } }
    }

    func cancel() { lock.withLock { state = .cancelled } }

    func requireOpen() throws {
        try lock.withLock {
            switch state {
            case .open: break
            case .released: throw AudioRecordingError.noAudio
            case .cancelled: throw AudioRecordingError.cancelled
            }
        }
    }
}
