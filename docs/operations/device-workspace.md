# Device workspace operations

## Ordinary setup

Device support defaults off. Enabling it installs pinned `expo-device-hub@0.9.0` beneath the environment's Pathway home and starts a loopback process. Agent access separately installs `agent-device@0.20.10`. Settings and sessions are environment-local; there is no additional Convex database workload.

Clients reach the hub through authenticated `/api/device-hub/*` routes, including WebSocket upgrades. A reverse proxy must forward both HTTP streaming responses and WebSocket upgrades without buffering. Discovery and screenshots require orchestration-read scope; input and tuning require orchestration-operate scope. Shell execution, the vendor dashboard and WebRTC endpoints are not exposed.

Device state is pushed over the existing RPC connection. A hidden view closes its media decoder and requests. Three.js is loaded only when a 3D viewport is needed. Device controls use the host associated with the selected device, never an implicit currently active host.

## Experimental Duo helper

The official pinned hub does not include the required native Duo capture/control implementation. Do not treat the upstream draft as a released dependency.

On an Apple Silicon Mac with a compatible Xcode and iOS Duo runtime:

```sh
node scripts/build-duo-device-hub.ts /tmp/pathway-duo-build
```

The recipe checks out serve-sim commit `bb265b11c13b395e5302d121458e2d42224a2e9f`, verifies and applies `scripts/patches/serve-sim-duo-physical-orientation.patch`, builds the helper, and packages it with the pinned hub and upstream license notices. Patch SHA-256: `ed67a0803952b7554dae0466125c915850013d9042470d87e3d25cbb9827f01a`.

Start an isolated environment using the archive path printed by the script:

```sh
PATHWAY_DEVICE_HUB_ARCHIVE=/absolute/path/to/generated.tgz vp run dev --home-dir /tmp/pathway-device-test
```

The archive must use an absolute path and carry the expected commit, patch hash and version. The installation cache keeps it separate from the official build. Do not point this test at a live Pathway home. SSH device hosts currently use the official hub and do not inherit this override.

Duo input stays suspended during a display switch until the native helper acknowledges the selected display and a fresh matching video frame arrives. Failed handoffs time out and roll back. The prototype still needs wider hardware/performance and cover-display orientation qualification before being made the release default.

## Validation record

The pinned native helper compiled successfully on Corey's M1 with Xcode 27.0. An isolated Pathway server and a new disposable Duo simulator were used for integration verification. The normal application reached the Cloud sign-in screen; the documented development test account was unavailable, so component verification used real product components and the paired backend in a temporary harness, not a claimed full signed-in product test.

Android SDK command-line tools were absent. SSH host and Android control paths have focused automated coverage but were not exercised against live remote hardware in this run.

The live pass exercised setup, discovery, book/closed posture changes, native display acknowledgements, flat/3D switching, hide/show stream cancellation and reconnection, and disabling support. It reproduced the experimental cover display's sideways orientation. App interaction was not conclusively verified: an attempted Settings launch did not yield a clear usable app frame. Treat native capture and touch behavior as remaining qualification work, not a passed end-to-end check. Narrow viewport behavior was not inspected live.

The temporary component harness, isolated server, and newly created simulator were removed or stopped after verification. Existing user simulators and the installed Pathway app were left running unchanged.

Final checks passed: 321 focused tests across 47 test files, server and web package typechecks, and targeted lint/formatting. A final isolated startup smoke check authenticated to the real WebSocket server and exercised the server configuration, device list, device configuration and device-state subscription. Device helpers stayed disabled during that check. These results do not qualify the experimental native helper for a production release.
