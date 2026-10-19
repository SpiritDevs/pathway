// Capture layout and conversion adapted from Sotto, Copyright (c) 2026 Davis.
// MIT license; see ../LICENSE-Sotto. Pathway saves only the supplied temporary WAV.
import AVFoundation
import CoreAudio
import Foundation

enum AudioRecordingError: LocalizedError {
    case alreadyRecording, notRecording, microphoneUnavailable, noAudio, cancelled
    case processing(String)
    var errorDescription: String? {
        switch self {
        case .alreadyRecording: "A recording is already in progress."
        case .notRecording: "There is no active recording."
        case .microphoneUnavailable: "The selected microphone is unavailable."
        case .noAudio: "The microphone did not provide audio."
        case .cancelled: "Recording was cancelled."
        case .processing(let detail): detail
        }
    }
}

/// PCM copies leave the audio callback immediately. Conversion and file I/O use one writer queue.
final class CaptureWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "pathway.dictation.writer", qos: .userInitiated)
    private let lock = NSLock()
    private var queued = 0
    private var accepting = true
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    private var file: AVAudioFile?
    private var failure: Error?
    private var frames: Int64 = 0
    private var meterFrames = 0
    private var meterSquares = 0.0
    private let onLevel: (Double, Double) -> Void
    private let onError: (String) -> Void
    let path: String

    init(path: String, input: AVAudioFormat, onLevel: @escaping (Double, Double) -> Void,
         onError: @escaping (String) -> Void) throws {
        self.path = path
        self.onLevel = onLevel
        self.onError = onError
        guard path.hasPrefix("/"), path.lowercased().hasSuffix(".wav") else {
            throw AudioRecordingError.processing("Capture needs an absolute temporary .wav path.")
        }
        // Exclusive creation prevents overwriting an existing recording or following a final symlink.
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw AudioRecordingError.processing("Capture path already exists or cannot be created.") }
        Darwin.close(descriptor)
        do {
            guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
                  let converter = AVAudioConverter(from: input, to: format) else {
                throw AudioRecordingError.processing("Microphone format cannot be converted.")
            }
            self.format = format
            self.converter = converter
            converter.downmix = true
            converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false
            ], commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            try? FileManager.default.removeItem(atPath: path)
            throw error
        }
    }

    func append(_ source: AVAudioPCMBuffer) {
        lock.lock()
        guard accepting else { lock.unlock(); return }
        // Bound copies if a disk stalls; fail the take instead of exhausting memory.
        guard queued < 64 else {
            accepting = false
            lock.unlock()
            onError("Audio storage could not keep up with the microphone.")
            return
        }
        queued += 1
        lock.unlock()
        guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else {
            lock.withLock { queued -= 1 }
            onError("Could not allocate microphone buffer.")
            return
        }
        copy.frameLength = source.frameLength
        let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: source.audioBufferList))
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (a, b) in zip(from, to) {
            if let src = a.mData, let dst = b.mData { memcpy(dst, src, Int(min(a.mDataByteSize, b.mDataByteSize))) }
        }
        queue.async { [self] in
            defer { lock.withLock { queued -= 1 } }
            guard failure == nil else { return }
            do { try convert(copy) } catch { failure = error; onError(error.localizedDescription) }
        }
    }

    private func convert(_ input: AVAudioPCMBuffer?) throws {
        let capacity = input.map { AVAudioFrameCount(ceil(Double($0.frameLength) * 16_000 / $0.format.sampleRate)) + 256 } ?? 4096
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw AudioRecordingError.processing("Could not allocate conversion buffer.")
        }
        var supplied = false
        for _ in 0..<8 {
            output.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                if input == nil { state.pointee = .endOfStream; return nil }
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true
                state.pointee = .haveData
                return input
            }
            if status == .error { throw error ?? AudioRecordingError.processing("Microphone conversion failed.") as NSError }
            try write(output)
            if status == .endOfStream || status == .inputRanDry || output.frameLength == 0 { return }
        }
    }

    private func write(_ output: AVAudioPCMBuffer) throws {
        // The parent owns the five-minute state transition. Bound the WAV defensively too.
        output.frameLength = min(output.frameLength, AVAudioFrameCount(max(0, 4_800_000 - frames)))
        guard output.frameLength > 0, let samples = output.floatChannelData?[0] else { return }
        try file?.write(from: output)
        for index in 0..<Int(output.frameLength) {
            let sample = samples[index].isFinite ? Double(min(1, abs(samples[index]))) : 0
            meterSquares += sample * sample
            meterFrames += 1
            frames += 1
            if meterFrames == 800 {
                let rms = sqrt(meterSquares / 800)
                let level = max(0, min(1, (20 * log10(max(rms, 0.00001)) + 60) / 60))
                onLevel(Double(frames) / 16, level)
                meterSquares = 0
                meterFrames = 0
            }
        }
    }

    func finish(cancel: Bool) throws -> Double {
        lock.withLock { accepting = false }
        return try queue.sync {
            defer { file = nil }
            if cancel {
                file = nil
                try? FileManager.default.removeItem(atPath: path)
                return 0
            }
            if let failure { throw failure }
            try convert(nil)
            return Double(frames) / 16
        }
    }
}

