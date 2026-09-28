# Environment surface streams

`GET /ws/environment-surface` streams an environment-owned surface. Version one
supports `kind=browser&threadId=…&tabId=…`, plus `width`, `height` in CSS pixels and
`deviceScale`. The prepared environment connection supplies the origin and proxy
prefix. Cookie, bearer-ticket and relay DPoP-ticket authentication match the
computer frame route. `orchestration:read` is required. Session revocation closes
the socket with 1008. The route does not launch a browser or create a tab.

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
  resolveUrl: (viewport) =>
    runtime.runPromise(
      resolveSurfaceSocketUrl({
        prepared: currentPreparedConnection(),
        signer: currentRelaySignerOption(),
        target: { kind: "browser", threadId, tabId },
        viewport,
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
