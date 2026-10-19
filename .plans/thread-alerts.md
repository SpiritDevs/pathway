# Thread alerts: implementation plan

Status: product decisions confirmed on 2026-08-30. This document defines the first desktop and web
release. Canonical vocabulary lives in `docs/internals/glossary.md`. ADRs 0004 through 0031 hold the
detailed product and architecture decisions.

Implementation: desktop and web code is present in the `thread-notifications` worktree as of
2026-09-08. See `docs/internals/thread-alerts.md` for code ownership and deployment order, and
`docs/user/thread-alerts.md` for setup. Automated verification is recorded in the implementation
handoff. Cloud deployment and live browser or packaged OS verification remain separate steps.

## Summary

Thread alerts add a bell to each thread and a dedicated Notifications settings page. Users can turn
all four alert events on or off with one click or edit completion, permission, input, and failure
separately. Global and project policy provide inherited defaults, while thread choices provide the
exception.

Every Attention Event still enters the Notification Tray. Eligible events may also play one local
sound, show one OS notification, or do both. Quiet hours, foreground suppression, three-second
coalescing, and one catch-up summary protect the user's focus. Delivery is at most once per client
installation, but remains independent across the user's devices.

Pathway Cloud owns identity, synced policy, event history, and read state because Cloud sign-in is
required before the app can be used. Each desktop or browser installation owns its sound file,
channel switches, permission state, quiet hours, and delivery cursor. The first release covers web
and desktop. Mobile keeps its existing push settings until a later release.

## Confirmed product intent

- A bell control on a thread lets the user choose whether that thread should alert them.
- Settings provide broader defaults for every thread and for threads in a specific project.
- An alert can use an operating-system notification, a sound, or both; each delivery channel is
  independently toggleable.
- The sound can be chosen from a small built-in list, use the system sound, or come from an uploaded
  audio file.
- Each client selects one sound for every event type and the quiet-hours summary. Per-event sounds
  are out of scope for v1. Settings provide a preview action.
- Custom sounds accept MP3, WAV, M4A, OGG, or WebM audio up to 5 MB and 10 seconds. The client must
  decode the file before saving it. Pathway plays it once without looping, editing, or transcoding.
  Settings provide Preview and Remove actions. A missing saved file falls back to System default.
- OS notifications are posted silently. When sound is enabled, the separate sound channel plays the
  selected sound once. System default asks the platform to play its alert sound where supported and
  falls back to Pathway's bundled default sound in browsers that cannot do so. Enabling both channels
  must not produce two sounds.
- Selecting an individual OS notification focuses or opens the client, navigates to the exact
  environment and thread, and acknowledges only that Attention Event. Selecting a quiet-hours
  summary opens the Notification Tray, whose existing open action marks the whole tray read.
- The first release includes the bell, Alert Menu, settings, sound, and OS notifications on desktop
  and web. Web delivery requires the page to be running. Mobile controls, custom sounds, and Alert
  Policy enforcement are outside this release; existing mobile push preferences remain unchanged.
- New and existing users default to all four global Alert Policy events disabled. The Notification
  Tray stays active. Local sound delivery defaults to enabled with Pathway's default sound, so a
  thread bell works immediately. OS notifications remain disabled until the user enables them and
  grants platform permission.
- Settings gains a dedicated Notifications page with Thread alerts, Project overrides, This device,
  and Quiet hours sections. The existing Project Settings page also exposes that logical project's
  alert override.
- The thread bell sits beside the row's existing settle and status actions. An all-off bell appears
  on row hover or keyboard focus. All-on and mixed bells remain visible. The mixed state uses a
  dotted bell. Tooltips and the Alert Menu identify inherited and explicit values.
- Individual OS notifications use the thread title as the title and the event label plus project name
  as the body. They never include prompt text, commands, file paths, or agent-response excerpts.
  Quiet-hours summaries show thread and event counts without message content.
- The command palette includes Toggle alerts for current thread and Open Notifications settings.
  Toggle alerts is available for user assignment in Keybindings but has no default shortcut.
- Pathway requests OS-notification permission only when the user enables that channel in Settings,
  never on startup or from a bell action. Settings shows Available, Blocked, or Unsupported. A denied
  or revoked permission makes the effective channel off while retaining the user's preference.
  Desktop links to system settings; web provides browser guidance.
