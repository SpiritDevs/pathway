# T3 Code device workspace review

Reviewed on 22 September 2026 against Pathway `852eafdd9fc03a196f02d53ba9692591e5c14b17`.

## Sources and scope

Both requested pull requests are authored by Julius (`juliusmarminge`):

| Source                                                           | Reviewed head                              | State at review | Contribution                                                           |
| ---------------------------------------------------------------- | ------------------------------------------ | --------------- | ---------------------------------------------------------------------- |
| [T3 Code #12787](https://github.com/pingdotgg/t3code/pull/12787) | `59f845883163e896c16a890ea5d1e665b59cfe1c` | Open            | Three.js phone workspace, demand rendering, controls and frame sharing |
| [T3 Code #12813](https://github.com/pingdotgg/t3code/pull/12813) | `921b7c1f7b603168eda29e172affd50c08769fe6` | Draft           | Duo hinge controls, display handoff, native capture prototype          |

The second PR depends on the first. Its native dependency is [expo/serve-sim #181](https://github.com/expo/serve-sim/pull/181), pinned to `bb265b11c13b395e5302d121458e2d42224a2e9f`, with the physical-orientation patch included in this repository. #179 is included in that work; #180 is an alternative implementation, not an additional dependency. The upstream branch has moved since this pin. The pin and patch hash are deliberate reproducibility boundaries.

Pathway lacked the earlier device service, transport, settings and MCP foundation. This integration therefore also adapts the relevant implementation from #10677 (`dca7b59bea`), #10854 (`e022fa430e`), #10856 (`d2eeacd8cc`) and follow-up fixes (`bf55408a5c`, `53612cc040`, `1ced38a664`, `8bbe2bf660`, `823119350e`). It does not merge unrelated upstream routing, provider, authentication or layout changes.

The review covered the commit chains, source, inline review discussion, native build recipe, API boundaries, authentication, frame ownership, rendering lifetime, input routing, host identity and compatibility with Pathway's older Effect version. Separate standards and specification reviews were completed before integration.

## Commit trail

The reviewed series contains these incremental changes; the final integration uses their combined behavior.

| PR     | Commit         | Change reviewed                                                      |
| ------ | -------------- | -------------------------------------------------------------------- |
| #12787 | `a999c5190b41` | Interactive 3D workspace, shared screen canvas and device controls   |
| #12787 | `7c730dcc3763` | Floating control placement and removal of zoom                       |
| #12787 | `59f845883163` | Shared orbit springs and camera framing                              |
| #12813 | `d8fba3b223e3` | Initial Duo prototype and pinned native build                        |
| #12813 | `7d0c5b5c725e` | Orbit stability and hinge motion                                     |
| #12813 | `54dd1618d458` | Rotation transitions out of physical presets                         |
| #12813 | `b0067358902c` | Orbit snapping to nearby screen views                                |
| #12813 | `776a3898ffd1` | Spring-driven gestures and framing                                   |
| #12813 | `88e2363da076` | Fold presets, hinge gestures and acknowledged native display handoff |
| #12813 | `6248c8c1daf2` | Folding-surface orientation and elected-display refresh              |
| #12813 | `921b7c1f7b60` | Shared device physics and final Duo integration                      |

## Standards review

Two concrete stream recovery defects required repairs:

1. On iOS AVCC reconnect, the generation changed but an existing decoder retained an output callback bound to the old generation. Every recovered frame could be discarded. Each new video connection now starts with a fresh decoder; stale callbacks close their frames.
2. Decoder errors and queue overflow closed the decoder but requested a keyframe only on Android. iOS could remain frozen. iOS now aborts the video response and schedules one bounded reconnect while retaining the input socket. Stop cancels recovery.

Focused regression tests exercise EOF, stale frame disposal, decoder errors, queue overflow and cancellation. Existing positive properties were retained: demand-driven rendering, capped pixel ratio, one borrowed frame canvas, disposal of GPU resources, abortable asset loading, and stopping streams while hidden.

The proxy exposes only the required media, discovery and control routes. It uses Pathway environment authentication and scope checks, strips credentials before forwarding to the loopback hub, and does not expose the hub's shell-exec or dashboard routes. Media tickets support bearer and DPoP connections; tests check the ticket proof against its exact endpoint and access token. Device identifiers are scoped by environment and host throughout the UI and server.

Every agent device tool rechecks both the invocation capability and current environment settings. Revoking agent access therefore affects already-running sessions. Screenshots use MCP image blocks instead of embedding the image twice in JSON and text.

## Specification review and decisions

The two PRs' implemented behavior is internally consistent. Important upstream release gaps remain:

- Duo requires a patched native helper that is not in the pinned official hub release. Pathway keeps the default hub pinned to `0.9.0` and accepts the experimental archive only through an explicit local environment configuration. SSH hosts use the official build.
- Redistribution rights for the Apple model assets were not established. Those assets are excluded. Pathway uses original procedural phone/foldable geometry; no Apple GLB or proprietary logo path is bundled.
- The native prototype needs broader hardware, orientation and CPU qualification. Cover-display orientation is a known upstream concern. Native acknowledgement and a fresh matching display frame gate input; a failed handoff rolls back rather than sending touches to an unconfirmed display.
- A live Android verification pass requires an Android SDK and emulator. Automated Android transport/control coverage is retained.
- The pinned hub deliberately filters out simulators that have never been used. Start a new simulator once in Xcode before refreshing Pathway's device list. Empty-state guidance reflects this limitation.

Live verification also exposed a label-based Duo detection problem: a renamed simulator rendered as an ordinary phone. Pathway now recognizes the native hinge capability independently of the user-supplied name, with regression coverage.

Pathway adaptations:

- Device support and agent access are off by default and configured per environment. Helpers are installed on demand, outside the application bundle. No Convex schema, polling or write path was added.
- Chat's panel menu opens device setup or the picker. Settings → Integrations exposes setup, enable/disable controls and SSH hosts. There is no existing device keybinding or command-palette command to preserve.
- Desktop uses the shared web panel. Hosted/local web clients use the authenticated environment proxy; narrow layouts retain the flat stream fallback. React Native does not gain a native Three.js panel in this change; it retains the shared typed protocol and can control the same environment through agents.
- Provider adapters remain unchanged. Codex, Claude, Cursor, Grok and OpenCode use Pathway's common MCP endpoint. The open result gives an absolute `agent-device` launcher and host/thread-pinned arguments rather than relying on each provider's shell PATH.
- Agent-opened sessions reveal a panel tab after the initial subscription snapshot. Closing a tab does not resurrect it on unrelated state updates. Closing a session from another client removes its tab. Power-off remains a separate action.
- Pathway's existing browser mini-player remains browser-specific. Devices use the right panel; no unsupported floating-device button is shown.

## Reproducibility and verification

Native archive instructions and verification limits are recorded in [the device runbook](../operations/device-workspace.md). Product behavior is documented in [Devices](../user/devices.md).

Adapted TypeScript and helper code originates from the MIT-licensed [pingdotgg/t3code](https://github.com/pingdotgg/t3code) repository. The native helper retains its upstream LICENSE and NOTICE in the generated archive. Third-party model assets are not included.
