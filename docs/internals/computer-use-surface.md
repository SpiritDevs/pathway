# Persistent computer surface

COR-167 adds a primary-screen viewer and a connection-owned control handoff. The
viewer does not need a thread, Computer consent or an active agent turn. The
ambient, window-scoped computer preview remains separate.

## Frames

Use `EnvironmentSurfaceTarget` with `{ kind: "computer", computerId: "desktop" }`.
The ID is the existing `ComputerService.manager.computerId`, also returned by
`computer.getStatus`. There is no `spaceId`: the pinned CUA host captures the
primary display on its current Space. It cannot capture an arbitrary Space or
secondary display as a complete screen.

Use `resolveSurfaceSocketUrl` and `createEnvironmentSurfaceStream` from
`@spiritdevs/client-runtime/surface`. Pass the target and
`EnvironmentSurfaceViewport` to the existing resolver. It preserves the prepared
environment's proxy prefix and uses the same cookie, bearer ticket or relay DPoP
ticket as the browser viewer. `orchestration:read` permits viewing. Revoking the
session closes the stream. `makeSurfaceSocket` handles both native and Bun
writer-only sockets, including backpressure and ping/pong receipts.

The wire format is the existing 24-byte header followed by JPEG. Width and height
are encoded-image pixels. For computer frames, `deviceScale` is encoded pixels
per desktop point. The primary display's origin is `(0, 0)`. Convert a pointer
position within the displayed image rectangle using:

```ts
const x = ((localX / displayedImageWidth) * frame.width) / frame.deviceScale;
const y = ((localY / displayedImageHeight) * frame.height) / frame.deviceScale;
```

Exclude letterboxing before this calculation. Viewport dimensions are an encoding
budget; they never resize the host display. The timestamp is server encode time.

`ComputerSurfaceStream` owns one capture loop and JPEG encoder per manager. It
calls the backend's `captureSurface`, which uses CUA's `get_desktop_state` without
model-observation authority. It targets 15 fps, permits only one capture in
flight, and waits for a slower host. The pinned driver returns PNG, so this is a
capture-limited JPEG stream, not native video. `StillFrameDedupe` suppresses JPEG
encoding and transmission for byte-identical captures. Geometry changes force a
new header. The shared `EnvironmentSurfaceStream` applies JPEG quality 75/60/45,
resolution reduction and bounded per-viewer pending frames. Late viewers receive
the retained frame. The final viewer leaving interrupts capture and drops the
retained image. No capture or encoding starts with zero viewers. In-flight native
capture/encoding may finish while its result is discarded.

## Control RPCs

The exported schemas are in `packages/contracts/src/computerSurface.ts`. They are
members of `WsComputerRpcGroup` and the main `WsRpcGroup`.

| Constant in `COMPUTER_SURFACE_METHODS` | Method                            | Payload                           | Result                                  |
| -------------------------------------- | --------------------------------- | --------------------------------- | --------------------------------------- |
| `getState`                             | `computer.surface.getState`       | `{}`                              | `ComputerSurfaceSessionState`           |
| `subscribe`                            | `computer.surface.subscribe`      | `{}`                              | Stream of `ComputerSurfaceSessionState` |
| `takeControl`                          | `computer.surface.takeControl`    | `{}`                              | `ComputerSurfaceSessionState`           |
| `releaseControl`                       | `computer.surface.releaseControl` | `{}`                              | `ComputerSurfaceSessionState`           |
| `input`                                | `computer.surface.input`          | `{ event: ComputerSurfaceInput }` | `void` acknowledgement                  |
| `handBack`                             | `computer.surface.handBack`       | `ComputerSurfaceHandBackInput`    | `ComputerSurfaceHandBackResult`         |

State and subscription need `orchestration:read`. The other methods need
`orchestration:operate`. Take and input also check the current Computer access
policy. Input rechecks that policy after its queue wait. Release, hand-back and
Escape remain available if the policy changes while the client has control.
Errors use the existing `ComputerError | EnvironmentAuthorizationError` union.

```ts
type ComputerSurfaceSessionState = {
  clientId: string;
  state: {
    computerId: string;
    revision: number;
    controller:
      | { kind: "idle" }
      | { kind: "agent"; threadId: ThreadId }
      | { kind: "client"; clientId: string };
    activeTurns: readonly { threadId: ThreadId; runId: string }[];
    capabilities: { capture: boolean; input: boolean; pointerPhases: boolean };
  };
};
```

The server assigns `clientId` to the RPC socket. Requests never supply it. Compare
`state.controller.clientId` with the outer `clientId` to determine whether this
connection owns control. Reconnection gets a new ID. The subscription immediately
emits current state and then changes through a one-entry sliding queue. It does
not capture frames. `activeTurns` lists Computer-enabled turns, including turns
paused behind human ownership. When several agents have turns, the controller's
thread is the first active entry; the array retains the others.

Take reserves ownership immediately and acknowledges after accepted desktop work
drains. Another client cannot take, release or inject input during that ownership.
Agent calls wait outside `DesktopOperationQueue`, rechecking ownership after queue
admission so prequeued agents cannot block the human's input. Durable
`ComputerControlState` consent and revocation generations remain unchanged. They
are checked again when an agent resumes. `ComputerSurfaceControl.waitForControl`
is this ownership wait; the older `waitForControl.ts` waits for an accessibility
element and has no ownership semantics.

Root turn start and the existing `ComputerRunCalls` stop fence update active-turn
state. Ending a turn does not close the viewer or release a human controller.
Closing or revoking the controller's RPC connection stops its native input,
cancels its queued input and releases ownership. Closing only the image socket
does not release control. The UI should release when closing its control view.

## Input

`ComputerSurfaceInput` is a discriminated union:

