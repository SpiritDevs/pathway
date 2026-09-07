# Thread alert implementation

The product rules are in `.plans/thread-alerts.md`. The first implementation covers desktop and web.
Mobile push preferences continue to use their existing relay path.

## Ownership

- `packages/contracts/src/threadAlerts.ts` defines policy, scope keys, local settings, and desktop
  notification inputs. `focus.ts` carries event eligibility and individual read state.
- `packages/backend/convex/threadAlertPolicies.ts` stores sparse user-owned overrides.
  `focusNotifications.ts` snapshots eligibility, lists retained history, and handles individual
  acknowledgements alongside the all-read watermark.
- `AttentionEvents.ts`, `AgentAwarenessRelay.ts`, and `FocusNotificationRecorder.ts` carry the stable
  repository policy key through the existing event path.
- `apps/web/src/cloud/focusReadModel.ts` supplies the authenticated Convex client.
  `apps/web/src/threadAlerts/state.ts` adds one scoped policy subscription and keeps optimistic
  choices visible until the matching cloud row arrives.
- `packages/client-runtime/src/threadAlerts/` owns delivery decisions and transactional IndexedDB
  claims. `apps/web/src/threadAlerts/` mounts the runtime and provides audio and notification adapters.
- Electron owns native notifications, system sound, window reveal, and queued notification clicks.
  The renderer owns navigation and acknowledges the selected event after navigation succeeds.

The cloud snapshot uses the policy at the first Convex insertion. A delayed first relay delivery
therefore uses policy at insertion, not a historical policy reconstructed for server occurrence time.
Duplicate event inserts preserve the original snapshot. Existing stored rows without an eligibility
snapshot decode as ineligible.

## Deployment order

Deploy the Convex schema and functions before the updated clients. Deploy the relay before updated
environments send the extended Attention Event payload. Then publish the server, web, and desktop
builds. The relay and cloud accept older events without the stable project key and use their
environment/project identity for those events.

No cloud deployment or application publication is part of the local implementation. A web or desktop
build pointed at an older backend cannot use the new policy queries until that backend is updated.

## Verification boundaries

Focused tests cover policy inheritance, event fanout, acknowledgement retention, deletion cleanup,
bell interactions, settings, local delivery decisions, browser-tab claims, audio validation, and
desktop IPC. Use the repository's focused test commands for these files.

The 2026-09-08 local verification passed 341 tests across 27 focused files after rebasing onto
`242053e03`. Typechecks passed for
contracts, client-runtime, backend, server, relay, web, and desktop. Targeted lint and
`git diff --check` passed. Server and desktop reported existing suggestions in unrelated code.
The production web build passed with chunk-size and dynamic-import warnings.

An anonymous local Convex deployment passed live global, project, and thread policy writes, scoped
reads, account isolation, and reset checks. This used synthetic test identities on loopback port 3215. The shared development backend was not changed.

A Playwright browser paired with an isolated server and signed in with the dedicated Clerk test
account. Global choices, quiet hours, and sound selection survived reload. A custom WAV decoded,
saved, survived reload, previewed, and was removed with System default restored. The settings page
fit a 390-pixel viewport without horizontal overflow. The final settings pass emitted no page
errors. Screenshots show default settings, configured settings, and the narrow layout.

Browser notification permission remained denied, including after a test-context permission grant.
The shared development relay could not be reached from the test browser. Full relay-to-OS delivery,
packaged desktop notification presentation, and live sidebar bell interaction remain unverified;
their adapters, policy and delivery decisions, and bell interactions have focused test coverage.
Earlier computer-use attempts timed out. An update-depth error during hot reload had a truncated
stack and did not recur after a fresh server start.

Queued native click targets carry account ownership. A different account's listener cannot consume
an old target, while same-account remounts retain pending clicks.

Packaged OS behavior still requires a signed macOS build, the installed Windows AppUserModelID and
shortcut path, and a supported Linux notification service. Electron exposes limited permission
information, so the desktop adapter reports detected support and delivery failures. Settings is
the only thread-alert action that requests browser notification permission. Calendar reminders
retain their existing permission flow.

Browser and desktop notification noise is suppressed through the native `silent` option, with sound
handled independently. See the [Electron notification API](https://www.electronjs.org/docs/latest/api/notification)
and [system beep API](https://www.electronjs.org/docs/latest/api/shell#shellbeep).
