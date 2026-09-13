# SnapShots

Pathway's desktop capture implementation is adapted from [T3 Code PR #8103](https://github.com/pingdotgg/t3code/pull/8103), merge commit `299404a754f52c02c69634528d8856b3c93b378c`. The original license remains in `THIRD_PARTY_LICENSES/T3_TOOLS_LICENSE.txt`.

## Capture and delivery

`apps/desktop/src/snapShot/DesktopSnapShot.ts` owns opt-in capture, permission state, shortcut registration, native acquisition, feedback, and the pending capture queue. macOS and Windows support active-window, current-screen, and region capture. Screen capture selects the display containing the pointer; region capture selects an area before editing. Wayland selects a desktop-specific backend or the screenshot portal/picker and currently advertises window capture only. Unsupported capture types fail explicitly. X11 is unavailable. [Linux capture](linux-snap-shot.md) describes compositor setup and identity matching.

The shortcut captures on the desktop client's computer, regardless of which environment hosts the active thread. It never asks a remote server to capture its screen. Settings are local to the desktop installation. Disabling capture releases its listeners; OS permissions and installed compositor helpers have their own removal controls.

The desktop saves the PNG and source metadata before announcing that a capture is ready. IPC lists pending metadata separately from image bytes. `SnapShotCoordinator` pins the current draft or environment/thread reference and opens the annotation editor before delivery. The editor renders the image with editable marks and exports a flattened PNG. Copy, Save to chat, and Download each close the editor after successful completion. Save to chat handles draft promotion, compresses the image if necessary, and rescales accessibility coordinates to match; it acknowledges the capture only after verifying the saved draft. A failed action leaves the pending copy available for retry.

Capture modes have independent global shortcuts. The existing `snapShotShortcut` remains the window binding; `snapShotScreenShortcut` and `snapShotRegionShortcut` are nullable and default to unassigned. `DesktopSnapShotState.captureTypes` advertises available modes, while `captureShortcuts` reports each binding's registration result. Web code treats older desktop bridges without these fields as window-only. Settings rejects collisions among capture modes and existing keybindings. The command palette and Settings capture menu expose the same actions, with unsupported modes disabled.

Capture requires the renderer to bind its signed-in account through trusted IPC. Pending records belong to the account that started capture; only that account can list, read, or acknowledge them. Signing out pauses capture without changing the preference, and account changes invalidate in-flight delivery. Older unowned queue records remain inert. Account identifiers are queue bookkeeping and never become attachment metadata or provider context.

Accessibility extraction runs in a separate, disposable process. Failure, timeout, or missing accessibility permission can produce a screenshot without app text. Screen, region, and portal picker captures do not attach accessibility from an unrelated window. The capture flash and sound remain optional; captures now go through the editor instead of animating directly into a draft. The stored `snapShotAnimations` preference remains backward-compatible but is no longer exposed in Settings.

Collection and compaction limit accessibility trees to 128 levels, marking truncated results while retaining the screenshot. Disabling capture also prevents an in-flight worker from warming its pool again.

## Attachment metadata

`packages/contracts/src/snapShot.ts` defines optional image `source` metadata: capture time, application name and identifier, window title, app icon, and accessibility text or an element tree. Trees use captured-image coordinates, with null bounds when a position cannot be trusted. Text and serialized trees are capped at 32,000 characters, and icon data URLs at 100,000 characters.

Pathway's attachment contracts live in `chatAttachment.ts`, unlike the upstream PR's older orchestration module. `ws.ts` retains source metadata for both inline image data and claimed HTTP upload receipts. The V2 command/event/projection paths preserve it through retries and history. Native Apple clients preserve the same metadata when caching or resending attachments and expose it in image details.

## Provider boundary

Pathway dispatches through `orchestration-v2/ProviderSessionManager.ts`, rather than the upstream legacy `ProviderService`. The common start/steer boundary appends bounded captured-window JSON using `attachmentPrompt.ts`. This covers Codex, Claude, Cursor, Grok, OpenCode, and registered ACP adapters while retaining their existing image transport.

Captured text is labelled untrusted data. Redundant accessibility structure is compacted, app icon bytes are omitted from the prompt, and metadata is added only while the final prompt fits the input limit. The persisted user message stays unchanged, so retries do not append duplicate context.

## Packaging and checks

The desktop bundle includes separate shortcut, accessibility, region capture, and Windows focus workers. Native dependencies stay outside the renderer. Linux artifacts additionally contain the GNOME extension and KDE/Hyprland helper executables. The build script ships the Wayland protocol license notices alongside the Hyprland helper. The D-Bus patch replaces the obsolete `usocket` dependency with Node's Unix socket transport.

Focused coverage exercises enable/disable, permission timing, shortcut conflicts, native worker failures, IPC sender validation, draft persistence failure, target selection, upload claiming, durable V2 projections, and provider starts/steering. Real screen capture and OS permission behavior require an integrated desktop run on each target platform.
