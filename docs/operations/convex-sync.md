# Convex synchronization operations

> For maintainers. Using Pathway? See [docs/user](../user/).

This runbook operates the Convex-backed company and issue sync path. Protocol and replica behavior
live in [cloud-sync.md](../internals/cloud-sync.md); this page covers deployment, credentials,
retention, recovery, and incidents.

The standing rollout is a **clean cutover**. It creates or selects an empty Convex-backed company and
does not copy data from the old environment-local SQLite tracker. Import functions exist for an
explicit recovery decision, but import is not a normal deployment step.

## Deployment configuration

Cloud sync is required for online Pathway deployments. Configure each process for the same Convex
deployment; similar names are deliberately not interchangeable.

| Owner             | Configuration                                                     | Purpose                                                                                                    |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Convex deployment | `CLERK_JWT_ISSUER_DOMAIN`                                         | Clerk issuer used for member JWTs. The Clerk JWT template's application id is `convex`.                    |
| Convex deployment | `PATHWAY_RELAY_JWT_ISSUER`                                        | Relay origin accepted as the environment-service JWT issuer.                                               |
| Convex deployment | `PATHWAY_RELAY_JWKS_URL`                                          | Relay ES256 public keys, normally `https://<relay>/.well-known/jwks.json`.                                 |
| Convex deployment | `UPLOADTHING_TOKEN`                                               | UploadThing API token used to prepare uploads and delete abandoned objects.                                |
| Relay Worker      | `CONVEX_URL`                                                      | Convex client URL ending in `.convex.cloud`; this is not an HTTP Actions URL or deploy key.                |
| Relay Worker      | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_AUDIENCE` | Clerk configuration for the relay.                                                                         |
| Web build         | `VITE_PATHWAY_CONVEX_URL`                                         | Convex client URL used by the browser.                                                                     |
| Web build         | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_JWT_TEMPLATE`           | Clerk client and the JWT template used to authenticate to Convex.                                          |
| Mobile build      | `PATHWAY_CONVEX_URL`                                              | Convex client URL embedded in Expo public config for onboarding workspace provisioning.                    |
| Pathway server    | `PATHWAY_CLOUD_SYNC_COMPANY_ID`                                   | Company replicated by this environment. This is still explicit configuration, not derived from link state. |
| Pathway server    | `PATHWAY_CONVEX_URL`                                              | Runtime Convex URL. It overrides the `PATHWAY_CONVEX_URL` embedded when the server bundle was built.       |

The relay and server use `PATHWAY_*`/unprefixed names because they run outside the browser. The web
bundle uses the `VITE_*` names. Repository release tooling maps the shared public configuration into
the web names; do not put a server or provider secret in a `VITE_*` variable.

Once the server is linked and its company environment registration is active, it automatically
publishes every active local project to Convex. The company-owned cloud project carries the shared
name; its environment binding carries this machine's environment id, local project id, and workspace
root. Project creates and metadata changes publish immediately, startup and periodic reconciliation
repair missed publications, and deleting a local project revokes only that machine's binding. The
environment registration separately supplies the computer label, platform, capabilities, relay
reachability, and managed endpoint used to control work on that machine.

### Development and production deployments

The backend package owns the Convex project and exposes `dev`, `codegen`, `test`, and `typecheck`
scripts. It has no repository wrapper named `deploy` or `smoke:seed`.

After setting the target development deployment's environment values, push once from the repository
root:

```sh
pnpm --filter @spiritdevs/backend exec convex dev --once
```

For production, configure `CONVEX_DEPLOY_KEY` in the operator or CI environment and deploy from the
same package:

```sh
pnpm --filter @spiritdevs/backend exec convex deploy
```

Treat the development and production Convex environments as separate configuration sets. A function
deploy does not copy environment values between them. Confirm the target before running any admin or
smoke function.

### Smoke seed and verification

