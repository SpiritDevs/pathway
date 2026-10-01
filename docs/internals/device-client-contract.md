# Device client contract

The contracts live in `packages/contracts/src/device.ts`, exported by
`@spiritdevs/contracts`. RPCs are in `WsDeviceRpcGroup`, merged into `WsRpcGroup`.
Use the selected environment's existing connection. `server.getConfig` advertises
`deviceWorkspace: true`. Keep UI state keyed by environment id, host id and device id.

## RPCs

`hostId` defaults to `"local"`, meaning the environment server, except that
omitting it from `device.close` matches all hosts in that thread.
`threadId` is Pathway's branded thread id. All ordinary calls can fail with
`DeviceError` or `EnvironmentAuthorizationError`.

| Method                 | Request                                                                                         | Response                                          | Scope                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| `device.configure`     | `{ enabled?: boolean, agentAccessEnabled?: boolean, onboardingCompleted?: boolean }`            | `DeviceServiceState`                              | operate                        |
| `device.list`          | `{ updateTool?: "hub" \| "agent", inspectOnly?: boolean, retryHostId?: string }`                | `DeviceServiceState`                              | read; operate for update/retry |
| `device.testHost`      | `{ id: string, label: string, target: string, identityFile?: string, port?: number }`           | `DeviceHostSummary`                               | operate                        |
| `device.open`          | `{ threadId, hostId?: string, deviceId: string, platform: "ios" \| "android", boot?: boolean }` | `DeviceSession`                                   | operate                        |
| `device.close`         | `{ threadId, hostId?: string, deviceId?: string, shutdown?: boolean }`                          | void                                              | operate                        |
| `device.shutdown`      | `{ hostId?: string, deviceId: string, platform: "ios" \| "android" }`                           | void                                              | operate                        |
| `device.detail`        | `{ hostId?: string, deviceId: string }`                                                         | `DeviceDetail`                                    | read                           |
| `device.action`        | `{ hostId?: string, deviceId: string, ...action }`                                              | refreshed `DeviceDetail`                          | operate                        |
| `device.input`         | `{ hostId?: string, deviceId: string, input: DeviceInput }`                                     | void (native acknowledgement)                     | operate                        |
| `subscribeDeviceState` | `{}`                                                                                            | stream of complete `DeviceServiceState` snapshots | read                           |

Scopes are `orchestration:read` and `orchestration:operate`. `device.list({})`
refreshes discovery and can start helpers if support was already enabled.
`inspectOnly` reads tool inventory without starting or installing helpers.
`updateTool` installs this environment's pinned version without enabling access
or restarting helpers; it takes precedence over the other flags. `inspectOnly`
takes precedence over `retryHostId`. Retry targets one host. Prefer one mode per call.

`device.open` boots by default. Android may return a new running emulator serial;
use the returned session's `deviceId`. Close detaches a viewer session and defaults
to keeping the device running; omit `deviceId` to close all matching sessions in
the thread. Shutdown powers the device off and removes its sessions in all threads.

Save SSH host configuration through
`server.updateSettings({ patch: { deviceHosts: [...] } })`. Each id must be unique,
match `[a-zA-Z0-9][a-zA-Z0-9_-]*`, and not be `local`. `device.testHost` probes
without saving. The device settings also appear in `server.getSettings` and
`subscribeServerConfig` settings updates as `enableDeviceSupport`,
`enableAgentDeviceAccess`, `deviceOnboardingCompleted`, and `deviceHosts`.

## Response shapes