- Each client installation delivers an Attention Event at most once. Browser tabs coordinate, and
  reconnects or replayed data do not repeat an alert. Desktop, browser installations, and separate
  devices remain independent and may each deliver the same event.
- Snoozed threads remain alert-eligible. Settled and archived threads retain their overrides but do
  not alert until reopened. Deleting a thread removes its override. Existing Notification Tray
  records continue through their normal retention period.
- Events from one thread coalesce for three seconds on each client. The first eligible event posts
  one OS notification and sound. Later events in the window update that notification with the latest
  event and a count without another sound. The Notification Tray still stores every event.
- A resumed or reconnected client sends one catch-up summary for subscribed events that remain unread
  since that installation's last cursor. It never replays individual alerts. A new installation
  establishes a baseline without summarizing old history. Quiet-hours summaries advance the same
  handled state so events cannot appear in both summaries.
- Notifications Settings includes Test alert. It posts a sample OS notification when enabled and
  permitted and plays the selected sound when enabled. This explicit test bypasses Alert Policy,
  quiet hours, and foreground suppression. It creates no Notification Tray event or unread state.
- An Attention Event must be eligible under Alert Policy when it occurs and remain eligible when a
  delayed delivery fires. Enabling a policy does not wake old events. Disabling a policy removes its
  events from pending quiet-hours and reconnect summaries.
- Pathway Cloud sign-in is an app-wide requirement. Thread alerts use the existing cloud identity,
  policy, and Notification Tray data. They do not add an unsigned local persistence path.
- The relevant moments are when an agent run completes or the agent needs the user, including a
  question or permission request.
- Alert subscriptions use a global -> project -> thread cascade. Global always has an explicit
  enabled/disabled value. A project or thread may inherit, enable, or disable. The closest explicit
  value wins.
- The thread bell shows the effective state and its menu exposes the thread's explicit choice so an
  inherited value is distinguishable from a thread override.
- Alert subscriptions gate sound and operating-system notifications only. Every Attention Event
  still appears in the Notification Tray, including events from threads whose effective alert
  subscription is disabled.
- Completion, permission, user-input, and failure alerts are individually selectable.
- A normal click on a thread bell is the fast path and applies one enabled or disabled choice to all
  four event kinds for that thread.
- Holding Control or Command while hovering the bell opens the Alert Menu for changing individual
  event kinds. Right-click, Control/Command+Enter while keyboard-focused, and long-press on touch
  open the same menu. Ordinary hover shows only a tooltip.
- Each event kind resolves independently through the global -> project -> thread cascade. Project
  and thread values are `inherit`, `enabled`, or `disabled` for each event kind.
- Clicking a bell with a mixed effective state enables all four event kinds. Clicking when all four
  are effectively enabled disables all four.
- The advanced popup can restore every event to the project defaults at once. Each event row also
  exposes `inherit`, `enabled`, and `disabled`, so every individual override is reversible.
- Global, project, thread, and per-event alert choices sync across the user's devices.
- Each device or browser installation owns its sound toggle, operating-system notification toggle,
  selected sound, and uploaded sound file. Changing delivery on one client does not change another
  client or the cloud-synced alert policy.
- A project alert choice is edited from the logical project shown in the sidebar and Project Settings.
  Repository-backed projects store it against stable repository identity, so it covers matching
  worktrees and environments even if another device groups them differently. Non-repository projects
  fall back to environment-scoped project identity. Thread choices remain the narrower exception.
- A client does not play a sound or post an OS notification when its window is focused on the thread
  that produced the Attention Event. It still records the event in the Notification Tray. A client
  showing another thread and other enabled devices may deliver the alert.
- Pathway provides its own device-local quiet-hours schedule in addition to respecting OS-level
  notification controls. The user selects days, start time, and end time in the device's local
  timezone.
- Quiet hours suppress sound and OS notifications but do not suppress Notification Tray records.
  Pathway sends one catch-up summary after the window instead of replaying each suppressed alert.
- The summary includes only subscribed events that remain unread when quiet hours end and groups them
  by thread. It posts one OS notification when that channel is enabled and plays the selected sound
  once when sound is enabled. Selecting it opens the Notification Tray. Reviewing the tray during
  quiet hours removes those read events from the summary.

## Existing system to extend

- `AttentionEventKind` already models `finished-unsettled`, `pending-approval`, `awaiting-input`, and
  `failed` in `packages/contracts/src/focus.ts`.
- `AgentAwarenessRelay` publishes those durable events to the existing Convex-backed Notification
  Tray, so event detection is not a new subsystem.