The internal functions `smoke:seed`, `smoke:inspect`, and `smoke:cleanup` live in
`packages/backend/convex/smoke.ts`; they are not package scripts. The server harness invokes them with
`npx convex run` from `packages/backend` and pins every call with
`PATHWAY_CONVEX_SMOKE_DEPLOYMENT`/`CONVEX_DEPLOYMENT`.

Use the complete command, safeguards, and cleanup contract in
[cloud-sync-smoke.md](../internals/cloud-sync-smoke.md). The minimum invocation is:

```sh
PATHWAY_CONVEX_SMOKE=1 \
CONVEX_URL=https://<deployment>.convex.cloud \
PATHWAY_CONVEX_SMOKE_DEPLOYMENT=dev:<deployment> \
vp run --filter @spiritdevs/pathway test src/cloud/convexSyncSmoke.integration.test.ts
```

The smoke company is reserved test data, not a production-company seeder. Its cleanup deletes and
never restores. The harness refuses to mutate when the deployment slug and `CONVEX_URL` disagree.

## Relay issuer setup

The Worker is in `infra/relay`, production is `https://relay.spiritdevs.com`, and the retained local
production configuration path is `infra/relay/.env.prod.local`. Mention that path in handoffs; never
paste its values into logs, tickets, or documentation.

The relay uses Alchemy, not Wrangler. Its package scripts are `deploy` and `destroy`; there is no
Wrangler configuration and no dedicated rollback command.

The relay API Worker requires the Cloudflare Workers **Standard** usage model. Newly upgraded
accounts may already use Standard and omit the per-Worker usage-model selector; the API Worker's
**Settings** page exposes **CPU Limits** when Standard limits are available. Older Workers that
still show a usage-model selector must be migrated to Standard once after upgrading. Alchemy deploys
a 100 ms per-invocation CPU cap for the API Worker, keeping Clerk verification and challenge signing
available without inheriting the paid plan's much larger default limit.

For a new Convex/relay pair, bootstrap the circular trust relationship in this order:

1. Create the Convex deployment, set `CLERK_JWT_ISSUER_DOMAIN`, and record its client URL.
2. Deploy the Worker with `CONVEX_URL` pointing to that deployment. The JWKS endpoint has no Convex
   persistence dependency and can come up first.
3. Verify `https://<relay-origin>/.well-known/jwks.json` returns the expected P-256 public key.
4. Set `PATHWAY_RELAY_JWT_ISSUER=https://<relay-origin>` and
   `PATHWAY_RELAY_JWKS_URL=https://<relay-origin>/.well-known/jwks.json` in Convex.
5. Deploy the Convex functions. `auth.config.ts` refuses codegen/deployment while either relay value
   is absent.

Deploy the retained production stage from the repository root with:

```sh
vp run --filter pathway-relay deploy --stage prod --env-file .env.prod.local
```

The production GitHub workflow runs the equivalent stage with `--yes --github-output` on pushes to
`main`. Personal stages default to `dev_$USER` and can select another file with `--env-file`.

Rollback means checking out the last known-good relay revision and redeploying the same `prod` stage
with the same environment file. `vp run --filter pathway-relay destroy` tears down a stack; it is not
a rollback and must not be used during an incident.

The relay mints `aud=pathway-convex` ES256 environment-service tokens. Convex trusts the issuer and
JWKS URL, then resolves company registration and permissions from its own tables. The Worker never
receives `CONVEX_DEPLOY_KEY`.

## UploadThing attachments

Normal issue attachments store metadata in Convex and bytes in UploadThing. They do **not** use
Convex file storage. Set `UPLOADTHING_TOKEN` in each Convex deployment environment; never expose it to
the web bundle or store it in a company vault.

The lifecycle is:

1. `issueAttachments.prepareUpload` checks membership and `comments.create`, creates a pending row,
   and calls UploadThing `prepareUpload` for a public-read URL.
2. The browser uploads bytes directly.
3. `issueAttachments.finalizeUpload` downloads the public object, verifies byte size, MIME type, and
   SHA-256, and marks the row ready.
4. A comment may reference only ready attachments belonging to the actor and issue.

