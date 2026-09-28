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
need read scope. Input sockets, stream tuning and fold mutation need operate scope.
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

The common MCP endpoint exposes `device_list`, `device_open`, `device_screenshot`
and `device_close` to all providers. Calls require the `device` capability and
current device-support/agent-access consent. `device_open` returns device metadata,
`agentDevice: { command, targetArgs }` and `quickStart`; execute that absolute
launcher on the selected environment with every returned argument. Screenshot
results contain metadata plus an MCP PNG image block, not duplicated image data.