- iOS relay registrations already store per-device switches for approval, input, completion, and
  failure push notifications. Desktop and web do not currently expose an equivalent OS-alert
  delivery service.
- Current in-app notifications are produced for every Attention Event on every unsettled thread;
  the existing ADR does not define project/thread subscription filtering.

## Domain model

### Policy

`AlertPolicy` is cloud-synced and owned by the signed-in user. It has four boolean event choices:
completion, permission, input, and failure.

The global scope stores all four choices explicitly. Project and thread scopes store an optional
choice for each event. An absent choice means inherit. Resolution is pure and per event:

1. Use the thread choice when present.
2. Otherwise use the project choice when present.
3. Otherwise use the global choice.

The normal bell click writes all four thread choices. If all four effective choices are enabled, it
writes four disabled choices. Otherwise it writes four enabled choices. The Alert Menu can write or
clear one choice without changing the others.

Project scope keys use `repositoryIdentity.canonicalKey` when it exists. Non-repository projects use
`environment:<environmentId>:project:<projectId>`. Thread scope keys use
`environment:<environmentId>:thread:<threadId>`.

### Attention Event eligibility

Every Attention Event remains in `focusNotifications`. A notification row also records:

- `alertProjectKey`, the stable project policy key at the time of the event.
- `alertEligibleAtCreation`, the result of the user's policy for that event kind at insert time.

The client delivers only when `alertEligibleAtCreation` is true and the current policy still resolves
to enabled. This prevents later enabling from waking old events and lets later disabling cancel a
delayed summary.

### Acknowledgements

Keep `focusNotificationStates.readThrough` for Mark all read. Add one acknowledgement row for each
individually opened event. A notification is unread when it is newer than the watermark and has no
acknowledgement row. Remove acknowledgements when their notification is pruned, and delete covered
acknowledgements when the watermark advances.

### Local delivery settings

Extend `ClientSettings` with:

- sound enabled, default true;
- OS notifications enabled, default false;
- selected built-in or custom sound identifier;
- quiet-hours enabled, weekdays, start time, and end time.

Store custom audio bytes and installation delivery state in one versioned IndexedDB database. The
settings JSON stores only the selected asset identifier and metadata. This avoids putting a 5 MB blob
in `localStorage` or `client-settings.json` and gives web and desktop the same storage behavior.

The installation state contains a random installation id, the established event cursor, handled event
ids within the bounded notification retention window, and the active quiet-hours summary window. A
fresh installation records the current newest event as its baseline before it can deliver anything.

## Cloud data and mutations

Add these Convex tables:

### `threadAlertPolicies`

- `userId`: Clerk subject.
- `scopeKind`: `global`, `project`, or `thread`.
- `scopeKey`: fixed global key or the stable project/thread key.
- Four optional booleans, one for each event kind.
- `updatedAt`.
- Unique lookup by `userId`, `scopeKind`, and `scopeKey`.
- Cleanup lookup by `scopeKind` and `scopeKey`.

The global upsert requires all four values. Project and thread upserts delete the row when all four
values inherit. Queries return the global row plus only the project and thread scopes needed by the
current client shell. Mutations validate that a user may write only their own policy.

### `focusNotificationAcknowledgements`

- `userId`.
- `eventId`.
- `acknowledgedAt`.
- Unique lookup by user and event.

Add `markRead({ eventId })`. It is idempotent and succeeds only for an event owned by the signed-in
user. Return `isRead` with each list row, and update `unreadCount` to account for both the watermark
and acknowledgements.

### Lifecycle cleanup

When `agentThreads.remove` or reconciliation deletes a cloud thread row, delete its thread policy for
every user with that exact thread scope key. Archive, settle, snooze, and reopen do not delete policy.
Removing one environment binding or worktree does not delete repository-backed project policy.

## Event flow

```text
provider adapter
  -> AttentionEvents detects one durable event
  -> AgentAwarenessRelay sends event plus stable alertProjectKey
  -> Convex fans out the Notification Tray row to linked users
  -> Convex snapshots alertEligibleAtCreation for each user
  -> signed-in clients receive the row
  -> installation leader checks current policy and thread lifecycle
  -> foreground, quiet-hours, coalescing, and cursor rules run locally
  -> sound and OS channels deliver independently
```

Detection stays provider-neutral. Codex, Claude, Cursor, Grok, and OpenCode continue to feed the same
four Attention Event kinds through their existing orchestration state. No provider-specific alert
setting is added.

