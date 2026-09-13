# Pathway assets implementation plan

Status: approved for implementation, including subagents and screenshot/video verification with PlanLink evidence.

## Outcome

A user asks an agent for a review video. The agent uploads the recording through Pathway MCP and attaches the returned asset reference to its response. The same inline player opens on iOS, web and a remote desktop, even after the originating environment disconnects. The thread has a paperclip indicator and an Assets section. Authorized users can find and manage the file in Settings → Assets.

## Domain and permissions

Company-owned assets have stable IDs independent of their attachment references. Attachments associate assets with messages, threads, tasks or another supported context, including projectless conversations. Access follows a currently authorized attachment context; company membership alone is not sufficient. Standalone library uploads are initially visible to the uploader and company admins. Agents inherit the acting user's scope.

Viewers preview/download. Uploaders manage their assets within their permissions; company admins manage all. External sharing is a separate permission. Reuse that broadens visibility requires explicit confirmation. Show usage locations only where the caller can see their context; do not leak private thread titles through the library.

Asset originals are immutable. Rename changes a display name; replacement creates a new asset. A Keep in Assets marker retains a file independently of its attachments.

## Storage and delivery

Use private UploadThing storage for new originals and derived representations, with Convex owning identity, authorization, lifecycle, quota reservations and attachment references. Do not expose storage credentials or persist signed download URLs as message identity. Existing task UploadThing uploads, cloud queue Convex blobs and environment disk attachments need adapters during migration.

Reserve quota before upload, verify the stored bytes before completing it, and release failed/expired reservations. Retry finalization and attachment binding idempotently so reconnects do not create duplicate files or messages. Default limits: 250 MB per file, 10 GB per company; administrators configure supported values. Provider input limits are independently checked. Track original and derivative storage so the quota is enforceable.

Delivery states distinguish pending/uploading, verified original, preparing preview, ready, failed, trashed and purged. Failed uploads retain available local originals and offer retry. Downloads become available after original verification; previews become available only when ready. Preparation failure must not make an already uploaded original disappear.

External share links are Pathway-managed grants, seven days by default, with configurable expiry and revocation. Keep underlying objects private. Authorization must also govern media byte-range requests; do not implement revocation by merely redirecting to a long-lived bearer URL. Revocation denies new requests immediately; already downloaded bytes cannot be recalled. Keep private media out of public caches.

Verify the deployed UploadThing app supports private ACL configuration and intended file limits before release. Official documentation confirms private ACLs and short-lived signed access, but this is not evidence of the current deployment configuration:
- https://docs.uploadthing.com/concepts/regions-acl
- https://docs.uploadthing.com/file-routes
- https://docs.uploadthing.com/api-reference/ut-api

## Representations and media

Preserve original uploads. Generate thumbnails/posters and compatible preview/provider representations as required: HEIC to JPEG/PNG, browser-compatible video where originals are not playable, and bounded provider inputs. Verify actual file formats rather than trusting extensions. Uploaded HTML/scripts/executables are downloads, never executable app content. Isolate document previews.

Keep processing outside request handlers and the SwiftUI main thread. Resume recoverable work; display separate preparation errors and retry. Reuse existing web media/lightbox components and native image normalization where applicable; add native iOS video playback. Do not make successful viewing depend on the originating machine remaining online.

Images reserve their layout space and show a brief first-load reveal inspired by https://libraries.dev/image. Reduce Motion uses a static placeholder. Do not replay effects while scrolling, animate offscreen items, or add a continuous WebGL effect to every transcript image. Videos show posters with explicit Play, never autoplay, and pause offscreen or on gallery exit. Audio has an inline player. PDFs/text/other files use compact preview/download cards.

## Chat UI

Both user and assistant messages render typed asset references. Keep ordinary code references as workspace-file links. Support upload progress, pending and preparation states, retry, missing/deleted placeholders, and download errors without hiding the rest of the message.

Show a small paperclip on thread rows when attachments exist. Show Assets in the thread detail panel only when nonempty. Thread galleries contain images/videos in message order, with thumbnails and previous/next navigation. Preserve keyboard, screen-reader and touch access; load lists/previews lazily. Desktop/web and iOS follow the same state contract.

Settings → Assets includes search, type/uploader/date filters, sorting, storage usage, upload, rename, download, usage locations, sharing, bulk actions and Trash. No folders in the first implementation. Actions distinguish Remove from thread from Delete asset and display affected usage before deletion.

## MCP and provider instructions

Expose bounded operations for upload/publication, attach, list/search, metadata/read/download, rename, detach, Trash/restore, share/revoke and status/retry. Final tool names follow the existing toolkit conventions. Tool results include stable asset identity, media metadata, delivery state and a renderable attachment reference. Paginate lists and avoid returning media bytes through MCP unless requested and appropriate for the provider.

Upload accepts authorized environment-local files and streams their bytes; never treats a remote client's filesystem path as the file. Publication binds evidence to the current thread/message without fabricating an assistant message or exposing a public URL. Make binding idempotent across tool retries. Provider adapters receive compatible inputs or explicit unsupported-type information, never silent image omission.

System/developer instructions across Codex, Claude, Cursor, Grok and OpenCode tell agents to upload requested deliverables, attach the resulting asset reference, and distinguish local generation from verified upload and playable preview. Ordinary source references remain links. Explicit instruction is required for public sharing, broader access or deletion; existing authorization in the conversation counts and must not trigger repeated permission questions.

## Lifecycle and migration

Detaching one usage preserves other usages. Deleting an asset moves it to 30-day Trash, revokes shares, restricts reads to Trash managers and leaves history placeholders. Restore reconnects surviving contexts without reviving shares. Deleting a containing thread/task trashes assets with no other usage or Keep in Assets marker. Preserve reused assets. Purge after retention with retryable cleanup of originals and derivatives.

Index existing cloud attachments with their existing visibility clearly represented. Legacy public URLs stay labeled public until verified private migration. Do not silently break existing shared links or claim historical exposure has been undone. Offer Make available across devices for accessible local files; never bulk-upload old workspace references. Missing local files get a clear unavailable state.

## Implementation order

1. Asset contracts, metadata, private byte storage, permissions, quota reservations and lifecycle, with focused authorization/concurrency tests.
2. Upload and processing pipeline, private read/range delivery, adapters for existing storage, and migration inventory.
3. MCP publication and provider instructions, including output attachment binding and provider-compatible inputs.
4. Shared desktop/web chat rendering, gallery, paperclip and Assets panel; native iOS equivalents.
5. Settings library, sharing, Trash/restore, cross-context reuse and migration controls.
6. Integrated remote-device review, staged deployment, and client distribution once approved. Cloud, environment and client compatibility must be explicit; a TestFlight upload alone cannot deploy server behavior.

## Acceptance evidence

- An agent-created video opens inline and in the gallery on a different machine and on iOS after the originating environment disconnects.
- User uploads and agent uploads use the same durable identity and permission checks.
- Unauthorized users cannot fetch originals, previews or ranges or enumerate private usage.
- Share expiry/revocation and Trash block new reads; restore never revives revoked links.
- Concurrent uploads cannot exceed quota; retries cannot duplicate attachment bindings.
- Deleting one context preserves reused/retained assets and does not silently rewrite message history.
- HEIC previews are compatible, unsupported video prepares a playable representation, and originals remain downloadable.
- Loading, failures, Reduce Motion, long threads and offscreen video behavior are tested with focused performance checks.
- UI review includes recordings on iPhone, iPad and remote desktop/web using sample data, with explicit authorization before starting UI/browser automation.

No public release, deployment, destructive migration or new TestFlight upload is included in confirmation of this design alone.