```ts
type Platform = "ios" | "android";
type Status = "disabled" | "idle" | "installing" | "starting" | "ready" | "failed";
type DeviceToolVersion = {
  requiredVersion: string;
  installedVersions: string[];
  runningVersion: string | null;
};
type DeviceHostSummary = {
  id: string;
  kind: "local" | "ssh";
  label: string;
  platforms: { platform: Platform; available: boolean; reason?: string }[];
  hubInstalled: boolean;
  agentDeviceInstalled: boolean;
  tools?: { hub: DeviceToolVersion; agent: DeviceToolVersion };
  toolInspectionError?: string;
};
type DeviceSummary = {
  hostId: string;
  id: string;
  platform: Platform;
  name: string;
  version: string;
  booted: boolean;
  physical: boolean;
};
type DeviceSession = {
  threadId: string;
  hostId: string;
  deviceId: string;
  platform: Platform;
  openedAt: string;
};
type DeviceServiceState = {
  supportsHostRetry?: boolean;
  supportsToolUpdate?: boolean;
  supportsToolInspection?: boolean;
  hosts: DeviceHostSummary[];
  hostStatus: Status;
  hostStatusDetail?: string;
  hostStatuses: Record<string, { status: Status; detail?: string }>;
  devices: DeviceSummary[];
  sessions: DeviceSession[];
  bootingDevices?: (DeviceSummary & { threadId: string })[];
  onboardingCompleted: boolean;
  agentAccessEnabled: boolean;
  hubBasePath: string; // "/api/device-hub", relative to the selected environment
  revision: number;
};
type DeviceDetail = {
  hostId: string;
  deviceId: string;
  readAt: string;
  settings: DeviceSettings;
  foregroundApp: { id: string; name?: string; version?: string } | null;
};
```

The stream emits the current snapshot first, then full snapshots on changes.
There is no event envelope or patch format. The subscription is installed before
reading the initial snapshot. Use `revision` to ignore queued older snapshots.
`hostStatus` is the local-host summary; use `hostStatuses[hostId]` for each host.
An unavailable `tools` inventory is unknown, not an empty installed-version list.

All fields of `DeviceSettings` are optional. They are `appearance`, `textSize`,
`reduceMotion`, `increaseContrast`, `reduceTransparency`, `showBorders`,
`voiceOver`, `liquidGlass`, `colorFilter`, `networkEnabled`, and nullable
`location: { latitude: number, longitude: number }`.

Actions are discriminated by `type`:

| Type                        | Additional fields                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `setAppearance`             | `value: "light" \| "dark"`                                                                                                                    |
| `setTextSize`               | `value: "small" \| "default" \| "large" \| "extra-large"`                                                                                     |
| `setToggle`                 | `setting: "reduceMotion" \| "increaseContrast" \| "reduceTransparency" \| "showBorders" \| "voiceOver" \| "networkEnabled"`, `value: boolean` |
| `setLiquidGlass`            | `value: "clear" \| "tinted"`                                                                                                                  |
| `setColorFilter`            | `value: "none" \| "grayscale" \| "red-green" \| "green-red" \| "blue-yellow"`                                                                 |
| `setOrientation`            | `value: "portrait" \| "landscape_left" \| "portrait_upside_down" \| "landscape_right"`                                                        |
| `setLocation`               | `latitude: number` in -90..90, `longitude: number` in -180..180                                                                               |
| `clearLocation`, `shake`    | none                                                                                                                                          |
| `setPermission`             | `appId: string`, `permission: DevicePermission`, `decision: "grant" \| "revoke" \| "reset"`                                                   |
| `openUrl`                   | `url: string`                                                                                                                                 |
| `launchApp`, `terminateApp` | `appId: string`                                                                                                                               |
| `sendPush`                  | `appId: string`, `payload: string \| Record<string, unknown>`                                                                                 |

`DevicePermission` is `camera`, `microphone`, `photos`, `contacts`, `calendar`,
`reminders`, `location`, `notifications`, `motion`, `media-library`, or `faceid`.
Unsupported platform actions fail with `DeviceActionUnavailableError`.

## Media and control URLs

1. Resolve `state.hubBasePath` against the selected environment connection's
   `httpBaseUrl`. Never use the hosted page origin or a discovered helper port.
   Change the resulting `http:`/`https:` scheme to `ws:`/`wss:` for sockets.
2. Cookie connections send their environment cookie. Bearer and DPoP connections
   call the existing authenticated `POST /api/auth/websocket-ticket` on that
   environment. It returns `{ ticket: string, expiresAt: DateTime.Utc }`, with
   `expiresAt` encoded as an ISO timestamp over HTTP. The ticket lasts five minutes
   and can authorize concurrent HTTP media and WebSocket requests for that session.
3. Use the existing environment HTTP-auth helper to mint it. For DPoP, the proof
   must cover `POST`, the public `/api/auth/websocket-ticket` URL and the access
   token hash. A proof for a media URL is invalid. A hosted bearer/DPoP client
   should omit cookies when minting or using tickets.
