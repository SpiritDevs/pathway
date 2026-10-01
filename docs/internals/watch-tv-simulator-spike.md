# Watch / TV simulator spike and upstream patch note

COR-103 / COR-104, 2026-10-01. This records a local backend spike; no upstream PR
or issue was opened. No Pathway dev server, browser or mobile UI was launched.

## Capture result

**tvOS IOSurface capture works on this machine.** The unmodified
`serve-sim-native.node` from expo-device-hub 0.12.0 reported a 1920×1080 direct
IOSurface framebuffer and emitted valid 1280×720 JPEG frames. Captures showed
the TV home screen and Settings. This is actual native capture, not a substituted
screenshot or placeholder. H.264 uses the same framebuffer but was not separately
decoded during this spike.

The test used Apple Silicon, Xcode 27.1 (27A9269), tvOS 27.0 and the existing
Apple TV 4K (3rd generation, 1080p) simulator. Each spike checked that the target
was shut down, booted only that UDID, waited on `simctl bootstatus -b`, and shut
down that same target in a finally block. Watch/iPhone simulators were not booted
or paired. Real Watch input/pairing is covered at mocked process boundaries only.

## Where the helper comes from

[expo-device-hub 0.12.0](https://github.com/expo/expo-device-hub/tree/7ec4a4a8e28acd52cf197eed24ccae945e6ebd60)
vendors serve-sim in `vendor/serve-sim`. Its native capture/HID implementation is
a Swift N-API addon at `dist/native/serve-sim-native.node`; the npm package includes
the compiled binary. Native source is in upstream
`packages/serve-sim/packages/serve-sim/Sources/SimNative`.

Pathway installs npm 0.12.0 into a staging directory and applies
`deviceHubPatch.ts`, producing the local pin **0.12.0-pathway.1**, manifest revision 2. The patch verifies SHA-256 for the hub server bundle and both serve-sim entry
points before changing anything. Both local and SSH installers apply identical
source. The completion marker is written only after patching and native helper
compilation succeed; existing running versions remain untouched.

## Input findings

`simctl io` has no remote-button injection command in this toolchain. The existing
serve-sim `SimHID.buttonHid` accepted calls but targeted the iPhone digitizer
(`0x32`). Sending TV buttons through it crashed the guest's backboardd with an
assertion in `SimHIDVirtualServiceManager.serviceForIndigoHIDData`. Native return
success was therefore insufficient evidence of usable input.

The replacement uses the guest's DTUHID XPC service:
`com.apple.coredevice.feature.remote.hid.digitizer`. Despite its name, this service
accepts keyboard and consumer-button messages on tvOS without a touchscreen.
CoreSimulator looks up the guest Mach port. `xpc_endpoint_create_mach_port_4sim`
and `xpc_connection_enable_sim2host_4sim` establish the simulator connection.
Protocol reference: [idb's simulator XPC connector](https://github.com/facebook/idb/blob/3d18bd361cf85d15e290b47b38660e8f72dd5c99/FBSimulatorControl/XPC/SimulatorXPCConnection.swift)
and [DTUHID transport](https://github.com/facebook/idb/blob/3d18bd361cf85d15e290b47b38660e8f72dd5c99/FBSimulatorControl/HID/SimulatorDTUHIDConnection.swift).

`tvInputNative.ts` embeds the small Objective-C helper compiled with `xcrun clang`
on the selected Mac. It validates a TV target, confirms service liveness and
keeps the connection warm. The protocol carries a `messageType`, `featureIdentifier`,
`isBarrier` and dictionary payload. Keyboard events use `IndigoKeyboardButtonEvent`
and `usageCode`, `state`; consumer events use `IndigoButtonEvent` with `usagePage: 12`.
States are down=1, up=2. Up/down/left/right use keyboard usages 0x52/0x51/0x50/0x4f,
select uses Return (0x28), menu/back uses Escape (0x29), home uses consumer 0x40,
and play/pause uses consumer 0xcd. A no-event service barrier acknowledges dispatch.

The integrated helper produced captured proof of select opening Settings, down
moving focus from General to Profiles and Accounts, up restoring General, and
back returning to the home screen. All arrows, home and play/pause were
acknowledged without a guest crash. No media app was available, so actual
play/pause playback behavior is not claimed. No left/right focus movement was
visible in the vertical Settings list.

The bridge reuses one native child per serve-sim device session, bounds its queue
to 64 presses, rejects on timeout/exit and restarts on the next press. Session
close stops only its captured child; stdin EOF also terminates the helper when
the hub exits. There is no process-name matching or per-key process spawn.
Unsupported DTUHID symbols/services fail explicitly. Other Xcode/runtime versions
have not been exercised; no fallback to the crashing digitizer path is allowed.

## Upstream changes to propose later

1. Include watchOS/tvOS and never-used available simulators in hub discovery;
   emit device family from runtime/device type.
2. Add tvOS to both serve-sim runtime parsers. Capture needs no native changes on
   the tested toolchain.
3. Add an acknowledged semantic input envelope; keep native errors visible.
4. Route TV remote buttons through DTUHID keyboard/consumer events, not the
   legacy digitizer path, with connection lifetime tied to the capture session.

Watch's existing touch, Digital Crown and side/crown button implementations are
reused. Companion pairing belongs in Pathway's selected-host action boundary.
agent-device 0.21.12 supports TV selectors (`--platform ios --target tv`) but has
no watchOS XCTest runner. Watch uses the new native MCP input/action tools and
existing screenshot tool. Its `agentCli` capability reports unsupported with a
reason, while native streaming/input remain available.

## Proof boundaries

Focused tests mock simctl, helper sockets, native-process acknowledgements, install
compilation and SSH transport. They cover selected-host routing, ownership,
pair/unpair, boot/attach failures, consent, proxy authentication/revocation,
family input validation and helper cleanup. Live SSH/Connect and a client viewer
were not launched. The UI handoff is in [device-client-contract.md](device-client-contract.md).
