# Native dictation host

A separate process owns microphone capture, global key edges, permissions, and insertion. Electron communicates through UTF-8 JSON lines. Audio and document contents never travel over Pathway's environment connection.

Build from the repository root:

```sh
node scripts/build-dictation-host.mjs --test
vp test run native/dictation/host/tests/NativeDictationHost.test.ts native/dictation/host/tests/native-protocol.test.ts
```

macOS requires Apple Silicon, macOS 14+, and Xcode Command Line Tools. The build uses `xcrun swiftc` and system frameworks. Windows requires x64, Visual Studio 2022 C++ Build Tools, and Windows 10/11 SDK with C++/WinRT. Run its build command in an x64 Native Tools Command Prompt. There are no dependency downloads. Toolchain versions come from the installed SDK; release builds should pin the CI toolchain image.

Artifacts are `native/dictation/build/host/pathway-dictation-host` and `pathway-dictation-host.exe`. They are ignored by git. Package the platform binary and `LICENSE-Sotto`. macOS release packaging must sign the helper with the application's identity, retain its embedded Info.plist, and use `macos/entitlements.plist` with hardened runtime. The responsible parent application must also have `NSMicrophoneUsageDescription` and its audio-input entitlement. Signing or moving an ad-hoc development binary can require new permission grants.

The public desktop wrapper is `apps/desktop/src/dictation/NativeDictationHost.ts`. Create it with `{ binaryPath, onEvent }`, await `start()`, then call `request(command)`. `close(): Promise<void>` closes stdin to request cleanup, waits for process exit and stdout drainage, and bounds shutdown with a five-second kill deadline for an unresponsive child. Subsequent `start()` and `request()` calls wait for that closing promise before creating a new process; old replies and events stay scoped to their original child. `request({ type: "shutdown" })` acknowledges graceful cleanup.

Every command has a numeric `requestId` added by the wrapper. Capture `id` is a separate caller-supplied identity. Responses are `{ requestId, ok: true, result }` or `{ requestId, ok: false, error }`. Events have `type` and no `requestId`.

| Command                                           | Result                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `enumerate`                                       | `{ id, name, isDefault }[]`, using persistent OS device IDs                                 |
| `permissions`, optional `request: true`           | `microphone`, `accessibility`, `inputMonitoring`, each `unknown`, `granted`, or `denied`    |
| `startCapture`, `id`, `path`, optional `deviceId` | `{ id }` after hardware starts. `deviceId` defaults to `default`.                           |
| `stopCapture`, optional `id`                      | `{ id, path, durationMs }` after the WAV is finalized                                       |
| `cancelCapture`, optional `id`                    | `{ cancelled }`; stops capture, removes its temporary WAV, and invalidates queued insertion |
| `configureShortcut`, `shortcut`, `enabled`        | `{ shortcut, enabled }`                                                                     |
| `insert`, `text`                                  | `{ status: "inserted" \| "manual" \| "unconfirmed", reason? }`                              |
| `shutdown`                                        | `{ shutdown: true }`, then process exit                                                     |

Permission requests accept an optional `permission: "microphone" | "accessibility"`. A selected request invokes only that permission; omission preserves the combined request. A drag wizard should request the microphone separately and poll accessibility with `request: false`. See [permission routing and measured attribution limits](PERMISSIONS.md).

The startup `ready` event publishes protocol version 1, platform, and supported shortcuts. Both hosts support `right-control`, `right-option`, and `F8`. On Windows, `right-option` means Right Alt. macOS also supports `fn`. Windows deliberately rejects Fn because Windows exposes no portable Fn virtual key. macOS Fn requires a keyboard that reports it; the system's Globe action may need to be set to Do Nothing. Shortcut listeners preserve ordinary key events. Side modifiers used with other keys emit `cancel` with `shortcut-interrupted`, so the parent should discard any pending hold or tap.

Events:

- `shortcut-down` / `shortcut-up`: `shortcut`, monotonic `timestampMs`. Autorepeat is suppressed. The parent owns hold/double-tap/locked-recording interpretation.
- `cancel`: reason `escape`, `sleep`, `screen-lock`, or `shortcut-interrupted`. Escape cancels through the parent, including processing. Sleep and screen lock also stop and discard native capture directly.
- `level`: capture `id`, sample-derived `durationMs`, and normalized `level` from 0 to 1, at most 20 updates/second while recording.
- `capture-stopped`: `id`, `path`, `durationMs`. This can arrive before the stop response; treat them as the same completed capture, not two recordings.
- `microphone-disconnected`: the finalized usable capture and a `reason`. Show this transcript for review; do not insert it automatically. A default microphone is resolved at start and pinned for that take.
- `error`: a native host or capture failure.

Capture begins only after an explicit start. Enumeration and permission checks do not open microphones. Start paths must be absolute `.wav` paths that do not already exist; the caller creates the parent directory. WAVs contain 16 kHz mono signed 16-bit PCM. The parent stops at five minutes; the writer also bounds WAV length to five minutes. Completed audio belongs to the parent and must be removed after processing. Cancel, startup failure, EOF, and graceful shutdown remove unfinished audio. A forced process kill can leave an incomplete file, so the parent must clean the exact temporary path it supplied.

Insertion resolves a verified editable, non-password field and rechecks focus, selection, and modifiers before dispatch. macOS first uses AX selected-text replacement when supported, otherwise one Command-V paste. Windows validates a UI Automation text selection, then sends one Control-V paste. Neither platform synthesizes Enter or changes application focus. Unsupported editors and elevated Windows targets may require manual copying. An OS write timeout or unconfirmed paste never triggers another write.

Temporary clipboard use eagerly snapshots available formats, refuses an incomplete or oversized snapshot, and restores only while its own clipboard revision remains current. A newer user copy wins. Tests use a uniquely named macOS pasteboard, never the general clipboard. Windows self-tests do not touch the clipboard. Full-document text used locally for Windows confirmation is bounded and never emitted, logged, or persisted.

The host bounds macOS AX messaging and Windows UIA connection/transaction calls, and runs insertion separately from capture and keyboard monitoring. Native helpers isolate these OS calls from Electron's main thread.

Local verification on 2026-09-12: the Apple Silicon host compiled; native self-tests passed for 48 kHz stereo to 16 kHz mono conversion, WAV format/duration, metering, exclusive file creation, cancellation, queued-start cancellation, private clipboard restoration and intervening copy, queued-insertion cancellation, and shortcut edges. Twelve TypeScript tests passed for bridge behavior and the built host's real metadata/protocol path, including immediate close/restart during account metadata refresh. This machine reported microphone permission `unknown` and Accessibility/Input Monitoring `denied`; live microphone, global key delivery, and external-app insertion remain unverified until those grants are available. Windows source has not been compiled or run on this Mac and requires native Windows verification before release.
