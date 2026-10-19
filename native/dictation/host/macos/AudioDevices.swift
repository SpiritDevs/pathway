// Adapted from Sotto, Copyright (c) 2026 Davis. MIT license; see ../LICENSE-Sotto.
import CoreAudio
import Foundation
struct AudioInputDevice { let uid: String; let name: String }
struct AudioInputHandle { let deviceID: AudioDeviceID; let device: AudioInputDevice }
struct AudioHardwareSnapshot {
    let deviceIDs: [AudioDeviceID]
    let inputs: [AudioInputHandle]
    let systemDefaultID: AudioDeviceID?
}
enum AudioInputHardware {
    static func snapshot() -> AudioHardwareSnapshot {
        let deviceIDs = allDeviceIDs()
        let inputs = deviceIDs.compactMap { id -> AudioInputHandle? in
            guard isAvailable(id), let uid = string(id, kAudioDevicePropertyDeviceUID), !uid.isEmpty else { return nil }
            let name = string(id, kAudioObjectPropertyName).flatMap { $0.isEmpty ? nil : $0 } ?? "Unnamed microphone"
            return AudioInputHandle(deviceID: id, device: AudioInputDevice(uid: uid, name: name))
        }
        return AudioHardwareSnapshot(deviceIDs: deviceIDs, inputs: inputs, systemDefaultID: defaultInputID())
    }

    static func defaultInputID() -> AudioDeviceID? {
        let id = uint32(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice)
        return id == kAudioObjectUnknown ? nil : id
    }

    static func isAvailable(_ id: AudioDeviceID) -> Bool {
        id != kAudioObjectUnknown && uint32(id, kAudioDevicePropertyDeviceIsAlive) == 1 && hasInputChannels(id)
    }

    private static func allDeviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr,
              size > 0, size <= 1_048_576, size % UInt32(MemoryLayout<AudioDeviceID>.stride) == 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.stride)
        let status = ids.withUnsafeMutableBytes {
            AudioObjectGetPropertyData(system, &address, 0, nil, &size, $0.baseAddress!)
        }
        guard status == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioDeviceID>.stride))
    }

    private static func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
              size == MemoryLayout<UInt32>.size else { return nil }
        return value
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
        // HAL's CFString metadata properties transfer ownership to the caller.
        let result = value?.takeRetainedValue()
        guard status == noErr else { return nil }
        return result as String?
    }

    private static func hasInputChannels(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
              size >= MemoryLayout<UInt32>.size, size <= 1_048_576 else { return false }
        let allocationSize = max(Int(size), MemoryLayout<AudioBufferList>.stride)
        let memory = UnsafeMutableRawPointer.allocate(byteCount: allocationSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        memory.initializeMemory(as: UInt8.self, repeating: 0, count: allocationSize)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, memory) == noErr else { return false }
        let list = memory.assumingMemoryBound(to: AudioBufferList.self)
        let bufferOffset = MemoryLayout<AudioBufferList>.stride - MemoryLayout<AudioBuffer>.stride
        guard Int(size) >= bufferOffset,
              Int(list.pointee.mNumberBuffers) <= (Int(size) - bufferOffset) / MemoryLayout<AudioBuffer>.stride else { return false }
        return UnsafeMutableAudioBufferListPointer(list).contains { $0.mNumberChannels > 0 }
    }

}
