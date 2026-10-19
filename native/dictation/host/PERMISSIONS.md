# Permission requests and macOS attribution

`{ type: "permissions", request: false }` only checks the native helper's permission state. Add `permission: "microphone"` or `permission: "accessibility"` to select one permission when `request` is true. Selection does not narrow the returned snapshot.

- On macOS, microphone selection invokes the OS consent request only for `notDetermined`. Authorized, denied, and restricted states return immediately without opening Settings; Electron owns Settings navigation. It never requests AX trust or Input Monitoring.
- Accessibility selection invokes only the macOS AX trust request. It never requests microphone access or Input Monitoring. A drag wizard should open System Settings itself and use `request: false`, avoiding this AX prompt entirely.
- Omitting the selector preserves the old combined request, including macOS Input Monitoring fallback.
- On Windows, microphone selection can open microphone privacy settings; accessibility selection opens no permission UI because Win32 has no equivalent AX consent prompt.
- An invalid selector fails without requesting any permission.

The routing unit tests inject request closures and do not request OS permissions or open Settings.

## Verified Mac behavior

On 2026-09-12, the corrected Dev app launched through LaunchServices and received both microphone
and Accessibility grants. The native snapshot reports `granted` for both; the setup view shows Allowed.

Three initial microphone recordings passed through the desktop controller with Turbo and Qwen.
Two applied cleanup; one delivered recognized text with cleanup unavailable. Their content remains
private.

A native host launched as a child of the granted Dev Electron app passed both insertion paths into
an independent AppKit `NSTextView`:

- Direct `AXSelectedText` insertion produced the exact supplied text.
- With `AXSelectedText` configured as nonsettable, Cmd+V produced the exact supplied text.

The clipboard sentinel remained unchanged in both checks.

After restarting the Dev app, both grants persisted and a complete microphone-to-external-editor
check passed. Controlled speech played through speakers entered the default webcam microphone.
Whisper Turbo recognized it, Qwen applied the spoken quantity correction, and Cmd+V inserted the
exact expected result into the native editor. The controller passed through starting, recording,
processing, and result, with cleanup applied and delivery inserted. The clipboard sentinel was
preserved. The controlled phrase and expected text are in the
[design validation notes](../../../docs/internals/dictation-design.md#validation-status).

Injected global Right Control events also passed double-tap to lock recording and tap again to
finish, followed by cleanup and exact insertion into the external editor with the clipboard
preserved. An overlay listener attached during the final recording received positive levels and
advancing duration. A subsequent locked recording cancelled to idle through injected global Escape,
leaving history unchanged. This validates generated events through native shortcut routing;
physical Fn gestures remain unverified.

The integrated focused suite now passes 167 tests across 18 files. It includes the preload fix for
listeners attached during recording, which now receive an initial snapshot before merging meter
events. Regressions cover newer state winning over a stale initial reply, unsubscribe, and rejecting
meter events from a cancelled recording. Windows execution and the packaged release app's permission
behavior remain unverified.

## Development launcher attribution

The earlier Dev bundle used a shell script as `CFBundleExecutable` while its process executed
Electron. TCC attributed both Electron and the capture helper to the running Nightly app, which
lacked the audio-input entitlement. Granting the Dev bundle did not fix requests attributed to
Nightly. This was a launcher identity failure, not evidence that an attached helper cannot use the
app's grant. Apple describes responsible-code attribution and the native bundle-entry requirement
in [DTS guidance](https://developer.apple.com/forums/thread/678819).

The Dev bundle now uses `CFBundleExecutable=Electron`. A generated
`Contents/Resources/app/index.cjs` bootstrap applies allowlisted defaults from
`.electron-runtime/dev-environment.json` before loading `dist-electron/main.cjs`. Live environment
values and arguments remain available. The bootstrap uses Electron's public `app.setAppPath` API
and normal CommonJS loading. See
[Electron's app loader](https://github.com/electron/electron/blob/v41.5.0/lib/browser/init.ts).

Metadata changes update the existing runtime when the bundle identifier and Electron version match.
Volatile environment defaults stay outside the signed bundle. The bundle includes the microphone
usage description. Signing adds `com.apple.security.device.audio-input` and Electron's JIT entitlements.
Eight focused launcher tests passed, including an empty LaunchServices environment, live overrides,
argument preservation, isolated entry loading, and runtime reuse. Targeted lint and syntax checks
passed. Strict signature verification reported a native arm64 app with a bound Info.plist and the
audio-input entitlement.

With `ELECTRON_RUN_AS_NODE` removed from the launcher environment, LaunchServices attributed both
Electron and its directly spawned host to the Dev bundle. Updated user grants then permitted the
live capture and insertion checks above. The Dev signature uses an ad-hoc CDHash requirement, so
rebuilding and signing can require a fresh grant.

The host stays attached to Electron and spawns without a shell. It does not daemonize or override
the OS-assigned responsible identity. Its permission result comes from its own native APIs, without
assuming that an Electron grant implies access. Release packaging must preserve the native app
entry, usage description, audio-input entitlement, and signed helper, then verify the packaged path.

## Focus lookup after permission grants

The live editor test exposed two focus checks that rejected valid text fields after permission was
granted. The system-wide `AXFocusedUIElement` query returned `cannotComplete`, while querying the
frontmost app's Accessibility object succeeded. A standard `NSTextView` also omitted `AXEnabled`
and `AXEditable`, despite providing settable text and a valid selection range.

[Insertion.swift](macos/Insertion.swift) now queries `AXUIElementCreateApplication` using the
frontmost process ID. The focused element must belong to that process, and the app must still be
frontmost after validation. Unsupported or unimplemented `AXEnabled` is allowed for a text-role
element with a valid selection range. A paste target need not support direct `AXSelectedText` or
`AXValue` writes. Explicit disabled/read-only values, malformed enabled values, and communication
failures still reject the target. Existing protected-field, caret, and modifier checks remain.

Recording startup reads the frontmost app's accessibility role and focus, and requests
`AXManualAccessibility` if no text control is exposed. This lets Electron initialize its DOM
accessibility tree while recording. Confirmation rechecks app/element identity and selection
without repeating the entire eligibility scan. Native self-tests and protocol tests cover these
changes; the earlier live insertion evidence above predates this update.

The separate cleanup correction and its focused regression coverage are recorded in the
[design validation notes](../../../docs/internals/dictation-design.md#validation-status).

## Read-only diagnostics

Compare Electron's `systemPreferences.isTrustedAccessibilityClient(false)` with the attached
helper's non-requesting permission result. Correlate fresh TCC records with the actual app and host
processes. Keep setup incomplete while required grants are absent; do not infer trust from bundle
names or edit TCC records.

```sh
codesign -d -r- --verbose=2 native/dictation/build/host/pathway-dictation-host
/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' 'apps/desktop/.electron-runtime/Pathway (Dev).app/Contents/Info.plist'
/usr/bin/log show --last 10m --style compact --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "pathway-dictation-host"'
```
