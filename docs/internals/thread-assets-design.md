# Thread assets design interview

Status: all 22 product decisions accepted. Consolidated implementation plan awaits final shared-understanding confirmation. Earlier frontier lists are interview history, resolved by the subsequent rounds.

## Confirmed needs

- Users and agents can upload files as durable conversation assets that open on other devices.
- Agent system prompts and MCP tools support delivering uploaded assets instead of unusable machine-local paths.
- Desktop/web and iOS render images and videos inline. Videos also open in the gallery/lightbox.
- Images have polished loading and reveal states; Libraries.dev Image is the visual reference.
- Thread rows display a paperclip when assets are attached.
- The thread detail panel shows an Assets section when files exist.
- Settings includes asset/file management.

## Observed starting point

The existing issue attachment implementation uses UploadThing for bytes and Convex for metadata, permissions and lifecycle. Issue uploads currently use public-read URLs, so copying a URL grants access to its bytes. This existing behavior is not a privacy decision for the proposed thread assets.

A machine-local MP4 markdown link failed on both iOS and a remote desktop. A separate HTTPS review page worked around delivery; it did not repair native asset delivery.

## Open design frontier

1. Asset ownership and visibility, including conversation-only threads and cross-thread reuse.
2. Whether copied asset links require authentication or intentionally allow access to anyone with the link.
3. When agents upload automatically versus only on explicit instruction, and handling ordinary source-file references.
4. Scope of managed file types and Settings management.
5. Media loading, autoplay and gallery behavior, including performance and Reduce Motion.

Record resolved terminology in the existing domain glossary, and create an ADR only after a consequential trade-off is settled. No implementation or migration is approved by this draft.

## Round 1 decisions — accepted

- Assets belong to a company and can be attached to threads, including projectless conversations. Access follows the thread’s permissions.
- Assets are private by default. Public access requires an explicit Create share link action.
- Agents automatically upload deliverables such as recordings, images, PDFs and exports. Ordinary source references remain file links.
- Settings has one searchable Assets library across Pathway uploads, displaying size, owner and usage. Ordinary workspace files are excluded.
- Images use a brief first-load reveal, a static Reduce Motion placeholder and no animation replay while scrolling. Videos use posters and explicit Play, support gallery/fullscreen, and do not autoplay.

## Further source findings

Cloud-queued message attachments currently use Convex storage; accepted environment attachments use disk storage. Existing UploadThing task attachments are public by URL. Unifying these requires an explicit migration and compatibility decision. Web/desktop already have media player/lightbox components; iOS needs video playback support. MCP lacks a general thread asset publication tool, and provider attachment instructions currently describe incoming files rather than outgoing deliverables.

## Round 2 frontier

- Permissions when reusing an asset in another context.
- Detachment, deletion and retention behavior.
- Share-link lifetime and revocation.
- Upload failure and offline delivery behavior.
- Existing uploads and historical local-file links.
- Supported file scope and upload/storage limits.

## Round 2 decisions — accepted

- Reuse is allowed. Explicit confirmation is required when attaching an asset broadens access; agents cannot silently broaden visibility.
- Remove from thread detaches a reference. Delete asset shows affected locations and moves the asset to Trash for 30 days; messages retain an Asset deleted placeholder.
- Public share links expire after seven days by default, support selectable expiry and immediate revocation, and require external-sharing permission.
- Failed/offline uploads preserve local files and expose Upload pending with retry. Agents must distinguish pending local output from remotely available assets.
- No bulk upload of historical local-file references. Offer Make available across devices for accessible files. Index existing cloud attachments and identify legacy public links until migrated.
- General file uploads are supported as download cards. Safe previews cover supported images, videos, audio, PDFs and text; uploaded content is never executed. Size and company-storage limits are configurable.

## Round 3 frontier

- Who can manage assets versus view or attach them.
- Exact inline presentation and gallery scope.
- Original-file preservation and compatible preview/provider representations.
- MCP operations and authority for externally sharing or deleting assets.
- Assets library controls and folders.
- Retention when a containing thread/task is deleted.

## Round 3 decisions — accepted

- Viewers preview/download; uploaders manage their own assets within their permissions; company admins manage all. External sharing has a separate permission.
- Thread galleries contain images/videos in message order with thumbnails and previous/next navigation. Audio has an inline player; PDFs and other files use compact preview/download cards. Videos pause offscreen or when leaving the gallery.
- Preserve originals for download. Generate compatible preview and provider representations as needed, including HEIC to JPEG/PNG and browser-compatible video, without silently degrading originals.
- MCP supports automatic upload/attachment of requested deliverables and authorized listing/reading. Public sharing, access broadening and deletion require explicit user instruction. Return stable asset references, upload state and preview metadata rather than machine-local paths.
- Settings includes search, type/uploader/date filters, storage usage, upload, rename, download, usage locations, sharing, Trash, sorting and bulk actions. Folders are deferred.
- Deleting a containing thread, including temporary threads, moves otherwise unreferenced assets to 30-day Trash. Reused assets survive. Keep in Assets retains a file independently of its thread.

## Round 4 frontier

- Trash visibility, share revocation and restoration.
- File replacement/version identity.
- Upload/processing states and delivery completion.
- Default quotas and limit handling.
- Where standalone library uploads derive their visibility.

## Round 4 decisions — accepted

- Trash immediately revokes share links and limits access to authorized Trash managers. Restore does not revive old share links, and reconnects attachments where their containing context still exists.
- Replacement creates a new asset. Existing messages retain their original file; rename only changes the display name.
- Uploading and Preparing preview are distinct states. Original download is available after upload verification; playback requires a ready compatible representation. Agents report the actual delivery state.
- Standalone Settings uploads are visible to their uploader and company admins initially. Attaching them grants the destination readers access, with confirmation when visibility expands.
- Initial configurable limits are 250 MB per file and 10 GB per company, subject to storage-provider validation. Usage and errors are visible; quota pressure never silently deletes files. Provider input limits remain separate.

All product questions in rounds 1–4 are resolved. See [implementation plan](thread-assets-implementation-plan.md).