Without `UPLOADTHING_TOKEN`, new prepares fail with `uploadthing-unconfigured`; replacement-key and
garbage-collection deletes fail for the same reason. Finalization of an already prepared public-read
key currently performs an unauthenticated GET, so it may still verify, but the supported end-to-end
prepare/finalize lifecycle is unavailable and abandoned objects cannot be cleaned up.

Pending rows expire after one hour. `packages/backend/convex/crons.ts` runs
`internal.issueAttachments.gcPending` hourly at minute 17 UTC, up to 100 rows per pass. Inspect failed
cron runs after rotating the token; a failed UploadThing deletion leaves cleanup incomplete.

Before treating a new live-key deployment as attachment-ready, run the two provider-specific checks
left by the C10 implementation:

- Prepare a key but never upload bytes, let it expire, and confirm UploadThing `deleteFiles` accepts
  that prepared-only key and the pending metadata is removed.
- Finalize a representative maximum-size video while watching Convex action memory. Finalization
  currently materializes the complete response with `arrayBuffer()` before hashing, so unit tests do
  not prove the live action's memory headroom.

These are release checks, not claims already proven by the hermetic test suite.

The optional legacy import executor is a compatibility exception: its attachment RPCs still use
Convex `_storage`. Clean cutover does not invoke that executor, and all newly created attachment bytes
use UploadThing.

## Resend invitation delivery

Resend is reserved by the plan but is **not wired in the current repository**. There is no
`RESEND_API_KEY` consumer or deployment variable to set. Do not invent one in production
configuration.

`packages/backend/convex/invitations.ts` installs a refusing default mailer. Creating an invitation
writes the pending invitation, then returns `invitation-delivery-failed` with the underlying
`invitation-delivery-unconfigured` reason. The pending row remains visible and resendable. A resend
rotates the secret token, extends expiry, increments the delivery attempt, and uses
`company-invite/<invite-id>/<delivery-attempt>` as its intended Resend idempotency key; it is also
rate-limited to one attempt per minute. Until a real mailer module is installed, resend fails at the
same delivery seam.

Operational consequence: company invitation email is unavailable. Operators must not report an
invitation as emailed merely because its Convex record exists.

## Secret rotation

Rotate one class at a time and verify its narrowest live path before proceeding.

### Clerk

- `CLERK_SECRET_KEY` is a relay Worker secret. Rotate it in Clerk, replace the production GitHub
  environment secret and `infra/relay/.env.prod.local`, redeploy the relay, then verify Clerk-backed
  relay requests. The blast radius is member authentication at the relay; Convex member JWT
  validation is independent while the issuer remains unchanged.
- `CLERK_PUBLISHABLE_KEY` and the JWT issuer/template settings are public configuration but still
  deployment-coupled. Moving to another Clerk instance changes the issuer: update relay config,
  `CLERK_JWT_ISSUER_DOMAIN` in Convex, and web/server build configuration as one coordinated change.
  Existing sign-ins may need to authenticate again.

### Convex deploy key

`CONVEX_DEPLOY_KEY` is an operator/CI credential used by the Convex CLI. Rotate it in Convex and
replace the CI or operator secret before the next `convex deploy`. It is not a Worker runtime secret,
so rotation does not interrupt an already deployed relay or sync clients; stale automation loses the
ability to deploy.

### Relay signing keys

Alchemy provisions the relay's P-256 `ConvexRelaySigningKey`; the Worker publishes configured public
verification keys from `/.well-known/jwks.json` with five-minute cache and stale-while-revalidate
headers. Relay service tokens live for 10 minutes and control-plane tokens for 2 minutes.

The current Worker configuration publishes only the current key. It has no operator setting for a
dual-key overlap. Do not rotate or replace that resource as a casual redeploy. A safe zero-downtime
rotation first requires a code/config change that publishes old and new public keys together, then
switches signing, waits out caches and token TTLs, and finally removes the old key. Without that
overlap, environment sync and relay persistence can fail authorization across the deployment.

