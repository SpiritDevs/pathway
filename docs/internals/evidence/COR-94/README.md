# COR-94: orchestrator attachments review evidence

Branch: `fix/orchestrator-attachments`. Base: `a26f42e0ed026f60fd816a729a8279ab21f70845`.
Captured 14 September 2026. Local development only; no merge or production deployment. PR preparation includes the before screenshot and interaction recording below.

## Implemented

- Shared web composer (full conversation and floating companion, also used by Electron): image paste, file selection, drop, previews/removal, upload progress and retry, attachment-only sends, and draft continuity between views.
- Shared constraints: eight attachments, images up to 10 MiB, files up to 50 MiB. Pending browser drafts retain bytes for retry during the current session.
- Cloud storage preparation/finalization, transactional message binding, idempotent sends, persisted metadata, authenticated downloads, and pending-upload expiry.
- Downloads recheck membership and history visibility. Runtime downloads require a current authorized job claim and its bounded conversation context. Attachment contents cannot grant capabilities.
- Runtime retrieves bytes, gives Codex image inputs and provides bounded text context, including recent follow-up attachments. Unsupported binary formats and image inputs on other providers are explicitly identified as unreadable by that reasoning provider. Raw files are not automatically copied to delegated workers.
- Native Swift compose uses existing attachment chips and pasted-image loader, Photos/files/paste controls, retry/removal, send persistence, image preview and authenticated save/share. Native implementation is not yet build-verified.

## Tested

**130 tests across eight focused files passed**, including existing normal-thread upload, paste and cloud-queue regressions:

```sh
node_modules/.bin/vp test run \
  packages/backend/src/aiOrchestrators.test.ts \
  apps/web/src/components/orchestrator/conversationAttachmentDrafts.test.ts \
  apps/server/src/cloud/orchestratorAttachments.test.ts \
  apps/server/src/cloud/orchestrator.test.ts \
  apps/server/src/cloud/threadQueueWorker.test.ts \
  apps/server/src/assets/AttachmentUpload.test.ts \
  apps/web/src/components/chat/composerAttachmentFiles.test.ts \
  apps/web/src/cloud/threadQueueDelivery.test.tsx
```

Web (`@spiritdevs/web`), backend (`@spiritdevs/backend`) and server (`@spiritdevs/pathway`) package `tsgo --noEmit` checks passed. Targeted formatting/lint and `git diff --check` passed. Three modified Swift files passed `swiftc -frontend -parse` (syntax only).

Real Chromium used the implemented composer/message components and upload hook against a fresh, isolated local Convex backend and actual storage. The review harness supplied an explicit local test identity; it did not bypass product authorization in committed code. Verified system-clipboard PNG paste, file input selection, successful storage upload, full/floating draft continuity, send, rendered image/file, downloaded exact original bytes, unauthenticated HTTP 403, and persistence from a new browser context. A second pass injected a failed upload and verified retry with retained bytes, removal, count-limit rejection, drag/drop and attachment-only send. Both interaction passes had no page errors. The reload pass had a missing favicon request and successfully retrieved persisted messages.

Backend tests additionally exercise revoked membership, history boundaries, invalid/stale runtime claims, foreign attachment IDs, unfinished uploads, metadata mismatch, expiry, duplicate sends, and authenticated runtime HTTP retrieval. Runtime tests exercise provider image support, bounded text and incomplete-byte rejection.

## Screenshots for Corey

Screenshots use the local fixture. The before image captures the unmodified composer from main; the other images show the implementation. Queued status is intentional: no live provider worker ran.

- [Original main composer before attachment support](before-compose.png)
- [Recorded paste, upload, floating/full-view switch, send and download](attachment-flow.webm)
- [Image and file selected in the compose bar](compose-image-file.png)
- [Floating companion retains the selected attachments](floating-image-file.png)
- [Sent message renders the image and downloadable file](sent-image-file.png)
- [Upload error with retry and removal](upload-retry.png)
- [Narrow browser conversation](narrow-conversation.png)
- [Persisted attachments in a new browser context](reloaded.png)

## Unverified and platform limits

- Full signed-in web/Electron integration: this environment had production Clerk configuration but no documented development test credentials. Local component/backend integration was exercised instead.
- iOS/native build and simulator: blocked by an unaccepted Xcode license. Native source is syntax-checked only; Photos, native paste, file importer, preview and ShareLink still need device/simulator validation. Native upload state uses the existing indeterminate attachment-chip pattern.
- Android: no Android orchestrator compose implementation is present in this checkout.
- Live model reasoning, delegated execution, remote/relay/tunnel networking and production storage/CORS were not exercised. Downloads use authenticated cloud endpoints, without hard-coded local origins.
- Normal agent thread regression tests passed; no additional signed-in normal-thread browser session was run.
- PDFs, archives and other binary formats are stored and downloadable but are not parsed by the content-only reasoning path. Only Codex currently supports its image-input path. Browser clipboard availability follows existing platform support.
