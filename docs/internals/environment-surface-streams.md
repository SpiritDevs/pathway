# Environment surface streams

`GET /ws/environment-surface` streams an environment-owned surface. Version one
supports `kind=browser&threadId=…&tabId=…` and `kind=computer&computerId=desktop`,
plus `width`, `height` in logical pixels and `deviceScale`. Browser streams accept an
optional `sizing=active|passive`, which defaults to `active`. The prepared
environment connection supplies the origin and proxy
prefix. Cookie, bearer-ticket and relay DPoP-ticket authentication match the
computer frame route. `orchestration:read` is required. Session revocation closes
the socket with 1008. The route does not launch a browser or create a tab. Computer capture, control
RPCs and coordinate mapping are described in [Persistent computer surface](computer-use-surface.md).

After opening, send text `ready`. The server sends text `ping` every 15 seconds;
reply `pong`. A missing reply closes the socket on the next heartbeat. These are
control messages only. Frames contain no JSON or base64. Chromium's CDP boundary
still supplies base64, decoded once on the environment.

## Binary format

Each message contains a 24-byte little-endian header and one complete JPEG.

| Offset | Type    | Meaning                                       |
| ------ | ------- | --------------------------------------------- |
| 0      | uint16  | Magic 0x5350                                  |
| 2      | uint8   | Version 1                                     |
| 3      | uint8   | Codec 1, JPEG                                 |
| 4      | uint32  | Sequence, wraps modulo 2^32                   |
| 8      | uint16  | Encoded image width in pixels                 |
| 10     | uint16  | Encoded image height in pixels                |
| 12     | float32 | Encoded pixels per CSS pixel                  |
| 16     | float64 | Server frame arrival time, epoch milliseconds |
| 24     | bytes   | JPEG                                          |

Use decoded image dimensions for drawing. Divide image coordinates by deviceScale
for CSS-coordinate input. Latency is approximate and includes clock skew; the
server timestamp measures CDP arrival, not the compositor's capture instant.

## Capture and congestion

All viewers of a tab share one CDP screencast, including legacy RPC viewers and
explicit video recordings. No screencast runs without one of these consumers.
Recording is an explicit capture request and continues without a watching client.
The binary transport encodes one envelope per captured frame regardless of viewer
count. The old RPC representation is only published when an RPC viewer exists.

The largest active binary viewer by CSS area determines the shared viewport;
ties preserve subscription order. CSS dimensions fit within 2560 by 1600, DPR is
at most 2, and raster area is at most four million pixels. This avoids competing
resizes from multiple viewers. A viewer changing size reconnects with its new
viewport. Legacy RPC resize commands remain available during migration.

Use `sizing=passive` for mini-player previews. Passive viewers never set the page's
viewport or device metrics, regardless of their requested dimensions. When no
active binary viewer remains, the page keeps its current size, including the
agent's size or the last active viewer's size. Agent resize commands still work.
Passive viewers keep capture alive and receive the same encoded frames as other
viewers. Clients scale those frames to fit their preview. The shared encoder's
size and congestion limits still apply, with no per-viewer transcodes.

Each viewer retains one replaceable pending frame. Native socket bufferedAmount
above 256 KiB blocks further sends; the bound allows one admitted JPEG beyond
that threshold. Frames above 8 MiB including the header are discarded. A shared
latest frame is replayed to new viewers. First capture forces a screenshot when
there is no retained image. Closing or pausing the final viewer clears retained
frames and stops capture unless an RPC viewer or recording remains.

A 100 ms watched-tab timer drains pending frames even on static pages. Congested
viewers lower the shared quality through JPEG 75/60/45 and size 100/80/60 percent.
The worst viewer determines encoding quality. Each five seconds of uncongested
samples restores one step. This deliberately uses one encoder, with no per-viewer
transcodes. Timers stop when the final binary viewer leaves.

## Client runtime

`@spiritdevs/client-runtime/surface` exports:

```ts
createEnvironmentSurfaceStream(options: SurfaceStreamOptions): {
  readonly state: "connecting" | "live" | "stale" | "failed";
  pause(): void;
  resume(): void;
  setViewport(viewport: EnvironmentSurfaceViewport): void;
  close(): void;
}
```

```ts
const stream = createEnvironmentSurfaceStream({
  viewport: { width: 1280, height: 800, deviceScale: 2 },
  sizing: "passive",
  resolveUrl: (viewport, sizing) =>
    runtime.runPromise(
      resolveSurfaceSocketUrl({
        prepared: currentPreparedConnection(),
        signer: currentRelaySignerOption(),
        target: { kind: "browser", threadId, tabId },
        viewport,
        sizing,
      }),
    ),
  onFrame: (frame) => draw(frame.image),
  onState: (state) => updateConnectionIndicator(state),
  onQuality: ({ fps, latencyMs }) => updateQuality(fps, latencyMs),
});
// Wire these to visibility changes and component lifetime.
stream.pause();
stream.resume();
stream.close();
```

`SurfaceStreamOptions.sizing` and `resolveSurfaceSocketUrl`'s `sizing` option both
default to `active`. Forward the resolver's second argument as shown above so
reconnects and `setViewport` preserve the role. `createSurfaceSocketAtoms.resolveUrl`
accepts the same optional `sizing` field.