4. Append `hostId` and `wsTicket` to every media/control request, alongside vendor
   parameters. URL-encode ids and tickets. Refresh the ticket before reconnecting
   after expiry. The server strips both parameters and all environment credentials
   before forwarding. Revoked sessions cannot reuse tickets; active sockets close
   with code `1008` on revocation.

Paths below are appended to `hubBasePath`, with `hostId` and ticket query fields:

| Purpose                    | Path and vendor query                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| iOS H.264                  | `/vendor/serve-sim/helper/{encoded deviceId}/stream.avcc`                |
| iOS MJPEG fallback         | `/vendor/serve-sim/helper/{encoded deviceId}/stream.mjpeg`               |
| iOS fixed Duo display      | `/vendor/serve-sim/helper/{encoded deviceId}/panel/{1 or 3}/stream.avcc` |
| iOS input/config socket    | `/vendor/serve-sim/helper/ws?device={deviceId}`                          |
| Android video/input socket | `/vendor/serve-emu/ws?device={deviceId}&frame-meta=1`                    |
| Android fold state/control | `/vendor/serve-emu/api/fold?device={deviceId}` with GET or POST          |
| Discovery socket           | `/api/devices/ws`                                                        |

The wire formats and Android fold payload are Hub `0.12.0` vendor protocols,
matching t3code `d15210cd3`. The proxy does not reframe video or input. Read requests
need read scope. Input frames, stream tuning and fold mutation need operate scope and the control lease described below. Sockets themselves need read scope so watchers retain media access.
Android fold controls are not `device.action` variants in this upstream revision.
Read/config/accessibility/foreground/event-log and screenshot routes remain
allowlisted in `DeviceHubProxy.ts`; dashboard, shell-exec, vendor bootstrap `/vendor/serve-sim/api`, and WebRTC
routes are denied. The vendor bootstrap advertises raw helper URLs and an exec
token, so it is deliberately excluded.
Stream responses set `Cache-Control: no-store, no-transform` to avoid buffering.

Production CORS supports hosted clients; development also permits
`https://app.spiritdevs.com` alongside the configured development origins.
Pathway Connect routes these requests through the same environment HTTP endpoint
and WebSocket upgrades. There is no additional Hub tunnel or public port.

UI integration must enable WebSocket forwarding for `/api` in the Vite proxy.
Main currently enables it only for `/ws`; this backend work does not edit web files.

## Agent tools

The common MCP endpoint exposes `device_list`, `device_open`, `device_screenshot`,
`device_close`, `device_input` and `device_action` to all providers. Calls require the `device` capability and
current device-support/agent-access consent. `device_open` returns device metadata,
`agentDevice: { command, targetArgs } | null` and `quickStart`; when present, execute that absolute
launcher on the selected environment with every returned argument. Screenshot
results contain metadata plus an MCP PNG image block, not duplicated image data.

## Device control lease, COR-165

Require `state.supportsDeviceControl === true` before enabling input. A missing
control record, disconnected state, `idle`, or `draining` means the viewer is
watch-only. Do not infer authority from the thread's run status.

| RPC                     | Request                                       | Response             | Scope   |
| ----------------------- | --------------------------------------------- | -------------------- | ------- |
| `device.acquireControl` | `{ hostId?, deviceId, viewerId }`             | `DeviceControlState` | operate |
| `device.renewControl`   | `{ hostId?, deviceId, viewerId, generation }` | `DeviceControlState` | operate |
| `device.releaseControl` | `{ hostId?, deviceId, viewerId, generation }` | `DeviceControlState` | operate |

```ts
type DeviceControlState = {
  hostId: string;
  deviceId: string;
  generation: number;
  phase: "idle" | "held" | "draining";
  owner:
    | { kind: "viewer"; sessionId: string; viewerId: string }
    | { kind: "agent"; threadId: string; runId: string }
    | null;
  expiresAt: number | null; // Environment epoch milliseconds.
};
// Complete device-state snapshots add:
// supportsDeviceControl?: boolean;
// controls?: DeviceControlState[];
```

Generate a distinct `viewerId` for each mounted viewer. The environment supplies
the authenticated `sessionId`; the client cannot choose it in a request. Keep the
returned generation, and enable input only after acquire succeeds and the latest
state still identifies this viewer and generation in `held` phase. Acquisition
can take as long as the previous managed command takes to finish. Renew every
10 seconds while controlling; leases last 30 seconds. Renewal preserves generation.