### UploadThing

Rotate `UPLOADTHING_TOKEN` at UploadThing and update the Convex deployment environment immediately.
Then run a prepare/finalize/delete check and inspect the next `gcPending` run. The blast radius is new
attachment preparation and provider deletion; already returned public-read URLs remain readable,
and an already prepared key may still finalize through the public GET path.

### Environment link material

`CLOUD_LINKED_USER_ID` (`cloud-linked-user-id`) is an identifier held in the Pathway server secret
store, not a provider API key. The same store holds the relay URL, issuer, DPoP-bound environment
credential, and related link material as mode-`0600` `.bin` resources below the server's secrets
directory. Do not hand-edit them.

Use the supported flow:

```sh
pathway connect unlink
pathway connect link
```

Unlink removes the linked user and active relay credential locally and attempts to revoke the relay
environment record. Relink mints a new credential; the sync daemon re-reads it for every exchange.
The environment signing key pair is retained by unlink and reused. The blast radius is one Pathway
environment: its server sync daemon stops until the link is restored. Use `pathway connect logout`
only when the stored CLI authorization must also be removed.

## Feed retention and replica reseeding

`syncChanges` and `syncOperationReceipts` receive a `retainUntil` timestamp 90 days after creation and
are indexed by it. `syncOperationDecisions` is the permanent compact dedupe ledger and has no
retention column; any future pruning job must leave it intact.

Important current limitation: the only scheduled Convex cron is the hourly pending-attachment GC.
There is no change-feed or receipt pruning function wired today. Therefore the 90-day value is the
retention target encoded on rows, not an active deletion guarantee. Operators should monitor
`syncChanges` and `syncOperationReceipts` growth in the Convex dashboard and must not manually delete
feed rows without a reviewed prune procedure.

When rows are eventually pruned, `sync.listChanges` compares the client's cursor with the oldest
surviving company version. A gap returns `CursorExpired`; the client discards reproducible confirmed
state, bootstraps again, and rebases its durable outbox. Never prune
`syncOperationDecisions`, because an old retry must still resolve to its original accepted or
rejected decision.

`SYNC_BOOTSTRAP_GENERATION` is currently **4** in
`packages/client-runtime/src/sync/document.ts`. Bump it only when a complete bootstrap now contains
state that an older completed replica could have missed. On the first startup/connect with the new
build, every generation-mismatched replica discards only confirmed reproducible state and performs a
full seed; pending outbox operations survive and are sent after the seed. This is a fleet-wide read
load event as upgraded replicas reconnect, so coordinate a bump with backend capacity and release
timing.

## Optional import recovery

The clean-cutover deployment plan does not import old SQLite data. Use the import path only after an
explicit decision that preserving one legacy environment outweighs the operational risk.

The recovery surface is Settings → Issues → Migration. It previews local rows, projects, attachments,
key-prefix conflicts, and preflight failures before execution. Starting a run requires a signed-in
member with `company.manage`, an active source environment registration, and a target company with
no issue data or workflow edits. The untouched default workflow seeded during company creation is
safe to replace and does not block import. Only one `created` or `applying` run may exist for a
company.

The Convex API is in `packages/backend/convex/issueImport.ts`:

- `issueImport.start`, `get`, and `list` manage run identity and visibility;
- `applyEntities`, `applyProjects`, and `applyTrackerConfig` apply deterministic batches;
- `generateAttachmentUploadUrl` and `finalizeAttachment` support the legacy Convex-storage attachment
  compatibility path;
- `complete` verifies expected counts, tracker configuration, and finalized attachments; and
- `abandon` closes a live run.

The environment executor uses a deterministic run id and resumes an existing live run. If execution
stops, fix the underlying failure and resume the same run rather than starting another. Missing local
attachment files must be resolved before applying.

`abandon` is **not rollback**. It marks the run abandoned but does not remove entities already
applied. A partially applied abandoned target is no longer empty and cannot accept another
empty-company import. Preserve evidence and decide on a reviewed cleanup or a fresh company instead
of deleting rows ad hoc.

