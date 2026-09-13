# Dictation design

Status: implementation authorized after the 27-question design interview and implemented in this
worktree. Mac permissions, both native insertion paths, and the complete microphone-to-external-app
flow have passed live checks. Physical shortcuts, Windows execution, release-package permissions,
broader language coverage, and performance measurements still need validation.

## Scope and ownership

Dictation turns speech into text for applications on the user's desktop. Cleanup is intended to
remove fillers, repetitions, and spoken self-corrections while preserving meaning and language.

The first release targets Apple Silicon Macs and Windows x64. Recording, model downloads, and
inference belong to the speaking desktop regardless of the connected agent environment. Pathway
Cloud sign-in remains required. Browser-only clients, mobile, Intel Macs, Windows ARM, and Linux
do not expose these controls. A browser text field can still receive desktop dictation.

The implementation adapts [Sotto](https://github.com/davis7dotsh/sotto), including its native capture,
shortcut and insertion patterns, speech worker, retained llama.cpp cleanup worker, and dictionary
rules. Windows support, locked recording, settings, and current-field delivery are Pathway additions.
Copied code retains license notices. See [reference research](dictation-reference.md),
[desktop ownership](../adr/0034-dictation-processing-belongs-to-the-desktop-client.md), and
the [user guide](../user/dictation.md).

| Responsibility                                        | Implementation                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared state and IPC                                  | [Contracts](../../packages/contracts/src/dictation.ts), [IPC handlers](../../apps/desktop/src/ipc/methods/dictation.ts), [preload bridge](../../apps/desktop/src/dictation/preloadBridge.ts)                             |
| Capture lifecycle, delivery, and account storage      | [DictationController](../../apps/desktop/src/dictation/DictationController.ts), [DictationStorage](../../apps/desktop/src/dictation/DictationStorage.ts)                                                                 |
| Native helpers, overlay, tray, and background windows | [DesktopDictation](../../apps/desktop/src/dictation/DesktopDictation.ts), [NativeDictationHost](../../apps/desktop/src/dictation/NativeDictationHost.ts), [host implementations](../../native/dictation/host/README.md)  |
| Models and inference                                  | [DictationModels](../../apps/desktop/src/dictation/DictationModels.ts), [DictationInference](../../apps/desktop/src/dictation/DictationInference.ts), [engine builds](../../native/dictation/engines/CMakeLists.txt)     |
| Settings and dictation bar                            | [DictationPage](../../apps/web/src/components/dictation/DictationPage.tsx), [widget HTML](../../apps/desktop/src/dictation/widgetHtml.ts), [client store](../../apps/web/src/dictation/useDictation.ts)                  |
| Dictionary sync and text handling                     | [Cloud coordinator](../../apps/web/src/dictation/cloud.ts), [account queries and mutations](../../packages/backend/convex/dictationDictionary.ts), [text processing](../../apps/desktop/src/dictation/textProcessing.ts) |

## Setup and model controls

**Dictation** groups the settings views. Before setup, its page contains only an introduction card
and **Set Up Dictation**. The CTA opens a staged wizard for permissions, model downloads, microphone
selection and testing, and shortcut configuration. Configuration sections do not appear below the
introduction card. After setup, Models, History, Dictionary, and Settings are separate views.
History and Dictionary remain accessible when dictation is off or speech models have been removed.

The Mac Accessibility step reuses the
[SnapShots permission panel](../../apps/desktop/src/snapShot/MacPermissionSetup.ts). It opens the
correct System Settings pane and supplies the app for native drag-and-drop, with reveal-in-Finder
and return controls. Users should not have to locate the application themselves. Returning to the
wizard rechecks permission before continuing. Microphone access uses the operating-system prompt.

| Role               | Model                              | Approximate download |
| ------------------ | ---------------------------------- | -------------------: |
| Speech             | Whisper Base                       |               148 MB |
| Speech             | Whisper Small                      |               488 MB |
| Recommended speech | Whisper large-v3-turbo             |              1.62 GB |
| Cleanup            | Qwen3-4B-Instruct-2507, 4-bit GGUF |              2.50 GB |

Setup recommends Turbo and Qwen, about 4.12 GB of weights. The original app download includes native
executables and notices, not weights. Speech downloads include their required VAD artifact.
Installations verify pinned artifacts before publishing them. Progress, cancellation, retry, model
selection, and removal are explicit controls. A shortcut never initiates a download.

Installing, selecting, enabling, and loading a model are separate states. Removing the selected
speech model disables dictation. Disabling stops capture and shortcut listeners, cancels delivery,
and unloads workers while keeping installed models, dictionary entries, and history.

Cleanup defaults on. Recognition still delivers usable text if cleanup fails, is unavailable, or
does not pass text checks. The result indicates that cleanup was unavailable. Users can select a
spoken language or automatic detection. Cleanup checks pass for the English, Spanish, and French
fixtures described below. Additional languages and longer real recordings still require validation.

Models unload after five idle minutes by default. Settings also offers immediate unloading,
15 minutes, or keeping models loaded until quit. Downloaded files remain after unloading.

Models begin loading when recording starts, without holding up microphone capture. Speech and
cleanup workers are reused after preparation, with cancellation and unload invalidating pending
loads. The detected speech language is forwarded to cleanup when automatic language selection is
enabled, avoiding a second classification pass. If cleanup preparation is still running, desktop
delivery immediately uses recognized text while the worker finishes loading for later recordings.
Loaded cleanup has a five-second deadline; timeout falls back to recognized text.

## Capture and state transitions

The default shortcut is Fn on Mac and Right Control on Windows. Both platforms offer Right Control,
the right Option or Alt key, and F8. Windows Fn is not offered in the current UI.

| Action or event                         | Behavior                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Hold the shortcut, then release         | Record while held, then process once. A short first tap does not produce a stray transcript. |
| Double-tap                              | Start locked recording.                                                                      |
| Bar, tray, or command-palette Record    | Start locked recording.                                                                      |
| Tap again or select Accept while locked | Finish and process.                                                                          |
| Escape or Cancel                        | Discard recording or cancel processing.                                                      |
| Five-minute limit                       | Show a countdown near the limit, then finish normally.                                       |
| Microphone disconnect                   | Process usable captured speech for review without insertion.                                 |
| Sleep or screen lock                    | Cancel unfinished work.                                                                      |

One session owns capture and processing at a time. Each session snapshots the microphone, speech
model, dictionary, language, and cleanup preferences. Changes affect subsequent sessions. A fixed
microphone is not silently replaced when unavailable. Tests show their result in Settings without
insertion, clipboard writes, or saved history.

Session and account generations reject late callbacks. Releasing during microphone startup cannot
return processing to recording or create a second pipeline. Cancellation prevents subsequent model
output from reaching insertion. It cannot promise to undo a write already dispatched to another app.
Native shutdown completes before account reconfiguration.

Completion and cancellation remove temporary audio. Initialization removes orphaned recording files
from a previous process crash. No-speech and transcription errors offer another recording instead
of retaining audio for retry.

## Bar and text delivery

The idle bar is static and visible by default. Hover reveals Record, Settings, History, and Hide.
Quick hide is local to the overlay and resets when recording starts; it does not disable shortcuts
or change the persistent idle-bar preference. The tray can also show it again. History
opens five recent entries with Copy actions and View all history. Hiding the idle bar keeps active
recording and processing feedback visible.

The recording view shows microphone levels. Locked recording adds Cancel and Accept. Processing,
result, and error views are distinct. Meter messages update the overlay separately from the main
window; microphone tests receive meter updates in Settings. The overlay stays on the chosen display
for the recording and processing cycle and does not take focus from a text field. On macOS its
all-workspaces configuration skips the process-type transformation, which would hide the entire
application when the overlay is created. Main-window selection uses the registered main window
and does not fall back to an auxiliary overlay.

[Preload subscriptions](../../apps/desktop/src/dictation/preloadBridge.ts) fetch an initial state
snapshot so a listener attached during recording can merge subsequent meter events. This also
covers an overlay reload or a remounted microphone test. A newer state event takes precedence over
the initial reply, and unsubscribing prevents a pending reply from reaching the listener.

Delivery resolves the editable field focused when processing finishes, as chosen in the interview.
The native helper validates that target immediately before one insertion attempt. Unusable fields
produce a result panel. Unconfirmed attempts keep the text available and warn against a duplicate
paste. No delivery synthesizes Enter or submits a form.

On Mac, [insertion](../../native/dictation/host/macos/Insertion.swift) queries the frontmost
application's Accessibility object. It requires the focused element to belong to that process and
rechecks that the application remains frontmost. This avoids a system-wide focus query that returned
`cannotComplete` for a valid native text editor. Unsupported `AXEnabled` attributes are accepted
for a text-role element with a valid selection range; direct text setters are not required for paste. Explicit disabled values and
communication failures still prevent insertion; field, caret, modifier, and protected-text checks
remain in place.

When capture starts, the Mac helper requests `AXManualAccessibility` from the frontmost app so
Electron editors expose their focused DOM controls before delivery. A text field with a usable
selection can accept paste even when its text attributes are not directly writable. Confirmation
checks focus identity and selection rather than repeating the complete editability scan.

Automatic insertion preserves the clipboard. Temporary paste restoration must not overwrite a newer
user copy. Result and History Copy actions replace the clipboard. Insertion errors and history-save
failures must not discard recognized text or trigger another insertion.

The fixes apply to the desktop overlay and all recording entry points: global shortcut, bar, tray,
command palette, and Settings microphone tests. The controller and cleanup worker are shared by
Mac and Windows; workspace visibility and Accessibility changes are Mac-specific. Browser-only and
mobile clients do not run dictation. The development web overlay preview includes the hide control.
Remote environment, relay, tunnel, and provider routing are unchanged because capture and delivery
remain owned by the speaking desktop. The hide action uses overlay IPC rather than server contracts;
recording or the tray restores it. The user guide describes these behaviors.

## Dictionary, history, and accounts

The dictionary belongs to the personal Pathway account. Named lists organize preferred spellings
and explicit corrections, with all lists active for every recording. The editor supports list and
term creation, renaming, deletion, and aliases. It rejects conflicting aliases. Paragraph expansion
and per-app dictionaries are outside this release.

Account queries and mutations sync confirmed changes to desktop caches. Revision checks reject stale
saves from another computer. Offline dictation reads the cache; edits require a cloud connection.
Dictionary snapshots remain stable during recording. Whole-word and phrase corrections use longest
matches without cascading replacements.

History stores original recognized text and final text separately within each desktop account. The
final text appears first, with original inspection and Copy actions. Retention defaults to 30 days,
with 1, 7, 30, 90, or 365 days, or indefinite retention available. Users can stop future saving and
delete one entry or all entries. Both text versions follow the same deletion rules. No history audio
or history synchronization is implemented.

| Data                                                                                | Owner                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| Dictionary                                                                          | Personal cloud account with a desktop cache     |
| History                                                                             | Current account on this desktop                 |
| Microphone, shortcut, enable state, bar, language, retention, and model preferences | This desktop                                    |
| Model files and worker memory                                                       | This desktop, independent of agent environments |
| Recording audio                                                                     | Temporary desktop input                         |

Sign-out, account switching, renderer loss, and full renderer navigation revoke active dictation.
Account-specific views must reset using account identity, without relying on an intermediate
signed-out render. Cached account identifiers never establish authentication.

## Background operation and packaging

Closing the main window while dictation is enabled hides and retains the authenticated renderer.
The tray or menu bar keeps Record, Settings, History, Open Pathway, enable/disable, and Quit reachable.
Explicit Quit stops dictation. Disabling or signing out destroys the inactive overlay so it cannot
keep Windows running after the main window closes. This feature does not change launch-at-login
preferences. See the [background-lifetime decision](../adr/0035-enabled-dictation-keeps-pathway-running.md).

Native capture, permissions, shortcuts, insertion, and model execution run outside Electron's main
process. Settings and status use desktop IPC. Audio and model traffic never traverse agent
environment connections. Provider adapters receive ordinary input text and need no dictation branch.

Native [host](../../scripts/build-dictation-host.mjs) and
[engine](../../scripts/build-dictation-engines.mjs) build scripts produce the executables used by
[desktop packaging](../../scripts/build-desktop-artifact.ts). The
[native dictation workflow](../../.github/workflows/dictation.yml) provides macOS and Windows build,
self-test, protocol, and engine smoke checks. Adding this workflow does not establish a successful
Windows build or desktop interaction test.

## Validation status

The startup, quick-hide, focused-field, and latency corrections have a new focused validation pass:
116 tests across eight controller, inference, model, overlay, preload, and window files passed,
as did desktop typechecking and targeted lint. The Swift host builds and passes native self-tests
and protocol tests. The Metal engines build, native speech smoke checks pass, and all 48 multilingual
cleanup checks pass with the retained prompt prefix. For the same 11-second JFK fixture on an
M2 Max, warm Turbo-plus-cleanup medians were 3.58 seconds before and 1.91 seconds after. Initial
model/Metal preparation remains substantially slower and is measured separately. See the
[engine benchmark notes](../../native/dictation/engines/README.md) for commands and limits.
This pass used no browser or desktop interaction; M1 timings, current live paste behavior,
and Windows execution remain unverified. The live-client evidence below predates these corrections.

Current evidence covers different layers and should be reported separately:

- Real downloads and artifact verification for the recommended Turbo and Qwen pair passed in an
  isolated Electron instance. This verifies setup downloads, not the quality of the pair's output.
- The actual Mac native host passed its self-tests and protocol tests. Real Base inference passed
  transcription, reuse of a loaded model, five-minute silence, Unicode audio paths, and duration
  rejection. Apple Silicon Metal and CPU-only engine builds compiled. The current engine artifacts
  are the Metal build.
- The integrated focused suite passed 167 tests across 18 files. Coverage includes cancellation,
  startup and failure races, permission selection and refresh, account changes, orphan recording
  cleanup, insertion failure without retry, retention, and deletion isolation. All 27 engine
  downloader/protocol fixture tests pass. Preload regressions cover initial snapshots, newer state
  events, and unsubscribe; controller coverage rejects stale recording meter events. These checks
  do not replace native desktop interaction.
- Three cleanup regression cases cover the full `I meant` correction cue, retaining the corrected
  quantity, and delivering valid cleanup through the controller. The prior guard recognized `I mean`
  but could incorrectly require `meant` to survive cleanup. The tests use synthetic text; they do not
  establish why one
  earlier live recording fell back, since inference errors and rejected candidates share that status.
- Strict cleanup checks passed 48 of 48 on Metal and 24 of 24 on the CPU-only build. The matrix has
  12 English, Spanish, and French cases, each with automatic and explicit language selection.
  Metal ran twice with reversed case order; CPU ran once. Cases cover fillers, repetitions, spoken
  corrections, quantities, negation, names, and preserving a dictated request to translate.
  The original assertions remain intact, and fallback text does not count as successful cleanup.
- With cached weights on this Mac, Metal fixture medians were 1.69 seconds with automatic language
  detection and 1.43 seconds with an explicit language. Short CPU fixtures took roughly 8 to
  13 seconds. These are fixture timings, not general dictation latency guarantees. See the
  [engine validation limits](../../native/dictation/engines/README.md#current-validation-limits).
- Both Mac permissions are granted in the corrected Dev app, and the setup view shows Allowed.
  Three real microphone recordings passed through the actual controller with Turbo and Qwen.
  Two applied cleanup; one retained recognition with the cleanup-unavailable status.
- A native host launched as a child of the granted Dev Electron app inserted exact text into an
  independent AppKit `NSTextView` through `AXSelectedText`. A second live check configured selected
  text as nonsettable and passed through the Cmd+V path. The clipboard sentinel remained unchanged
  in both checks.
- After restarting the Dev app, grants persisted and the complete microphone-to-external-editor
  flow passed. Controlled speech played through speakers entered the default webcam microphone,
  then passed through Whisper Turbo, Qwen cleanup, and Cmd+V insertion. The input was "Please prepare
  six boxes. Sorry, I meant eight boxes. Then label the remaining boxes." The editor received
  "Please prepare eight boxes. Then label the remaining boxes." The controller reported cleanup
  applied and delivery inserted, and the clipboard sentinel was preserved. The observed stages
  were starting, recording, processing, and result.
- Injected global Right Control events passed double-tap to lock recording and tap again to finish,
  followed by cleanup and exact insertion into the external editor with the clipboard preserved.
  In the final run, an overlay listener attached during recording received positive levels and
  advancing duration after the preload fix. A new locked recording cancelled to idle through
  injected global Escape, leaving history unchanged. These checks exercise native shortcut routing
  with generated key events. Physical Fn gestures remain unverified.
- Windows native compilation and execution were unavailable on this machine. The new workflow
  provides compilation and native checks; its result and Windows microphone, shortcut, focus, and
  clipboard behavior still need verification.
- Dictionary queries, mutations, and revision checks have focused backend coverage. The new Convex
  function has not been deployed by this task; live dictionary editing and synchronization across
  desktops still need verification after that deployment.
- Additional languages and longer real recordings remain unverified. Constrained model output
  ensures the answer format, not semantic accuracy. The controller still validates candidates and
  retains usable recognition when cleanup fails or changes protected content.

Representative hardware measurements still need startup impact, idle CPU and GPU use, peak memory,
cold and warm release-to-text latency, and Windows CPU fallback. Background account readiness,
close/reopen, disable/re-enable, and explicit Quit also need integrated desktop checks. Screenshots of
controlled UI states document presentation; they do not establish native capture or inference success.

### Development permission attribution

The Dev launcher uses Electron as its native bundle executable and loads the development entry
through a Resources/app bootstrap. Signing includes microphone access. LaunchServices now attributes
both Electron and its attached capture host to the Dev app, and updated user grants passed live
capture and Accessibility operations. The earlier shell entry point attributed requests to the
running Nightly app, which lacked the microphone entitlement. That failure did not establish a
helper grant-inheritance bug. See [permission evidence](../../native/dictation/host/PERMISSIONS.md)
for the correction and remaining packaged-app verification.