Add `viewerId` and `controlGeneration` to input WebSocket URLs and fold/tuning
HTTP mutation URLs. They are stripped at the environment proxy. Reconnect input
sockets after each acquire so they carry the new generation. Renewals need no
reconnect. Media URLs may omit both fields. A socket without a valid proof remains
a watcher, including Android's multiplexed media/input socket. Rejected input does
not close that socket. The wire formats between clients and the environment stay
the existing vendor formats; the iOS receipt extension is internal to the proxy.

`device.action`, `device.shutdown`, and `device.close({ shutdown: true })` accept
`control: { viewerId, generation }` and require a matching viewer lease. Closing a
thread's device session without shutdown remains available to watchers. `device.open`
still opens a viewing session and grants the viewer no control.

Before Resume agent, await `device.releaseControl`. It finishes active input and
invalidates the generation before acknowledging. Then dispatch the continuation
through the existing thread API. Disable input immediately when hiding, backgrounding,
changing devices, losing state/RPC connectivity, or beginning release. Release before
closing media channels when possible, so the environment can finish held input on
the live channel. A disconnected controlling socket or the RPC connection that
acquired control releases that lease. Generation checks protect a replacement
viewer from delayed cleanup of an older generation.

Session revocation closes the client with 1008 while the environment retains the
helper connection long enough to finish held input. Hand-back finishes every
Android pointer, including pointer 0 when `pointerId` was omitted.
These backend fixes do not change the RPC names, payloads, state fields or errors.
The external agent grant still rotates after hand-back; the gateway transfers an
environment-owned daemon session internally so the new grant can resume it.
Managed calls have a five-minute completion deadline, including while Stop waits
for accepted work. A deadline can produce `input_unconfirmed`; stay watch-only until helper restart confirms the
old helper has terminated. Restart can stop a stalled helper without waiting for
its old command response.

`device.restartTools` processes every device on the host after confirmed helper
termination, then returns the first remaining drain error instead of reporting
success. The existing `DeviceControlError` identifies the affected device. An
agent-only restart can recover one device while returning `input_unconfirmed`
for another that still needs a hub restart. Use `subscribeDeviceState` to observe
each device's control state; a restart error does not mean every device is still
fenced. RPC names, payloads, state fields and error codes are unchanged.

`DeviceControlError` includes `hostId`, `deviceId`, `code`, and `message`:

| Code                | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `control_required`  | Acquire a viewer lease before this mutation.                                   |
| `control_held`      | A different viewer/session or agent run owns the lease.                        |
| `stale_generation`  | This proof expired or was superseded. Acquire again.                           |
| `control_draining`  | Previous managed input is still finishing. Stay watch-only.                    |
| `run_stopped`       | This agent run ended and cannot obtain another grant.                          |
| `invalid_grant`     | The managed CLI token, command or target is invalid. Call `device_open` again. |
| `input_unconfirmed` | Completion is unknown. Stay watch-only and restart the affected device helper. |

HTTP fold/tuning failures return 409 with the control code. Scope and authentication
errors retain their existing 403/401 behavior. Watchers need read scope; input
requires operate scope plus the lease. Older clients that send input without a
proof are watch-only on this backend.

`packages/client-runtime` provides `acquireControl`, `renewControl`, and
`releaseControl` commands from `createDeviceEnvironmentAtoms`,
`currentDeviceController(state, hostId, deviceId)`, and
`withDeviceControl(access, proof | null)` for media/input URL construction.
Native iOS uses the same RPCs and snapshot fields. No new UI is included here.

## Watch and TV backend contract (COR-103 / COR-104)

Apple families retain `platform: "ios"` for transport and toolchain selection.
New servers always provide `DeviceSummary.family` (`phone`, `pad`, `watch`, `tv`)
and `capabilities`. Both fields remain optional on the wire for older servers.
Do not infer a new family from a user-renamed simulator label.

| Capability   | Meaning                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `streaming`  | `{ status: "supported" }` or `{ status: "unsupported", reason }`; do not start an unsupported stream                     |
| `agentCli`   | Same support union; Watch is unsupported by the pinned XCTest CLI, with a reason directing agents to native MCP tools    |
| `inputKinds` | Phone/pad: `touch`; Watch: `touch`, `digitalCrown`, `watchButton`; TV: `remoteButton`                                    |
| `framing`    | `{ shape: "phone" \| "tablet" \| "watch" \| "tv", orientation, aspectRatio }`; TV is landscape 16:9, Watch portrait 0.82 |

