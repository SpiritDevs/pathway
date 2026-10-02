# Devices

The environment server owns simulators and emulators the way it owns
terminals: discovery, streaming, and agent access all run there, and every
client reaches them through the environment connection. This is what makes the
Device panel work over Tailscale and Pathway Connect, including when an SSH host runs the devices.

## Two external tools, one seam

[expo-device-hub](../../apps/server/src/device/LocalDeviceHost.ts) streams and
[agent-device](../../apps/server/src/device/AgentDeviceShim.ts) drives. Each is
npm-installed at a pinned version into the Pathway home after its matching Device
panel consent step. Manual setup installs and starts only expo-device-hub;
agent-device remains absent and stopped until agent access is granted. Both run
with the server's Node; `npx` would make the first `device_open` after a reboot
depend on the registry. The hub is a supervised child rather than an imported
middleware because serve-sim loads private CoreSimulator frameworks through a
native addon, and a crash there must not take the server down.

Everything platform-specific sits behind
[`DeviceHost`](../../apps/server/src/device/DeviceHost.ts). The service, the
proxy, and the MCP tools only see a hub origin and an agent-device endpoint.
SSH hosts forward both endpoints to server loopback. Every proxied request
also carries the host id; device ids alone are not unique across hosts.

## One-click Android setup

`device.installPlatform` starts
[`androidSdkInstall.ts`](../../apps/server/src/device/androidSdkInstall.ts) on
the local host. The local host advertises it with `installable` on its Android
availability; SSH hosts and Windows do not. The RPC returns immediately and the
install runs in the device service's scope, so it outlives the caller. Progress
and failures are published as `platformInstalls` in device state, and success
removes the entry and re-lists devices. The installer plans from what is on
disk: it adds the pinned Command-line Tools zip (with its SHA-1 checked) when
`cmdline-tools/latest` is missing, lets sdkmanager install Platform-Tools, the
Emulator, and the manifest's Android runtime image, and creates one AVD only
when none exist. sdkmanager needs Java 17+, so the installer prefers
`JAVA_HOME`, Android Studio's JBR, and the system JDK, and falls back to a
Temurin JRE in the device cache. If the install creates the SDK root, helpers
restart so their `ANDROID_HOME` and `PATH` pick it up.