## Client runtime

Add pure alert logic under `packages/client-runtime` for:

- policy resolution and bulk bell transitions;
- lifecycle eligibility;
- overnight and same-day quiet-hours windows;
- three-second per-thread coalescing;
- reconnect and quiet-hours summary selection;
- installation cursor and idempotency transitions.

Mount one alert runtime beside the existing cloud sync runtime after cloud authentication is ready.
It subscribes to policy and `focusNotifications`, reads the current route and window focus state, and
owns all timers. It never scans message content.

In browsers, follow the existing `webLeader` pattern and use Web Locks for one active delivery owner.
Use an alert-specific IndexedDB lease when Web Locks are unavailable because the existing in-process
fallback cannot coordinate separate tabs. The owner writes handled state before delivery so a tab
crash cannot duplicate an alert after another tab takes over.

### Immediate events

For a newly observed eligible event:

1. Reject it if the installation cursor already covers it or it has been handled.
2. Reject it if the thread is settled, archived, or deleted. Snoozed remains eligible.
3. Resolve current policy and reject it if disabled.
4. Mark it handled.
5. Suppress local delivery if this client is focused on the originating thread.
6. If quiet hours are active, add it to the pending summary.
7. Otherwise open or update that thread's three-second delivery group.

The first event in a group may play one sound and create one OS notification. Further events update
the notification body and count without another sound. Every event remains a separate tray row.

### Resume and quiet-hours summaries

On resume, reconnect, or leader acquisition, select eligible unread rows after the installation
cursor. Recheck current policy and lifecycle, mark the selected rows handled, and post at most one
catch-up summary. Quiet-hours completion uses the same handled state, filters out events acknowledged
while quiet hours were active, and posts at most one summary. A row can never enter both summaries.

## Desktop delivery

Add a typed `DesktopBridge` surface for:

- posting or updating a silent native notification with a stable delivery id;
- closing a native notification;
- playing the system alert sound;
- opening the platform notification settings when supported;
- reporting native notification support;
- sending a notification-click event back to the renderer.

The Electron main process owns native notifications and window reveal. A click reveals or creates the
main window, then sends the event target to the renderer. The renderer navigates only after its route
runtime is ready and then calls `markRead`. The existing Windows AppUserModelID setup remains the
notification identity. The renderer owns bundled and custom audio through Web Audio; the main process
is used only for the system alert sound.

Electron does not expose one reliable cross-platform permission query. The desktop adapter must map
the best available platform state into Available, Blocked, or Unsupported and treat an unknown state
as Available until a delivery fails. The implementation must verify signed macOS builds, the Windows
AppUserModelID and shortcut path, and at least one supported Linux notification environment. Failure
must disable only the effective OS channel and must not affect sound or Notification Tray delivery.

## Web delivery

Use the Web Notifications API only while the page is running. Enabling OS notifications in Settings
is the only action that may call `Notification.requestPermission()`. A notification click focuses its
window, navigates to the event target, and acknowledges the event. Unsupported or denied permission
leaves the saved preference intact while the effective channel is off.

Browsers do not expose a portable system alert sound. Selecting System default therefore plays the
bundled Pathway sound on web.

## Interface changes

### Thread rows

Add `ThreadAlertBell` beside the existing snooze and settle controls in `SidebarThreadRow`. Keep its
state and mutations outside the row so virtualized or hidden rows do not each subscribe to Convex.

- All off: visible on row hover or keyboard focus.
- All on: visible at rest.
- Mixed: visible at rest with a dotted bell.
- Normal click: bulk toggle.
- Control/Command hover, right-click, Control/Command+Enter, or long press: Alert Menu.
- Tooltip: effective state and whether it is inherited or explicit.

The Alert Menu lists the four event kinds with Inherit, On, and Off choices plus Use project defaults.
Every operation has an accessible name and works without hover.

### Settings

Add `/settings/notifications` to the settings catalog, sidebar, search index, and route tree. Sections:

1. Thread alerts: four global event toggles.
2. Project overrides: searchable logical projects with per-event tri-state values.
3. This device: sound, sound picker/upload/preview/remove, OS notifications, permission state, and
   Test alert.
4. Quiet hours: enable, weekdays, start, end, timezone label, and summary explanation.

