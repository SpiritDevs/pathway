# Dictation reference research

Research supporting [the dictation design](dictation-design.md). These findings describe the inspected sources; the design records Pathway's agreed behavior.

## Reference findings

Research date: 2026-09-12. Inspected Sotto commit [`f40309e7c59f2f1308d17d3da755b0485e43d92e`](https://github.com/davis7dotsh/sotto/tree/f40309e7c59f2f1308d17d3da755b0485e43d92e). Findings below describe the reference implementation, not commitments for Pathway.

- Sotto uses native SwiftUI and AppKit and targets Apple Silicon with macOS 14 or newer. Its license file identifies the project as MIT licensed.
- Its current offering is one speech model, Whisper large-v3-turbo, plus an optional Qwen3 proofreading model. It does not provide a catalog of interchangeable speech models.
- Its existing shortcut flow is hold-to-talk. Fn is an option; Right Option is the initial default. Double-tap locking is additional Pathway behavior.

Sources: [README](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/README.md), [license](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/LICENSE).

### Reuse candidates

| Area                 | Reference behavior                                                                                                       | Pathway implication                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native speech worker | A persistent C++ whisper.cpp child accepts one inference request at a time over private pipes.                           | Investigate reusing the worker with platform-specific build changes. Keep expensive inference outside Electron's main process.                                  |
| Text cleanup         | Current production helper uses Swift MLX. Legacy llama.cpp C++ source remains in the repository.                         | Windows needs a compatible inference runtime. Evaluate the retained helper before selecting separate runtimes for each OS.                                      |
| Dictionary           | Named lists of preferred terms and explicit aliases; lists all apply together.                                           | Matches the agreed dictionary organization; adapt the editor and add account synchronization.                                                                   |
| Model installation   | Pinned artifacts, progress, cancellation, integrity verification, atomic install, and removal.                           | Reuse the lifecycle design. Broader speech-model selection requires additional catalog work.                                                                    |
| Insertion            | Captures the original field and caret, revalidates before writing, and distinguishes attempted from confirmed insertion. | Adapt the transaction to the user's chosen current-field policy. Preserve verification and single-delivery rules; native APIs differ between macOS and Windows. |
| Recording feedback   | Nonactivating bottom panel with an independently observed audio meter.                                                   | Recreate presentation within Pathway's desktop integration. Add locked controls and the transcript panel from the user's screenshots.                           |
| History              | Reference stores transcripts and recordings together.                                                                    | Adapt to the agreed text-only history; do not inherit audio retention.                                                                                          |

Reference sources: [architecture](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/docs/architecture.md), [text correction](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/docs/text-correction.md), [delivery transaction](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/Sources/Sotto/System/TextDeliveryTransaction.swift), and [history](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/docs/local-history.md).

Substantial source reuse must carry the reference's copyright and license notices. Model and dependency notices are listed separately in [THIRD_PARTY_NOTICES.md](https://github.com/davis7dotsh/sotto/blob/f40309e7c59f2f1308d17d3da755b0485e43d92e/THIRD_PARTY_NOTICES.md).

### Windows feasibility

Sotto's speech and legacy text workers contain reusable inference and pipe-protocol code. Their builds explicitly require Apple platforms, and parent-process monitoring uses macOS/BSD APIs. Windows needs build, process-lifecycle, and accelerator-selection changes. The retained text helper hardcodes GPU offloading and is not a drop-in Windows binary.

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) both document Windows builds and CPU/GPU backends. A candidate is Whisper large-v3-turbo for recognition and Qwen3-4B-Instruct-2507 GGUF for cleanup, reusing the legacy Sotto path. Compatible backends do not establish acceptable latency on typical Windows laptops; runtime selection and minimum hardware need validation.

Candidate multilingual speech downloads from [the upstream artifact revision](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1):

| Model                  | Download bytes | Approximate size |
| ---------------------- | -------------: | ---------------: |
| Whisper Base           |    147,951,465 |           148 MB |
| Whisper Small          |    487,601,967 |           488 MB |
| Whisper large-v3-turbo |  1,624,555,275 |          1.62 GB |

Use multilingual artifacts without the `.en` suffix. Model availability and languages are documented by [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) and [Whisper](https://github.com/openai/whisper#available-models-and-languages). A smaller download is not a measured latency guarantee.

The retained [Qwen3-4B-Instruct-2507 Q4_K_M GGUF artifact](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/blob/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf) is 2,497,281,120 bytes. It can serve both platforms through llama.cpp with different native binaries. Turbo plus Qwen therefore totals about 4.12 GB of weights, excluding native helpers and speech detection. This is a compatibility finding; release-to-text latency, peak memory, and multilingual cleanup quality still need measurements.

Microsoft documents [Fn events as OEM-specific](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/system-button-narration). Its [virtual-key table](https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes) includes Right Control without a universal Fn key. This supports the agreed Right Control default on Windows, with Fn available only where detectable.

### Pathway integration findings

- Desktop already uses native child processes and typed IPC. [SnapShot accessibility](../../apps/desktop/src/snapShot/SnapShotAccessibilityProcess.ts) keeps potentially blocking OS calls out of the main process.
- [Settings navigation](../../apps/web/src/components/settings/settingsSearch.ts) centrally defines headings, routes, and search labels. A Dictation group fits the existing structure.
- [Desktop client settings](../../apps/desktop/src/settings/DesktopClientSettings.ts) persist locally through IPC. They do not provide account synchronization for dictionary or history.
- Existing [macOS](../../apps/desktop/src/snapShot/MacModifierPairShortcutProcess.ts) and [Windows](../../apps/desktop/src/snapShot/GlobalShiftShortcutWorker.ts) modifier helpers emit rising-edge triggers only. Dictation needs press/release events and a recording state machine.
- [The permission panel](../../apps/desktop/src/snapShot/MacPermissionSetup.ts) is an existing bottom-positioned window that can appear without taking focus.
- [Paste modifier repair](../../apps/web/src/shortcutModifierState.ts) already addresses synthetic dictation pastes that leave browser modifier tracking stale.
- This checkout's mobile client is native SwiftUI under `apps/pathway-ios`; it has no `apps/mobile` or Android application package. This differs from the introductory description in `AGENTS.md` and must inform any later mobile scope.
- [Personal alert policies](../../packages/backend/convex/threadAlertPolicies.ts) provide an existing account-owned Convex query/mutation pattern. [Their client state](../../apps/web/src/threadAlerts/state.ts) clears on account changes. This is a simpler starting point for a personal dictionary than the company-scoped replication engine. Dictation still needs a desktop cache of the current account's dictionary; durable offline editing is a separate decision.
- [Desktop lifecycle](../../apps/desktop/src/app/DesktopLifecycle.ts) keeps macOS running with no windows but quits Windows when all windows close. There is no existing Electron tray implementation. Closing the main window destroys it, including the renderer that supplies authenticated account readiness. Background dictation needs a deliberate lifetime for that authentication and dictionary subscription.
