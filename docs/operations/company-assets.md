# Company asset rollout and validation

The company asset implementation adds private UploadThing objects, Convex metadata and authorization, client upload queues, and environment-side preview processing. Deploy the matching backend and clients together before relying on durable asset references in queued messages.

## Configuration

Use the existing UploadThing server credential through the backend's configured secret. New asset uploads request private ACL; do not fall back to public-read when private ACL is unavailable. Configure `CONVEX_SITE_URL` for the Convex HTTP router. Clients receive revocable Pathway read tickets, not durable storage-provider URLs.

Preview workers run in environments explicitly granted company-scoped `assets.process`. Do not grant that permission automatically to all registered environments. The selected environment needs `ffmpeg` on its PATH. Conversions use one job at a time per company, private leased original reads, bounded file sizes, two codec threads, local-only input protocols, and a four-minute limit per conversion. Jobs use fenced ten-minute leases; stale workers cannot publish representations. The deployment must provision the processor separately from model attachment support.

Existing public attachments remain labeled legacy until an authorized private migration verifies their replacement. Do not delete historical public objects as part of initial rollout or bulk-upload historical workspace links.

## Focused verification

- Verify an uploaded object is private at the storage boundary, then open it from another signed-in device through the Pathway byte proxy.
- Verify image rendering, inline video playback and byte-range seeking. HEIC and incompatible videos must remain Preparing preview until a compatible representation exists.
- Revoke a share or remove membership and verify the next byte/range request fails. Trash and restore must not resurrect old share links.
- Disconnect during upload, reconnect and retry. The same request must reuse the asset and attachment identity.
- Confirm ordinary viewers cannot manage assets, and ungranted environments cannot claim preview jobs.
- Confirm source links remain workspace links and MCP deliverables return stable asset references.

UI evidence from the local review harness uses sample files and is not evidence of a production deployment or storage ACL configuration. Current review: https://planlink.spiritdevs.com/d/uplyayaaknnj

Environment MCP publication/list/read stays bound to the calling thread. Optional management tools additionally require company-scoped `assets.manage`; sharing also requires `assets.share`. They cannot impersonate a member, manage a standalone asset, or modify an asset used outside the current thread. Broader reuse is handled by the signed-in client with its explicit visibility confirmation. A tool's user-instruction flag never grants a backend permission.

Processing accepts a fixed set of media demuxers and excludes playlists. Image derivatives use 8-bit RGBA capped at 1536 pixels on each side, keeping even poorly compressible previews below the 10 MB image input allowance. Originals retain their full quality. Audio derivatives use AAC in an M4A container. Video uses H.264/AAC in MP4 with a JPEG poster and range-capable delivery.