/// All driver lifecycle and route notifications run on queue, never on the event-tap thread.
final class CaptureController: @unchecked Sendable {
    let queue = DispatchQueue(label: "pathway.dictation.capture", qos: .userInitiated)
    private let emit: ([String: Any]) -> Void
    private var unit: InputOnlyAudioUnit?
    private var writer: CaptureWriter?
    private let gateLock = NSLock()
    private var gate: AudioCaptureRequest?
    private var gateID: String?
    private var id: String?
    private var observers: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    init(emit: @escaping ([String: Any]) -> Void) { self.emit = emit }

    // Synchronously reject late callback admission while startup or driver teardown is in flight.
    func closeAdmission(id: String?, cancel: Bool) {
        gateLock.withLock {
            guard id == nil || id == gateID else { return }
            if cancel { gate?.cancel() } else { gate?.release() }
        }
    }

    func reserveStart(id: String) throws -> AudioCaptureRequest {
        try gateLock.withLock {
            guard !id.isEmpty else { throw AudioRecordingError.processing("Capture id cannot be empty.") }
            guard gate == nil else { throw AudioRecordingError.alreadyRecording }
            let request = AudioCaptureRequest()
            gate = request
            gateID = id
            return request
        }
    }

    func start(id: String, path: String, deviceID: String, request gate: AudioCaptureRequest) throws -> [String: Any] {
        guard self.id == nil else { throw AudioRecordingError.alreadyRecording }
        self.id = id
        do {
            try gate.requireOpen()
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                throw AudioRecordingError.processing("Allow microphone access before recording.")
            }
            let inventory = AudioInputHardware.snapshot()
            let selected = deviceID == "default" ? inventory.systemDefaultID : inventory.inputs.first { $0.device.uid == deviceID }?.deviceID
            guard let selected, AudioInputHardware.isAvailable(selected) else { throw AudioRecordingError.microphoneUnavailable }
            let unit = InputOnlyAudioUnit()
            self.unit = unit
            let format = try unit.prepare(deviceID: selected)
            let writer = try CaptureWriter(path: path, input: format, onLevel: { [weak self] duration, level in
                guard gate.acceptsAudio else { return }
                self?.emit(["type": "level", "id": id, "durationMs": duration, "level": level])
            }, onError: { [weak self] reason in self?.interrupt(id: id, reason: reason) })
            self.writer = writer
            try unit.start(request: gate, onAudio: { writer.append($0) }, onError: { [weak self] status in
                self?.interrupt(id: id, reason: "Microphone stopped delivering audio (\(status)).")
            })
            for (object, selector, scope) in [
                (selected, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal),
                (selected, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal),
                (selected, kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput),
                (AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)
            ] {
                var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
                let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                    guard let self, self.id == id else { return }
                    do {
                        guard AudioInputHardware.isAvailable(selected) else { throw AudioRecordingError.microphoneUnavailable }
                        try self.unit?.validateRoute(requireRunning: true)
                    } catch { self.interrupt(id: id, reason: error.localizedDescription) }
                }
                if AudioObjectAddPropertyListenerBlock(object, &address, queue, block) == noErr { observers.append((object, address, block)) }
            }
            return ["id": id]
        } catch {
            _ = try? finish(id: id, cancel: true)
            throw error
        }
    }

    func finish(id requestedID: String?, cancel: Bool, disconnected: String? = nil) throws -> [String: Any] {
        guard let id else {
            if cancel { return ["cancelled": false] }
            throw AudioRecordingError.notRecording
        }
        guard requestedID == nil || requestedID == id else { throw AudioRecordingError.processing("Capture id no longer matches.") }
        closeAdmission(id: id, cancel: cancel)
        for (object, var address, block) in observers { AudioObjectRemovePropertyListenerBlock(object, &address, queue, block) }
        observers.removeAll()
        unit?.stop()
        unit = nil
        let writer = self.writer
        self.writer = nil
        self.id = nil
        gateLock.withLock { gate = nil; gateID = nil }
        do {
            let duration = try writer?.finish(cancel: cancel) ?? 0
            if cancel { return ["cancelled": true] }
            let capture: [String: Any] = ["id": id, "path": writer?.path ?? "", "durationMs": duration]
            var event = capture
            event["type"] = disconnected == nil ? "capture-stopped" : "microphone-disconnected"
            if let disconnected { event["reason"] = disconnected }
            emit(event)
            return capture
        } catch {
            if let writer { try? FileManager.default.removeItem(atPath: writer.path) }
            throw error
        }
    }

    private func interrupt(id: String, reason: String) {
        queue.async { [weak self] in
            guard let self, self.id == id else { return }
            do { _ = try self.finish(id: id, cancel: false, disconnected: reason) }
            catch { self.emit(["type": "error", "message": error.localizedDescription]) }
        }
    }
}