Framing is an initial layout hint, not a pixel-size contract. Use live stream
width/height when available. A Watch has no phone bezel; TV has no touch overlay.
The current native capture supports TV, so its streaming capability is supported.
Older runtimes/toolchains can still fail to start capture or input; surface the
operation failure, never substitute a placeholder stream.

`device.input({ hostId, deviceId, input })` is an operate-scope RPC returning void
only after the helper acknowledges native input. `createDeviceEnvironmentAtoms(...).input`
uses the selected environment. Input targets must be booted and owned by that
environment. Unsupported device/input combinations fail before invoking helpers.
The same shape is available as the `device_input` MCP tool. This RPC targets
Apple simulators; Android touch continues to use the existing serve-emu socket.

```ts
type Input =
  | { kind: "touch"; phase: "begin" | "move" | "end"; x: number; y: number }
  | { kind: "digitalCrown"; delta: number }
  | { kind: "watchButton"; button: "crown" | "side" }
  | {
      kind: "remoteButton";
      button: "up" | "down" | "left" | "right" | "select" | "menu" | "back" | "playPause" | "home";
    };
```

Touch coordinates are normalized to 0..1. Crown deltas are signed SimulatorKit
wheel pixels, bounded to -200..200 per message; coalesce within a frame. Buttons
are full down/up presses, so keyboard repeat sends another press. TV directions
and select/menu use keyboard HID events understood by the focus engine; home and
play/pause use consumer HID events. There is no coordinate emulation on TV.
`DEVICE_TV_KEYBOARD_MAP` maps `KeyboardEvent.code`: arrows, Enter=select,
Escape/Backspace=back, Space=playPause, Home=home. Handle unmodified keys only while
the viewer is focused; let text fields and other app shortcuts keep their keys.

For continuous controls, reuse the existing authenticated helper WebSocket at
`/vendor/serve-sim/helper/ws?device=...`, using the media-ticket rules above.
`deviceSimulatorInputPacket(input)` produces the **inner** `{ tag, payload }`.
Wrap it as one binary message: byte `0x12`, then UTF-8 JSON
`{ id: "unique-request-id", ...deviceSimulatorInputPacket(input) }`. The helper
responds on tag `0x12` with `{ id, ok, error? }`. Match ids, bound pending requests,
and reject them when the socket closes. Ack means native dispatch completed;
it is not evidence that the app rendered the expected result. TV's inner tag
`0x13` is handled only inside this envelope. Never send TV input via the legacy
raw `0x04` digitizer button path. Cancel input on disconnect/revocation and do not
replay pending presses on reconnect. This uses the existing authenticated proxy
and host selection; it introduces no client-visible helper address.

Pairing uses `device.action` (or the `device_action` MCP tool):

- `{ hostId, deviceId: watchId, type: "pairWatch", phoneDeviceId }` pairs an
  explicit simulator iPhone on the same host. It is idempotent for the same pair.
- `{ hostId, deviceId: watchId, type: "unpairWatch" }` reverses the operation.
- `device.open` accepts `companionDeviceId` to perform that pairing before Watch
  boot. Omit it to leave pairing unchanged; no phone is selected or booted
  implicitly. Open the phone separately if a companion app needs it running.

Both devices must be available to this environment. Existing conflicting pairs
must be explicitly unpaired first; simctl compatibility errors remain failures.
Pair mutations are serialized. Watch summaries and details expose
`watchPair: { pairId, phoneDeviceId, state } | null`; absent means unavailable on
an older server, null means unpaired. Pair state is the raw simctl label.
Watch/TV details currently return empty settings and null foreground app; only
launch/terminate app actions, plus Watch pairing, are advertised here.

`device_open` also accepts a `family` filter. Ambiguous families require a family
or explicit device id. Watch returns `agentDevice: null` and instructions for
`device_input`, `device_action` and `device_screenshot`. TV returns the usual
CLI launcher with `--platform ios --target tv --udid ...` and the existing
host/thread config flags. The common toolkit exposes these tools to every
provider, under the existing capability and current consent checks.