## Incident diagnostics

Start with the user-visible state, then move inward.

### Client status and recovery records

- The header sync dot shows the active company's phase, pending count, and last classified error.
- Settings → Company → Sync shows bootstrap completion, pending outbox count and operation kinds,
  blocked count, rejected count, quarantine count, and the last transport error.
- `Update required` means the backend rejected this protocol/build, or an old issue client reached a
  replica-routed company. Old clients receive “This workspace has moved to cloud sync. Update the app
  to continue.” They must upgrade; falling back to environment-local issue RPCs is intentionally
  blocked.
- A rejected operation was decoded and refused by Convex. Its envelope and reason remain in the
  local `rejected` store. A quarantined operation could not be decoded by this build; quarantine is a
  move out of the replayable outbox, not deletion, so the original bytes and reason remain available.

The current Settings surface is a summary, not the full rejected-operation edit/retry/discard panel
described by the original plan. Do not tell a user that detailed self-service recovery exists. During
an incident, preserve the local store before attempting cleanup or upgrading.

Web/Electron replicas use IndexedDB databases named
`pathway:cloud-sync/<scope>/<companyId>` with `entities`, `outbox`, `rejected`, `quarantine`, and
`meta` object stores. The Pathway server uses `cloud_sync_checkpoints`, `cloud_sync_entities`,
`cloud_sync_outbox`, `cloud_sync_rejected`, `cloud_sync_quarantine`, and
`cloud_sync_local_sequences` in its SQLite state database. Inspect live state read-only; for extended
analysis, snapshot the database rather than opening the live Pathway home read-write.

### Convex dashboard

For the affected company, inspect:

- `companies.syncVersion` and `companies.authorizationEpoch`;
- the oldest and newest `syncChanges` rows by `by_company_and_version`;
- `syncOperationReceipts` for detailed rejection codes/messages and client sequence;
- `syncOperationDecisions` for the permanent terminal decision when a receipt is absent;
- `environmentRegistrations` for the environment's active/revoked state and binding; and
- `issueAttachments` for pending rows, expiry age, UploadThing key, and ready/deleted state.

Correlate an outbox `operationId`, `clientId`, and `localSequence` with the receipt/decision tables.
If the company head advanced but a replica did not, compare its checkpoint cursor with the oldest
feed version and inspect authorization-epoch changes before forcing any local reset.

For relay request failures, token exchange, Worker spans, and Axiom queries, use
[relay-observability.md](./relay-observability.md) rather than duplicating the relay runbook here.

## Clean cutover checklist

1. Create separate development and production Convex deployments. Set each deployment's Clerk
   issuer, relay issuer/JWKS, and `UPLOADTHING_TOKEN`.
2. Push functions to development with `convex dev --once`; run the pinned cloud-sync smoke harness
   and the two live-key UploadThing checks.
3. Push the same functions to production with `convex deploy`. For a brand-new relay/Convex pair,
   follow the first-deployment relay bootstrap order above so JWKS exists before this push.
4. Deploy the production relay from `infra/relay/.env.prod.local` and verify
   `https://relay.spiritdevs.com/.well-known/jwks.json` plus a relay health request.
5. Point the relay's `CONVEX_URL`, web build's `VITE_PATHWAY_CONVEX_URL`, mobile build's
   `PATHWAY_CONVEX_URL`, and server's `PATHWAY_CONVEX_URL` at the same production deployment. Configure
   `PATHWAY_CLOUD_SYNC_COMPANY_ID` on each server environment.
6. Create/select the empty production company, link the environment, and verify bootstrap, one issue
   round trip, a reconnect, and attachment prepare/finalize/delete. Do not run `smoke:seed` against
   the production company.
7. Release the generation-4 client/server build. A replica from an older bootstrap generation
   automatically performs one full reseed on first connect; its outbox survives.
8. Confirm the header and Settings sync surfaces are live and the Convex feed/receipt rows advance.
   There is no data-migration step in this cutover.
