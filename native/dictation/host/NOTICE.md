# Source notices

The macOS host adapts source from Sotto by Davis, copyright 2026, under the MIT license. The complete notice is in [LICENSE-Sotto](LICENSE-Sotto) and must accompany distributed helpers.

Inspected source: https://github.com/davis7dotsh/sotto/tree/f40309e7c59f2f1308d17d3da755b0485e43d92e

Substantial source reuse:

- `macos/InputOnlyAudioUnit.swift` copies Sotto's input-only HAL audio unit with Pathway naming and error integration.
- `macos/AudioCaptureRequest.swift` copies its synchronized audio admission gate.
- `macos/AudioDevices.swift` adapts the HAL metadata reader from `AudioDeviceStore.swift`.
- `macos/Capture.swift` adapts PCM copying, serial conversion, mono downmix, metering, and route validation from `AudioRecorder.swift`. It accepts a caller-owned temporary path and does not retain original audio.
- `macos/Shortcut.swift` adapts the listen-only event tap, side-specific modifier masks, and lost-release recovery from `HotkeyMonitor.swift`. Pathway's parent owns gesture timing.
- `macos/Insertion.swift` adapts focus and selection validation, single-attempt delivery, and clipboard revision ownership from `TextInserter.swift` and `TextDeliveryTransaction.swift`. It resolves the current field at delivery time.
- Windows source implements the same delivery and capture policy using Windows SDK APIs. Its clipboard transaction follows the Sotto policy.

The host links only platform SDK frameworks and libraries. It does not download third-party native dependencies or contain model inference code. Apple and Microsoft SDK components remain subject to their platform license terms.