## The hub is never exposed

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`, and serve-emu's action routes have no auth at all. The
hub binds loopback and the only way in is the
[proxy](../../apps/server/src/device/DeviceHubProxy.ts), which allowlists the
stream, config, and screenshot routes and authenticates every request as an
environment session. `<img>` and `WebSocket` cannot carry headers, so the proxy
authenticates like the `/ws` upgrade: cookie, or a short-lived `wsTicket` that
bearer and DPoP clients mint over authenticated HTTP. The ticket is stripped
before the request reaches the hub. The vendor bootstrap `/vendor/serve-sim/api`
is denied because it advertises raw helper URLs and an exec token. Clients build
all media URLs from the environment-relative `hubBasePath`.

Stream responses carry `Cache-Control: no-transform`; the compression
middleware would otherwise buffer an MJPEG body that never ends. In browser dev,
the Vite proxy must forward WebSocket upgrades for `/api`, not only `/ws`.

## Device settings never go through the hub

serve-sim's preview drives its Tools panel by sending shell commands over that
same exec channel. Proxying it, even allowlisted, would hand any environment
session arbitrary command execution on the host, so Pathway does not. The
[`device.action`](../../apps/server/src/device/DeviceActions.ts) RPC runs the
underlying `simctl`, `adb`, and serve-sim helper binaries itself through
`DeviceHostReady.run`, one typed action per control, and returns the settings
it reads back. The proxy allowlist grows only with read routes (accessibility
tree, foreground app, event log) and refuses non-GET methods everywhere except
screenshot capture, stream tuning and Android fold controls.

## Agent device tools

The `device_*` toolkit exposes list, open, screenshot, close, input and action.
Phone/pad and TV automation uses the `agent-device` CLI for semantic snapshots.
Native input and typed actions cover Watch and controls absent from the CLI. Pathway returns
an absolute shim path from `device_open`. The CLI installs on the environment
server even when that server cannot run simulators. Hosts start on demand.

Pathway resolves the CLI on `device_open` and returns an absolute launcher
path with host-, run- and generation-specific `--config` and `--session` arguments. This
works for Codex, Claude, Cursor, Grok and OpenCode without changing a running
provider's PATH. Every MCP call rechecks both its device capability and the
current device-support and agent-access settings.

How to drive a device is returned from `device_open`, not kept in an
always-loaded prompt or skill: it costs nothing in threads that never open a
device and cannot drift from the pinned CLI version. The tool result prefers agent-device over raw `simctl` and `adb`, which remain
available for commands the CLI does not cover.

## The viewer decodes both vendored protocols

The hub vendors two streaming servers with different wire formats. iOS video is
an HTTP body of AVCC envelopes decoded with WebCodecs, with input on a separate
binary WebSocket; Android multiplexes SEMU-framed H.264 and JSON gestures over
one WebSocket. Clients must implement both vendor protocols through the proxy;
the backend does not decode or re-encode frames.

Simulators encode H.264 High 5.1. Hardware decoders on some machines and all
headless browsers reject that profile, and WebCodecs is secure-context only, so
clients should probe `isConfigSupported` and fall back to the MJPEG endpoint on
iOS. Android has no MJPEG; clients should report that they cannot decode it.

The web viewer and the native iOS app share `client-runtime/device/stream.ts`.
iOS bundles it with `scripts/ios/build-device-stream.mjs` into
`PathwayDeviceStream.bundle` (CI checks the bundle with `--check`) and runs it
in a WKWebView whose empty document is loaded at the environment's origin, so
media and input are same-origin and WebCodecs gets a secure context over
HTTPS. The app mints the ticket and passes it in as `DeviceHubAccess`, with
`expiresAt` taken from the ticket response. An `unauthorized` reply makes it
mint a fresh one at most twice per failing sequence; the budget refills once
media and input both connect or the user retries, so a refused stream stops
with an error instead of looping. A terminated WebKit content process marks
the page failed, and the next start loads a new document; callbacks from older
documents are ignored.

The iOS viewer follows the device control lease contract
(`device-client-contract.md`). Each mounted viewer generates a `viewerId`,
acquires, renews every 10 seconds, and releases over one RPC connection that
lives as long as the lease, because the environment releases a connection's
grants when it closes. The environment also checks the authenticated session,
and every Pathway Connect `prepare` opens a new one, so the lease's connection
opens one session (`PathwayDeviceEnvironmentSession`) and mints further tickets
within it: the stream's tickets while the lease is held, and mutations such as
`device.close` go over the lease's socket. Input is enabled only when the newer
of the snapshot's `controls` entry and the latest acquire/renew response is
`held` by this viewer at the generation it was granted. A new grant restarts the
page's stream with a ticket from the lease's session so the input socket carries
`viewerId` and `controlGeneration`; renewals do not.

Hiding, backgrounding, or switching devices releases the lease, including one
still being acquired; a grant that arrives afterwards is released at once. Any
renewal failure, the lease socket closing, a failed ticket refresh, or device
state going non-live drops the lease, and only a new grant restores input.
Resume agent dispatches only after the release is acknowledged; a refused
release keeps the hand-back message for a retry, and `input_unconfirmed` offers
`device.restartTools`. Without `supportsDeviceControl`, the viewer only watches.

## Upstream version and tool inventory

The backend follows t3code `d15210cd3da79f9a1a495a6309d912d76362a046`.
Device Hub is pinned to `0.12.0-pathway.2` (upstream npm `0.12.0` plus the
checksum-verified Watch/TV patch) and agent-device to `0.21.12`.
serve-sim and serve-emu are vendored inside that exact Hub package; upstream
has no separate serve-sim install pin. The earlier Duo archive override and
physical-orientation patch are removed. The Watch/TV patch is applied to a
staging directory before the completed-install marker, identically on local and
SSH hosts. The patch checks the three JavaScript bundles and prebuilt native addon.
These checks pin patch inputs, not the complete npm dependency graph. TV input
compiles its separate helper on first use, so hub installation does not require
an Apple compiler. `tools.tvInputBuild` reports its status independently.

`device.list({ inspectOnly: true })` returns per-host `tools.hub` and
`tools.agent` inventories, each with `requiredVersion`, `installedVersions`
and nullable `runningVersion`. Inspection does not install or start helpers.
`device.list({ updateTool: "hub" | "agent" })` installs the selected environment's
pin without enabling access or restarting helpers. It needs operate scope.
SSH hosts install pins on next startup. After successful startup, maintenance
keeps the required version, the previous completed install, and every install
referenced by a running process. It skips incomplete installs and symlinks.

Android fold state and changes use the authenticated
`/vendor/serve-emu/api/fold` proxy route, as upstream does. They are not new
`device.action` variants. `device.action` remains the typed settings/command API.

The [client contract](device-client-contract.md) lists every RPC, response,
subscription and media-ticket step for web, desktop and mobile integration.

## Environment control ownership

COR-165 adds a separate, in-memory control lease for each `(hostId, deviceId)`.
`DeviceControl` owns the monotonic generation, controller and 30-second expiry.
A viewer is identified by its authenticated environment session and its own
`viewerId`. An agent is identified by thread and run. Multiple clients can watch
one device; watching grants no input permission.

With no controller, an active agent run obtains control when it opens the device.
Another agent run cannot displace it. A viewer acquires explicitly and can replace
any controller. Acquire first fences the old generation, waits for all accepted
managed commands, then finishes held touches and keys. It acknowledges only after
those operations finish. It does not depend on an interrupt request reaching the
provider. Release performs the same drain and returns to the unowned policy. A
client may dispatch its Resume agent continuation only after release succeeds.
That run calls `device_open` for a fresh grant; old grants never become valid again.

The device state stream includes `supportsDeviceControl` and `controls`. The
`draining` phase is watch-only. Viewer RPCs, device actions, shutdown, fold/tuning
HTTP mutations and each input frame check the authenticated owner and generation.
The Android socket retains video and `reset-video` while dropping unauthorized
input. Viewer renewal preserves the generation. Disconnect, session revocation,
expiry, shutdown, host replacement and helper restart invalidate it. Client hide
and background should release promptly; expiry covers a lost release.
Revocation closes client admission immediately but retains the upstream receipt
reader until accepted input and held keys/touches finish. Android tracks each
pointer independently, treating an omitted pointer ID as the vendor's pointer 0.

`DeviceInputChannel` serializes input on each socket and tracks completion receipts.
Android already acknowledges gesture completion. Hub 0.12.0's iOS handler fires
native HID promises without awaiting them, so `deviceHubControlAdapter` installs a
process-local Node loader in the local and SSH hub processes. It awaits those
promises and adds a private receipt envelope between the environment and helper.
It also replaces the vendor's last-socket keyboard reset with the environment's
explicit cleanup. The shared npm install is never edited. The adapter checks the
pinned source shape and requires Node's `registerHooks` support, Node 22.15+.
No receipt or an upstream failure leaves ownership fenced with `input_unconfirmed`;
a timeout never counts as a successful handoff. Restart the affected helper before
retrying. Updating the vendor pin requires revalidating this adapter.

The managed agent CLI receives a gateway URL on the environment and an opaque
run/generation-bound token, not the host daemon credential. Every command reaches
`/api/device-agent/rpc`, validates its target, then runs inside the same control
lease. The gateway waits for the daemon's response even if the CLI disconnects.
All managed calls have a five-minute completion deadline. Deadline expiry
cancels the response wait and leaves `input_unconfirmed`; cancellation is
not proof that the native command stopped. Explicit helper recovery fences new
admission and can stop the helper without waiting for its old response. Only a
confirmed helper restart clears that helper's uncertainty on every device on the
host, even if another device still needs a different helper recovered. Recovery
attempts every device's drain, then returns the first remaining error. For example,
an agent-only restart can recover one device while returning `input_unconfirmed`
for another device that still needs its hub restarted. Disabling support
also reaches the helper stop without waiting for the response, but does not
treat a stop request alone as confirmed termination.
Each accepted command renews the 30-second expiry. After idle expiry, the active
run calls `device_open` again to obtain a fresh grant.
The external CLI session and config remain run/generation-specific. The gateway
translates them to one environment-owned daemon session per `(hostId, deviceId)`.
After the outgoing generation drains, its successor reuses that session and its
device claim. Hand-back, idle expiry and run completion retain the daemon session;
old tokens remain invalid. A granted `agent-device close` closes that session and
its retained resources, and helper termination performs the daemon's cleanup.
The orchestrator's `RunStopFence` fences device calls as well as Computer calls,
waiting for accepted device work within the same completion deadline.
Agent access settings are rechecked at command admission. Background replay and
batch operations are refused because their completion would not prove input has
stopped. The current gateway accepts the bounded commands and flags listed in
`DeviceAgentGateway.ts`; artifact upload/download endpoints are not forwarded.
Use `device_screenshot` for image transfer. Commands needing local artifact upload
must use a file already available on the device host until transfer support is added.

This is enforcement for Pathway-managed device access. An agent with unrestricted
shell access can still invoke raw `simctl` or `adb`; this lease is not an OS sandbox.

## Apple Watch and TV

The pinned hub discovers available iOS, watchOS and tvOS simulators, including
never-used devices. Family comes from runtime and device type identifiers, not
user-editable labels. All families use the existing environment-authenticated
serve-sim media routes; no new public service or raw host address is returned.

Watch touch, crown rotation and crown/side buttons use serve-sim's native HID
addon. Pair/unpair uses the selected host's `simctl`, with explicit same-host
companions and ownership checks for both devices. Watch agent control uses the
native MCP tools because agent-device 0.21.12 has no watchOS XCTest backend.

TV capture uses the unmodified native addon's IOSurface capture path. TV button
input uses a small DTUHID XPC helper compiled on first TV input. The serve-sim
session lazily owns one helper process, reused across viewer and agent inputs;
closing the session stops that child. Process failure rejects outstanding input,
and the next press starts a new connection. The queue is bounded and each press
requires an acknowledgement. No raw touch events are generated for TV.

See the [UI contract](device-client-contract.md#watch-and-tv-backend-contract-cor-103--cor-104)
and the [capture spike and upstream note](watch-tv-simulator-spike.md) for the
verified toolchain, native protocol, patch boundaries and remaining runtime proof.

The public helper socket applies runtime-derived family and payload validation to
both acknowledged and legacy input. TV rejects digitizer events before native
calls. One bounded queue per device serializes dispatch and skips work from
closed sockets. See [review fixes and remaining work](watch-tv-review-fixes.md)
for active-touch cleanup, native acknowledgement and artifact-reproducibility gaps.
