# Connected Gmail operations

Connected mail runs in the Pathway Connect relay. Convex stores workspace/member-private records and opaque encrypted credentials; environments run the selected mail model. No environment needs a Gmail refresh token.

## Configuration

The existing relay Alchemy deployment provisions `RelayMailQueue` and `RelayMailDeadLetterQueue` alongside the APNs queues. Mail remains disabled until `MAIL_ENABLED=true`; deploying source alone does not connect Google or configure UploadThing. Use the existing `infra/relay` deployment workflow after deploying the Convex schema/functions. No live deployment was performed during implementation.

| Variable                             | Purpose                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_ENABLED`                       | Defaults to `false`. Enables mail routes, queue processing and reconciliation.                                                                  |
| `MAIL_ENCRYPTION_KEY`                | Base64url encoding of 32 cryptographically random bytes; relay key-encryption key. Store in deployment secrets and retain a protected backup.   |
| `MAIL_UPLOADTHING_API_KEY`           | UploadThing REST API key for the private mail storage app. This is the API key accepted by `x-uploadthing-api-key`, not a serialized SDK token. |
| `MAIL_GOOGLE_PUBSUB_TOPIC`           | Hosted OAuth topic, `projects/PROJECT_ID/topics/TOPIC_ID`.                                                                                      |
| `MAIL_GOOGLE_PUBSUB_SERVICE_ACCOUNT` | Exact service-account email allowed to authenticate Pub/Sub push.                                                                               |
| `MAIL_GOOGLE_CLIENT_ID`              | Optional Pathway-owned Google web OAuth client ID.                                                                                              |
| `MAIL_GOOGLE_CLIENT_SECRET`          | Optional corresponding secret. Both hosted values are needed to expose hosted OAuth.                                                            |

The existing `CLERK_SECRET_KEY`, `CLERK_JWT_AUDIENCE`, `CONVEX_URL`, relay signing key and public relay origin remain required. Web mail requests use `getToken(resolveRelayClerkTokenOptions())`, the same relay JWT template used by Connect. Configure the template selected by `VITE_CLERK_JWT_TEMPLATE` to emit the audience accepted by relay `CLERK_JWT_AUDIENCE`; the separately named `convex` template is for the Convex socket. Mail routes retain the gateway's bearer-token CORS behavior.

## Google OAuth and push

1. Enable the Gmail API in the OAuth client's Google Cloud project and configure its OAuth consent screen. Create a **web application** OAuth client. Register exactly `https://YOUR_RELAY_ORIGIN/v1/mail/oauth/callback` as an authorized redirect URI.
2. For BYO mode, the mailbox owner enters that client's ID and secret in Email settings. Hosted mode uses the deployment variables. Both request `https://www.googleapis.com/auth/gmail.modify`, offline access and consent; this scope permits both message access and explicit sending. Production distribution must satisfy Google's applicable consent and restricted-scope requirements.
3. Create a Pub/Sub topic in the **same project as the OAuth client**. Grant `gmail-api-push@system.gserviceaccount.com` Pub/Sub Publisher permission on the topic. This account publishes Gmail notifications; it is distinct from the service account authenticating push delivery.
4. Create an authenticated Pub/Sub push subscription targeting `https://YOUR_RELAY_ORIGIN/v1/mail/notify`. Set the OIDC audience to that exact URL and the push service account to `MAIL_GOOGLE_PUBSUB_SERVICE_ACCOUNT`. Grant Google's Pub/Sub service agent the permissions required to mint an OIDC token for that service account. The relay verifies Google's signature, issuer, audience, service-account email and `email_verified=true` before accepting a notification.
5. BYO clients may enter their own topic name during connection. Without one, mail uses five-minute reconciliation. A single hosted topic cannot watch mail using unrelated BYO OAuth projects. When a configured watch fails, the account reports that instant delivery is unavailable and polling continues.

OAuth state is encrypted, bound to the initiating Clerk owner and company, expires after ten minutes and is consumed atomically before token exchange. An HttpOnly Secure cookie also binds the callback to the browser that made the authenticated start request; a forwarded authorization link cannot connect somebody else's Gmail to the initiating owner. Connect Gmail from the hosted Pathway web app. Desktop setup hands off to that app because the system browser does not share Electron's cookies. Browsers that block third-party cookies may reject a local development origin; use the hosted app on the same site as the relay. Mail API fetches include credentials, and the gateway echoes the request origin for credentialed mail routes only. PKCE binds the authorization code to that state. The callback displays a fixed confirmation page and does not redirect to a caller-supplied URL.

