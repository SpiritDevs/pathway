# Device tool synchronization

Each server release embeds `apps/server/src/device/deviceToolManifest.ts`. It pins Device Hub and agent-device and names the exact Device Hub release containing serve-sim. Device Hub vendors serve-sim without a separately published version in its package, so its identity is `expo-device-hub@0.12.0`. Updating the hub updates that helper too. No registry lookup selects a newer version at runtime.

The manifest recommends Xcode 26.0, iOS 26.0 and Android API 36. Recommendations are advisory. Pathway does not install Xcode, accept its license, download Apple runtimes, or modify Android SDK installations. Release maintainers should change these recommendations alongside deliberate helper upgrades and validate them on their supported hosts.

The existing inspection, progress, update and pruning behavior came from [t3code #12816](https://github.com/pingdotgg/t3code/pull/12816), [#12817](https://github.com/pingdotgg/t3code/pull/12817), [#12818](https://github.com/pingdotgg/t3code/pull/12818), [#12819](https://github.com/pingdotgg/t3code/pull/12819), and [#12877](https://github.com/pingdotgg/t3code/pull/12877). This implementation extends those contracts and maintenance paths.

## Client contract

The existing `device.list` RPC accepts `{ inspectOnly: true }` for read-only inspection. It returns `DeviceServiceState` and refreshes every configured host, including SSH hosts, without enabling access or starting helpers. `subscribeDeviceState` carries the initial snapshot and subsequent changed snapshots. The method constant is `WS_METHODS.subscribeDeviceState`. An unchanged refresh does not increment `revision` or publish a WebSocket event. Device discovery merges every host before publishing, ordered by configured host and device ID, so parallel completion order cannot produce intermediate snapshots. Conflicting path and query device selectors are rejected before a proxy request claims or reaches a simulator.

New state fields are optional so older server snapshots remain decodable:

- `supportsEnvironmentToolSync: true` advertises update and requirements RPCs. `supportsToolRestart: true` advertises `device.restartTools`.
- `manifest` contains `revision`, `hub`, `agent`, `serveSim`, `recommendedXcode`, and `recommendedRuntimes: [{ platform, version }]`.
- `hosts[].tools` retains the existing `hub` and `agent` objects and adds optional `serveSim`. Each has `requiredVersion`, `installedVersions: string[]`, and `runningVersion: string | null`.
- `hosts[].sdkInventory` contains `xcode: string | null`, `sdks`, `runtimes`, and `inspectionErrors`. SDKs and runtimes are `{ platform: "ios" | "android", version: string }` arrays. Probe error keys are `xcode`, `ios:sdk`, `ios:runtime`, `android:sdk`, and `android:runtime`.
- `hosts[].drift` contains `{ tool, status, expected, actual, restartRequired }`. Tool names are `hub`, `agent`, `serveSim`, `xcode`, `iosRuntime`, and `androidRuntime`. Status is `match`, `missing`, `different`, or `unknown`. `actual` is a string array. An installed matching version can still have `restartRequired: true` if an older helper is running.
- Existing `hostStatuses[hostId]` and the local `hostStatus` describe lifecycle status. `toolInspectionError` marks cached inventory that could not be refreshed.
- `devices[].inUseBy`, when present, contains `{ environmentId, environmentLabel }` for another environment holding that device.

| RPC                        | Payload                                                                                                            | Result                                    | Permission            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------- |
| `device.updateTools`       | `{ hostId?: string, tools?: ("hub" \| "agent")[] }`                                                                | `DeviceServiceState`                      | orchestration operate |
| `device.restartTools`      | `{ hostId?: string, tools?: ("hub" \| "agent")[] }`                                                                | `DeviceServiceState`                      | orchestration operate |
| `device.checkRequirements` | `{ hostId?: string, requirements: { kind: "sdk" \| "runtime", platform: "ios" \| "android", version: string }[] }` | `{ hostId, satisfied, missing, unknown }` | orchestration read    |

Omit `hostId` to target the local host of the connected environment. Omit `tools` to install both pinned helpers. A hub update includes serve-sim. Duplicate tools are collapsed. Updates install into the shared cache and refresh inventory, leaving running helpers, sessions and consent unchanged. To activate installed pins, call `device.restartTools` with the same host and tool selection. Omitted tools mean both helpers; inactive helpers stay inactive. A hub restart includes its bundled serve-sim. Session records and simulator leases survive the restart. Streams reconnect through the same proxy URLs, and existing agent grants are refreshed for the new daemon endpoint. The client-runtime command is `createDeviceEnvironmentAtoms(runtime).restartTools`, serialized with `updateTools` per environment. RPC failure rejects with the existing typed `DeviceError` union; a failed download can be retried.

The comparison UI subscribes to each connected environment and keeps its existing environment descriptor beside the snapshot. For Update all, fan out `device.updateTools` to those connections and retain an individual success or failure for each environment. There is no server-side global environment registry or cross-environment mutation endpoint. Local, direct remote, relay and tunnel clients use the same RPCs.

For a pre-build warning, the build integration supplies the project's resolved requirements. For example:

```json
{
  "requirements": [
    { "kind": "sdk", "platform": "ios", "version": "26.0" },
    { "kind": "runtime", "platform": "ios", "version": "26.0" }
  ]
}
```

The server checks installed simulator SDK and runtime versions exactly. Android versions are API numbers such as `36`. `missing` and `unknown` contain the original requirement objects. `satisfied` is false if either array is nonempty. This RPC does not execute project configuration, infer a target from the recommended manifest, or certify signing, licenses, dependencies, device ABI, or build success.

## Shared cache and reclamation

All environments under the same OS account use `~/.pathway/device-cache/tools/<package>/<version>`. SSH and local hosts use the same layout on the machine that owns the devices. `PATHWAY_DEVICE_CACHE_DIR` overrides the cache root for isolated tests or managed installations; environments sharing devices must use the same root. Helper state and daemon tokens remain environment-specific. Older per-environment installs are left untouched.

Install, usage registration and reclamation take the same filesystem lock. A contender atomically renames a populated directory containing its PID and process-start identity into `.maintenance-lock`. A unique owner filename prevents a stale contender from deleting a replacement owner. The lock remains held across asynchronous installation. Dead owners are reclaimed; an unverifiable live owner is retained. Node's in-process semaphore alone is insufficient here.

An install writes to a temporary sibling, verifies its entry point, writes the completion sentinel, and renames the tree into place. Before exposing a path, local environments register their process and version under `.users`. SSH bootstrap processes register before spawning helpers. Reclamation keeps the required version, the last other completed version, every live usage record, and every version referenced by a running process. Incomplete installs and symlinks are preserved. Failed process scans or unreadable usage records skip deletion. Pruning remains advisory and runs after successful helper startup.

## Simulator ownership

Device ownership is separate from the install lock. Per-device lease records live under the shared cache's `leases` directory. The same atomic lock protocol serializes acquisition and release. iOS keys use the UDID; Android virtual devices use the AVD name so booting from an AVD name into an emulator serial does not change ownership.

A lease records the environment label, environment ID, process ID, process-start identity and a unique server instance. Multiple threads within one environment can use the same device. Two environment processes cannot. Open, shutdown, screenshot, detail, action, agent target setup and device-specific proxy requests check ownership. Media and input requests that omit a device are rejected. Inventory discovery is shared. Ownership inspection batches every device on a host into one transaction and one SSH command, with one liveness check per owner process.

Leases last for the environment's device-host lifetime. Closing a thread does not release a simulator while a helper or socket may still be using it. Disabling device support stops helpers before releasing local leases. If a helper outlives that stop, `releaseAll` atomically marks its retained leases as `relinquished`. Local and SSH readers then retain ownership only while those recorded helpers survive, regardless of whether the server is still running. Later helper starts do not extend relinquished leases; an explicit acquisition is needed to own those devices again. Without an explicit release, a lease becomes reclaimable only after its owner and recorded helpers have exited. PID and process-start identities distinguish a surviving helper from a reused PID. After a guardian SIGKILL, another environment continues to see the original owner while any of those helpers can still serve. Once they exit, the next inspection or acquisition reclaims the lease. A paused but live process keeps its lease; there is no wall-clock timeout that lets it resume into someone else's device.

SSH forwarding runs a host-side guardian over the same SSH channel. It holds remote leases and captures the PIDs returned by that environment's helper startup. Channel EOF stops those helpers before the guardian exits. Helper identities are persisted in the lease and its owner record, so a SIGKILL cannot bypass ownership checks. Restarts keep the original guardian connected and replace only the selected helper processes. Fresh SSH forwards carry their new ports, and the guardian reads updated helper identities when cleaning up. A new connection waits for the previous guardian to finish. Network partitions retain ownership until SSH detects the lost connection; they do not allow a second environment to take over an active stream.

The injected agent-device launcher also requires the exact target granted by `device_open`, the current daemon endpoint, and a live owning server. A different device selection or an unexpected endpoint change requires another `device_open`. An explicit helper restart refreshes grants already issued by the current host instance; disabling access discards that grant history.

These leases coordinate Pathway environments using this implementation. They do not arbitrate Simulator.app, external automation, older Pathway releases, or direct execution of unmanaged helper binaries. Separate OS accounts have separate caches and leases.

## Verification

Focused tests cover asynchronous lock contention across processes, one download under competing installs, live-version retention before a helper starts, dead and reused PID recovery, competing simulator leases, owner death, local/SSH lease interoperability, SSH channel cleanup, drift, SDK checks, update retry and consent preservation, unchanged snapshots, proxy authorization, and CLI target binding. Tests use temporary directories and stand-in helper processes. No development server or browser is needed.