```ts
type Modifiers = readonly ("ctrl" | "alt" | "shift" | "meta")[];
type Pointer = {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  modifiers?: Modifiers;
};
type ComputerSurfaceInput =
  | ({ type: "pointer.move" | "pointer.down" | "pointer.up" } & Pointer)
  | ({ type: "pointer.click"; clickCount?: 1 | 2 } & Pointer)
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: Modifiers }
  | { type: "key"; key: string; modifiers?: Modifiers }
  | { type: "type"; text: string };
```

Coordinates are primary-display desktop points. Wheel deltas are logical pixels;
the existing backend converts them to host wheel units. Keys use the existing
Computer key spelling, such as `Enter`, `Tab`, `A` and `Escape`. A `key` event is a
complete press or shortcut, not a held key. Text is bounded at 16,384 characters.
The client should coalesce pointer moves and wheel events and keep its input
queue bounded. The server's existing desktop queue rejects overload at 64 entries.

All input passes through `DesktopOperationQueue`. Clicks and wheel gestures reuse
the manager's point-to-window resolution. Keyboard input asks for the human's
fresh keyboard-focused window, rather than inheriting the agent-selected window.
Legacy computer input RPCs cannot bypass a claimed surface. Escape invokes the
existing emergency stop immediately, outside the input queue, and releases the
human controller. Physical Escape reaches the same manager path.

The pinned CUA host supports clicks, wheel, key and text on macOS. It does not
expose physical mouse move/down/up, so `pointerPhases` is false and those events
fail explicitly. Its existing `move_cursor` only moves the agent overlay. Middle
click is also unavailable. A future backend can implement `surfacePointer` and `stopInput` for
real pointer phases and held-input cleanup. Do not enable drag or held-button UI on a host reporting
`pointerPhases: false`.

## Hand back with context

```ts
type ComputerSurfaceHandBackInput = { threadId: ThreadId; messageId: MessageId };
type ComputerSurfaceHandBackResult = {
  attachment: ChatImageAttachment;
  summary: string;
  state: ComputerSurfaceSessionState;
};
```

Allocate the message ID before calling hand-back. The server drains accepted
input, captures a fresh primary-screen frame, encodes a JPEG bounded at 1536
pixels per side, and stores it through the chat attachment ID/path conventions in
`ServerConfig.attachmentsDir`. Only then does it stop held native input and
release ownership. A capture or storage failure retains control so the UI can
retry or use ordinary release. The result contains the persisted attachment
metadata, not inline image bytes. Use `assets.createUrl` with an attachment
resource to preview it through the authenticated environment asset route.

The summary contains at most 32 recent successful actions plus a count of omitted
actions. Pointer moves collapse; typed text and key contents are excluded. The log
is memory-only and ends with that control period.

Send the follow-up using `ORCHESTRATION_V2_WS_METHODS.dispatchCommand`, whose wire
name is `orchestration.dispatchCommand`, with `OrchestrationV2Command`:

```ts
{
  type: "message.dispatch",
  commandId,
  threadId,
  messageId, // the ID allocated before handBack
  createdBy: "user",
  creationSource: "web", // or "mobile"; Electron uses "web"
  text: `/computer-use ${message}\n\n${handBack.summary}`,
  attachments: [handBack.attachment],
  dispatchMode: { type: "queue_after_active" },
}
```

Use the existing dispatch-mode selection if the user chooses to steer or restart
an active run. The `/computer-use` prefix opts the follow-up into Computer for one
turn. A chat already using standing Computer consent can instead pass its normal
`enableComputerControl` and `computerControlGeneration` fields. No extra upload or
`assets.persistChatAttachments` call is needed. Hand-back and message dispatch are
separate RPCs; releasing can resume an already waiting agent before the follow-up
arrives. The UI owns follow-up retry and should retain the returned attachment and
summary until dispatch succeeds.

## Web client

The web and desktop client renders this surface as the `computer` right-panel tab
(`apps/web/src/components/computer/ComputerSurfaceView.tsx`). It streams through
`useEnvironmentSurface`, the same hook the remote browser uses, and reads state
from `computerEnvironment.surfaceState`. Input goes through one serial queue; plain
left clicks are paired into double clicks before sending; wheel and, on hosts with
pointer phases, pointer moves are coalesced per animation frame. Hand-back
dispatches through `dispatchComputerHandBack` in client-runtime and keeps the
capture, command id and message id for a retry when dispatch fails, so a retry
after a lost response is a duplicate command rather than a second run.

`createComputerControlLease` (`computerSurface.logic.ts`) orders control changes
against the view's own input: release and hand back stop new input, flush the
waiting click and drain the send queue first. Unmounting or hiding the page
releases held control, and a takeover still in flight is released when it lands.
While in control the canvas carries `data-keybinding-capture` and stops key
propagation, so window-level shortcuts and type-to-focus leave its keys alone;
the remote browser canvas does the same. The mobile clients do not have this view
yet.

## Host support and verification

A host without CUA reports no computer capture/input support, and the frame route
returns 404. A configured non-macOS CUA endpoint can expose primary-screen capture;
its existing capability probe determines native input support. The pinned Linux
backend advertises native desktop input as unavailable. OS screen-recording and
accessibility permissions still apply. Native video capture, arbitrary Spaces,
secondary displays, physical pointer phases and rich clipboard input are outside
this backend's supported paths.

Focused tests cover wire validation, shared encoding and dedupe, backpressure,
viewer teardown, ownership and queue races, durable consent, Escape, policy
changes, stored attachments, read/operate scopes, session revocation and the
writer-only socket adapter. They use deferred receipts, scope drains and the
Effect test clock. Native host throughput and hosted/relay UI flows require an
integrated client pass by the UI owner.