The resolver runs on every connection attempt so refreshed credentials and relay
URLs take effect. Retry delay starts at 500 ms, doubles to 30 seconds, with jitter.
Eight failures expose `failed` while reconnect attempts continue; session
revocation is terminal until explicit resume. A silent connection is replaced
after 35 seconds. The client decodes at most one image at a time and retains only
the newest pending message. It releases ImageBitmaps or Blob URLs on replacement,
pause and close, and discards late decode results from old connections. Native
clients without browser image APIs can supply `decode` and `createSocket`.

UI work remains to connect visibility, viewport, drawing and quality indicators.
The legacy `subscribePreviewRemoteFrames` RPC remains supported; metadata-only
subscriptions do not capture images.

## Browser interaction RPCs

`preview.remote.interactions({ threadId })` is a read-scoped subscription. It emits
`PreviewRemoteInteractionEvent`, a complete snapshot of all open tabs' interaction
state, on changes and subscription. Its one-entry sliding queue preserves every
currently pending prompt while dropping obsolete states. This subscription does
not capture frames. Subscribe to both it and the binary stream when implementing
a browser viewer.

`preview.remote.interact(command)` requires `orchestration:operate`, selects the
environment browser host and applies the existing agent takeover checks. It
returns a void acknowledgement; changes arrive on the interaction subscription. Replies bypass the tab's
navigation/action queue, so a click waiting for a dialog cannot block its reply.
The UI must also dispatch this RPC outside its serial `remoteCommand` scheduler.

All commands include `threadId` and `tabId`:

| Action               | Additional fields                                                             | Behavior                                                |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `clipboardRead`      | none                                                                          | Reads browser plain-text clipboard into `clipboard`     |
| `clipboardWrite`     | `text`                                                                        | Writes client plain text into the browser clipboard     |
| `dialogRespond`      | `dialogId`, `accept`, optional `promptText`                                   | Answers alert, confirm, prompt or beforeunload          |
| `fileChooserRespond` | `chooserId`, `files: [{ attachmentId, name, mimeType }]`                      | Supplies previously uploaded files; empty array cancels |
| `selectChoose`       | `selectId`, `indices: number[] \| null`                                       | Chooses option indices; null cancels                    |
| `composition`        | `phase: update \| commit \| cancel`, `text`, `selectionStart`, `selectionEnd` | CDP IME composition with UTF-16 selection offsets       |
| `pointerMove`        | `x`, `y`                                                                      | Moves the remote pointer and updates cursor feedback    |
| `wheel`              | `x`, `y`, `deltaX`, `deltaY`, optional `modifiers`                            | CDP pixel deltas, including fractional trackpad deltas  |

Coordinates are CSS pixels. Modifier bits are CDP Alt=1, Control=2, Meta=4,
Shift=8. The existing `scroll` RPC still accepts pixel `deltaX` and `deltaY`.
Clipboard text is limited to 64,000 UTF-16 code units. Read/write uses the page's
origin-scoped Chromium clipboard permissions; copied/cut text also appears in the
interaction snapshot. Rich clipboard formats are not included in version one.

Each tab's state contains `cursor`, `clipboard`, nullable `dialog`, `fileChooser`
and `select`, and up to 20 recent download records. Cursor updates use CSS cursor
shapes, with text/link inference for `auto`; custom cursor images use their CSS
fallback shape. The injected frame bridge runs on input and target style changes,
without a continuous animation loop. Native selects report up to 1,000 options
with indices, labels, values, selected/disabled state and the multiple flag.
Responses address the originating frame and reject stale popups. Selection emits
DOM input and change events. Main-frame navigation clears transient input state.

Upload files using the existing `attachments.createUploadUrl` flow, then send the
returned attachment IDs. The server accepts pending uploads or this task's
attachments, up to 20 files and 50 MiB in total. It rechecks control after reading
the files. Keep uploads until the chooser RPC succeeds, then the client can remove
its pending uploads. The server never accepts arbitrary filesystem paths.

Downloads emit `downloading`, then `ready` with a signed environment-relative asset
URL, or `failed` with an error. Fetch ready URLs against the prepared environment's
HTTP base, including its proxy prefix. Signing uses the existing attachment asset
route and preserves the original filename. Subscription replay renews links.
Files are retained in the task's capture index, with its existing 50-file/1-GiB
retention and deletion cleanup. The copied file is capped at 50 MiB; Chromium may
already have received a larger temporary download before Playwright exposes its
read stream. Downloads remain separate from the legacy screenshot/video list.

Dialogs and file choosers are presented while an interaction subscriber exists.
The final subscriber leaving dismisses pending prompts. With no interaction
subscriber, dialogs retain the previous auto-dismiss behavior, and native selects
are not intercepted. Web/desktop/mobile UI code must add the subscription and
interaction RPC wrappers, prompt rendering, clipboard permissions, upload flow,
download controls and input dispatch. Provider adapters are unchanged; automation
and remote/relay viewers share the environment-owned pages.
