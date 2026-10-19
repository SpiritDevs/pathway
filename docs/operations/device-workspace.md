# Device workspace operations

Device support and agent access default off and are configured per environment.
Enabling device support installs `expo-device-hub@0.12.0` beneath that environment's
Pathway home and starts a loopback helper. Agent access separately installs
`agent-device@0.21.12`. serve-sim is vendored by the pinned Hub; there is no
separate archive or `PATHWAY_DEVICE_HUB_ARCHIVE` override.

Use `device.list({ inspectOnly: true })` to check installed, required and running
versions without starting helpers. Use `device.list({ updateTool: "hub" })` or
`device.list({ updateTool: "agent" })` to install the current environment's pin.
These calls do not enable access or restart helpers. Use
`device.list({ retryHostId })` to retry one configured host. Status details and
inspection failures are returned in the state and its subscription.

SSH targets, keys and SDK paths resolve on the environment server. Hosts require
Node 22 or newer and npm on the non-interactive SSH PATH. SSH forwards the Hub and
agent daemon to server loopback; clients always use the environment proxy.
Local SSH aliases are filtered to avoid running a second helper against the
same simulators. Save hosts through `server.updateSettings({ patch: { deviceHosts: [...] } })`.

To diagnose a missing platform, check the host's `platforms[].reason` and
`hostStatuses[hostId].detail`. iOS needs macOS and Xcode command-line tools;
Android needs adb and emulator. Disabling agent access stops the agent daemon;
disabling device support stops helpers and clears viewer sessions. It does not
power down simulators or emulators. `device.shutdown` powers a device off.

After successful startup, managed tool cleanup preserves the required version,
the previous completed install and installs referenced by running processes.
It does not remove unrecognized, incomplete or symlinked directories. No cleanup
runs merely because a client inspects versions.

For transport, RPC and client integration, see [Devices](../internals/devices.md).
The earlier [integration review](../internals/t3-device-integration-review.md)
records #194's historical decisions, not the current tool pins.