Project Settings shows the same project override control. The command palette adds Toggle alerts for
current thread and Open Notifications settings. Add an unbound `threadAlerts.toggle` keybinding action.

## Sound validation

Accept MP3, WAV, M4A, OGG, and WebM by file extension and browser-reported MIME type. Reject files
over 5 MB before reading. Decode with Web Audio, reject undecodable audio or duration over 10 seconds,
then write the original bytes to IndexedDB. Preview uses the same playback path as a real alert.
Playback stops any prior preview or alert sound before starting, never loops, and releases decoded
buffers and object URLs when no longer needed.

## Implementation sequence

### Phase 1: contracts and pure logic

- Add `packages/contracts/src/threadAlerts.ts` and export it through the package map.
- Extend Attention Event and Focus notification schemas with stable project policy identity and
  creation-time eligibility.
- Extend `ClientSettingsSchema` and `DesktopBridge` with backward-compatible defaults.
- Add policy, quiet-hours, coalescing, and delivery-state reducers to `packages/client-runtime`.
- Add focused unit tests for every inheritance, timing, lifecycle, and cursor rule.

### Phase 2: cloud persistence

- Add the policy and acknowledgement tables and indexes.
- Add policy list/upsert/reset mutations and per-event `markRead`.
- Snapshot creation-time eligibility in `focusNotifications.record` without filtering the log.
- Add acknowledgement-aware unread and retention behavior.
- Clean thread policies from agent-thread deletion and reconciliation paths.
- Add Convex tests for authorization, idempotency, policy inheritance, fanout, and cleanup.

### Phase 3: client state and settings

- Subscribe once to policy and notification rows from the existing cloud runtime.
- Add the IndexedDB sound and delivery-state store.
- Add Notifications Settings, Project Settings override, permission states, custom sound validation,
  and Test alert.
- Add settings search entries and route tests.

### Phase 4: thread controls and navigation

- Add the bell and Alert Menu to full and slim thread rows.
- Add command palette actions and the unbound keybinding action.
- Add individual event acknowledgement and exact thread navigation.
- Test pointer, keyboard, modifier-hover, context-menu, and long-press behavior.

### Phase 5: delivery adapters

- Add the web notification and audio adapters.
- Add Electron native notification IPC, click routing, support checks, system settings, and system
  sound.
- Add the installation leader, immediate delivery, foreground suppression, coalescing, reconnect
  summary, and quiet-hours summary.
- Verify one delivery across multiple browser tabs and one independent delivery per installation.

### Phase 6: user documentation and integrated proof

- Add `docs/user/thread-alerts.md` covering setup, inheritance, permissions, quiet hours, privacy,
  browser limitations, and troubleshooting.
- Link it from the user documentation index and update any Settings reference page.
- Run focused contract, client-runtime, Convex, web, and desktop tests.
- With explicit approval, run one integrated web pass and one packaged or development desktop pass.
  Capture before/after images; capture a short recording for notification click and coalescing behavior.

## Acceptance criteria

- The four event kinds resolve independently across global, project, and thread scopes.
- Bell state and menu state remain correct across cloud sync, worktrees, reconnects, and inherited
  changes.
- Muting never removes an Attention Event from the Notification Tray.
- An event is delivered at most once per installation, including with two browser tabs and replayed
  Convex results.
- A focused originating thread stays silent on that client without silencing another client.
- Settled, archived, and deleted threads stay silent; snoozed threads remain eligible.
- Three rapid events in one thread produce one sound, one updatable OS notification, and three tray
  rows.
- Quiet hours and reconnect each produce at most one summary, and no event appears in both.
- Reading one notification removes only that event from unread state. Mark all read still clears all.
- Test alert bypasses policy, quiet hours, and foreground suppression without writing a tray row.
- OS notification bodies contain no prompt, command, path, or agent output.
- A custom sound outside the format, size, duration, or decoding limits is rejected before saving.
- Revoked notification permission preserves the preference and clearly disables the effective channel.
- Desktop and web pass the same pure policy and scheduling fixtures.

## Out of scope

- Mobile controls or changes to existing mobile push preferences.
- Background web push after the page closes.
- Per-event sounds, volume controls, audio editing, or cloud-synced custom audio.
- Email, SMS, Slack, or provider-specific alert channels.
- Filtering or deleting muted events from the Notification Tray.

## Open decisions

None. Product behavior is confirmed. Implementation may still adjust file boundaries if repository
ownership changes, but it must preserve the contracts and acceptance criteria above.