Google references: [web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push), [authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Storage and synchronization

Configure the UploadThing mail app for **private files** and permit per-request ACL overrides; the adapter explicitly requests `private` and attachment disposition. Keep this key separate from unrelated public attachment storage. Download URLs are generated only after the relay verifies active workspace membership, message ownership and the exact blob reference. URLs expire after 60 seconds; permit the requested expiry override in UploadThing settings. Raw mail and oversized body JSON are never returned through public blob URLs.

Each upload receives a stable custom ID derived from company/account, Gmail message and part identity. A cleanup candidate is registered after URL preparation and before bytes are uploaded. Successful ingestion cancels that candidate in the same Convex transaction as message publication. Uncommitted uploads become eligible for deletion after one hour. Preparing a retry refreshes that reservation; keys already claimed for cleanup cannot be reused until cleanup finishes. Message removal and disconnect schedule private-copy cleanup; reconciliation drains the bounded cleanup leases.

Backfill requests the last year (`newer_than:1y`), excludes spam/trash, and paginates in bounded deliveries. History pages process at most ten message IDs and one hundred deletions per delivery, retaining offsets and provider page tokens durably. History is published only after the page is committed. A Gmail history 404 starts a new bounded backfill from a fresh baseline, as required by [Google's synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync). Existing messages receive label changes without reuploading immutable content.

Google JSON responses are bounded to 8 MiB. Oversized message content falls back to metadata with an explicit instruction to open Gmail. Attachments above 5 MiB remain in Gmail with a download-limit label; raw messages above the configured inline processing bound are omitted. Text bodies honor MIME charset declarations. Body content above 96,000 UTF-8 bytes is placed in private JSON storage, with a bounded text excerpt in Convex.

The five-minute relay cron drives reconciliation, daily watch renewal, cleanup and recovery after missed notifications or queue failure. Queues use one message per batch, five retries and a dedicated dead-letter queue. Inspect that queue when retryable failures persist; configuration/auth errors require correcting the external service or reconnecting the mailbox. Replaying a mailbox job is safe: lease generations and provider identities fence stale and duplicate ingestion. Do not automatically replay an ambiguous outgoing send.

UploadThing references: [REST API](https://docs.uploadthing.com/api-reference/openapi-spec), [server uploads](https://docs.uploadthing.com/uploading-files), [private file access](https://docs.uploadthing.com/working-with-files).

## Sending, disconnect and key handling

Only drafts explicitly queued by their owner can be claimed for delivery. The UI wakes an independent owner-bound user-action queue job after queueing, so delivery does not wait for a backfill lease; scheduled reconciliation recovers missed wakes. Replies fetch the original RFC `Message-ID` and `References` headers rather than confusing Gmail's internal ID with an RFC identifier. A lost send acknowledgement becomes `unknown`; verify Gmail Sent before deciding whether to send another copy. Failed and unknown drafts are never silently retried.

Disconnect immediately hides/fences the account and cancels work, then purges Pathway's private copies and revokes Google authorization asynchronously. Revocation is suppressed when another active mailbox for the same owner, email and OAuth client still needs that Google grant. Accounts using different BYO clients have independent grants. Reconnecting through a different OAuth client queues the previous grant for revocation while preserving the new credentials. Original Gmail messages are not deleted by disconnect.

Credentials use a random AES-256-GCM data key per encrypted record. The data key is wrapped with `MAIL_ENCRYPTION_KEY`, using independent nonces and authenticated owner/state context. Keep the KEK outside Convex backups. Losing it makes refresh tokens and queued revocations unreadable. This implementation has one active KEK and no automated key-ring rotation: **do not replace it in place while encrypted records remain**. Reconnect/revoke accounts under the old key before changing it, or implement and validate a controlled re-encryption migration that retains the old key until every record, pending OAuth state and cleanup entry is migrated. No secret values belong in logs, docs or evidence.
