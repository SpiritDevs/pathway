# Connected mail

Connected Gmail is separate from SMTP capture. The relay owns OAuth credentials, Gmail synchronization and outbound delivery. Convex owns private mailbox records and leased work. Web, desktop and native Apple clients use authenticated owner queries. Selected environments perform model analysis through their provider instances.

Mailbox rows carry a company ID and owner membership. General company feeds contain no mail bodies, credentials or sender knowledge. Company membership is necessary but insufficient to read a mailbox. The current owner's membership must match. Shared contacts retain their existing directory permissions; saving a sender copies only the explicit contact fields.

## Ingestion

`infra/relay/src/mail` implements OAuth, Gmail transport, private UploadThing storage, the queue consumer and HTTP endpoints. The OAuth credential-source seam accepts BYO web clients and an operator-configured hosted client. Short-lived, single-use OAuth state binds the initiating owner and workspace to the PKCE exchange. An HttpOnly cookie additionally binds the callback to the browser that started authorization. Desktop and native clients hand connection setup to the signed-in hosted web app. The relay stores encrypted refresh credentials, never client-visible tokens.

Authenticated Pub/Sub notifications enqueue mailbox identities. One renewable account lease serializes synchronization. Backfill is paginated, and Gmail history cursors advance only after all writes for the current page have committed. Expired history starts a new bounded backfill. Periodic reconciliation covers lost notifications and unavailable watches.

Message list metadata is separate from bodies. Large content, attachments and raw EML use private storage with owner-authorized short-lived access. Cleanup jobs retain the information needed to remove abandoned or disconnected assets. Disconnect invalidates active leases before cleanup; reconnect uses a fresh account identity after a disconnect.

Gmail JSON responses are bounded to 8 MiB and individual copied attachments to 5 MiB. Oversized responses fall back to metadata; omitted content is marked for the reader. Bodies over 96,000 UTF-8 bytes use private JSON storage with an inline excerpt. Analysis receives only bounded inline text and an incomplete-content flag, never attachments or a storage credential.

## Analysis

`apps/server/src/cloud/mailBrain.ts` follows the linked environment company supervisor and existing service-token authentication. It runs one model invocation at a time across the environment's workspaces. A job carries an explicit model selection, selected from the primary or backup environment's local provider instances.

Claims are renewable and generation-fenced. The environment checks its claim before inference and renews while the provider runs. Losing renewal interrupts the invocation. Convex rejects stale completions and checks the message classification revision, so a late result cannot undo a manual correction. A backup completing its current claim is not displaced merely because the primary returns.

Mail uses a temporary working directory and content-only generation. Codex disables configured MCP servers, shell tools, apps, plugins, hooks, browsing and subagents for this invocation. Claude disables tools and MCP configuration. OpenCode uses its existing deny-all session permissions. Cursor and Grok reject content-only work because their current adapters cannot enforce that restriction. Ordinary provider operations retain their existing behavior.

The model response is schema-validated and bounded. Priority messages require a briefing. Noise results discard briefings. Reply drafts use the original sender as their initial recipient, and require a user Send action. Raw provider errors are not stored in mailbox records because they can contain message text or local paths.

## Delivery

User Send creates a durable outbound operation. Relay wake requests make processing prompt; reconciliation remains a fallback. The worker fetches original RFC headers when constructing a reply so Gmail receives both its thread ID and reply headers.

An uncertain Gmail send is recorded as unknown and is not automatically retried. This trades automatic recovery for preventing duplicate outbound messages. Definite rejected sends can be corrected and submitted again. Read-state changes use separate idempotent label operations.

## Validation boundaries

Use focused Convex tests for ownership, intake identity, claim fencing, corrections, cleanup and outbox transitions; relay fixtures for OAuth, history recovery, storage and MIME; environment tests for inference cancellation and result validation; and client tests for navigation and safe rendering.

Fixture tests do not prove Google consent, Pub/Sub IAM, storage credentials or deployed delivery. Configure and deploy the services using `docs/operations/connected-mail.md` before testing a real mailbox. Browser and simulator checks are separate evidence and must be reported separately.
