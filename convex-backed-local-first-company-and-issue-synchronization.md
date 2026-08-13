# Convex-backed local-first company and issue synchronization

## Summary

Build a cloud-required, local-first Convex backend for Pathway. Convex becomes authoritative for companies, teams, permissions, issues, integrations, and synchronized execution state. Web, desktop, and Pathway servers retain durable local replicas and outboxes so issue work remains available offline and converges when connectivity returns.

Version 1 includes:

- Convex-owned companies/organisations, memberships, teams, configurable roles, invitations, and multiple owners.
- Users belonging to multiple companies and multiple teams.
- Full synchronization of the existing issue tracker, including attachments, automation, Slack state, thread links, and audit history.
- Full offline issue-domain editing with deterministic conflict resolution.
- Web and Electron issue/company UI.
- A reusable typed sync engine and mobile storage adapter, without a mobile issue UI.
- Foundations for a later Vercel portal and email domain, without implementing either yet.

## System boundaries

| Concern                              | Convex authority                               | Local persisted replica                                                            |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Companies, memberships, teams, roles | Complete source of truth                       | Read cache only; administration requires online access                             |
| Issues and planning records          | Complete source of truth                       | Full writable replica plus outbox                                                  |
| Attachments                          | Convex file storage                            | Pending offline blobs and downloaded cache                                         |
| Audit history                        | Durable canonical history                      | Permission-filtered cache                                                          |
| Slack configuration/cursors/dedupe   | Synced and canonical                           | Current coordinator’s working replica                                              |
| Integration credentials              | Application-encrypted vault                    | Never returned to human clients; temporarily available only to the leased executor |
| Project identity                     | Cloud project                                  | Environment-specific local project/folder binding                                  |
| Thread links                         | Cloud record with environment ID and thread ID | Local thread itself remains environment-owned                                      |
| Provider processes, Git state, paths | Registration/results only                      | Environment-owned runtime state                                                    |
| Sync operations/change feed          | Convex                                         | Cursor, confirmed state, pending overlay, and rejected operations                  |

```text
Clerk identity ────────┐
                      ▼
Web / Electron ─ local replica + outbox ─┐
Future portal ─ local replica + outbox ──┼── Convex authority
Mobile foundation ─ local adapter ───────┤      │
                                         │      ├── Resend invitations
Pathway server ─ SQLite replica/outbox ──┘      ├── encrypted secrets
       ▲                                        └── versioned change feed
       └── short-lived service JWT from Pathway relay
```

Direct human clients authenticate with Clerk through Convex’s supported integration. Pathway servers exchange their existing DPoP-bound environment credential through the relay for short-lived Convex-audience JWTs. [Convex’s Clerk integration](https://docs.convex.dev/auth/clerk) provides the browser authentication path.

## Repository structure

- Add `packages/backend` containing the Convex schema, functions, authentication configuration, generated API, Resend actions, encrypted-vault actions, migrations, and backend tests.
- Add shared contracts under:
  - `packages/contracts/src/company.ts`
  - `packages/contracts/src/cloudSync.ts`
  - `packages/contracts/src/cloudProject.ts`
  - Update `packages/contracts/src/issues.ts`.
- Add the framework-neutral engine under `packages/client-runtime/src/sync/`:
  - typed domain adapter interface;
  - confirmed replica;
  - optimistic outbox overlay;
  - bootstrap/change-feed driver;
  - operation acknowledgement and rejection handling;
  - sync presentation state.
- Add platform persistence:
  - Web/Electron: IndexedDB database `pathway:cloud-sync`.
  - Mobile foundation: existing mobile SQLite persistence layer.
  - Server: SQLite sync metadata/outbox plus company-scoped issue replica tables.
- Extend relay contracts and token issuance for a `pathway-convex` audience and environment/company claims.
- Do not create the Vercel portal application in this release.

## Company, user, team, and role model

Create these Convex entities:

- `users`: Clerk subject, normalized verified email, display profile, timestamps.
- `companies`: name, settings, issue key prefix/counter, lifecycle state, authorization epoch, sync head.
- `companyOwners`: company/membership pairs; a company may have multiple owners.
- `memberships`: one user in one company, with `active`, `locked`, or `left` state.
- `teams`: company-owned teams.
- `teamMemberships`: many-to-many membership/team assignments.
- `roles`: company-owned named permission bundles.
- `roleAssignments`: membership/role assignment scoped either to the whole company or one team.
- `companyInvitations`: normalized email, token hash, expiry, intended teams/roles, inviter, delivery state.
- `companySettings`: offline-access duration and other company-level policy.

Rules:

- A user can belong to any number of companies and teams.
- First successful sign-in creates an ordinary one-member company automatically. It can later be renamed, gain teams, and invite other users; it is not a separate personal-data model.
- Owners are separate from roles and implicitly pass every authorization check.
- Prevent removal, locking, or departure of the final owner transactionally.
- Any owner may add or remove another owner, schedule company deletion, or restore a company.
- Company deletion immediately disables normal access, remains owner-restorable for 30 days, then purges records, files, invitations, credentials, and change-feed data.
- Role assignments are allow-only. Effective permissions are the OR-union of all applicable company and team assignments.
- Team-scoped assignments apply only to records visible through that team. Company-scoped assignments apply across the company.
- Company administration permissions never gain company-wide effect merely because they appear in a team-scoped assignment.

Seed editable `Admin`, `Manager`, and `Member` roles. Ownership remains non-editable and is not represented by a role.

Define switches for:

- company read/manage;
- members read/invite/manage;
- teams read/manage;
- roles read/manage;
- billing read/manage;
- projects read/manage;
- issues read/create/update/delete;
- workflow configuration;
- comments create/update-own/moderate;
- shared views;
- automation run/manage;
- integrations read/manage;
- environments read/manage;
- audit read;
- data export.

Billing permissions ship now, but Stripe, plans, invoices, and billing screens do not.

## Invitations

Use Convex-owned invitations and Resend:

1. An authorized online client creates an invitation with intended team and role assignments.
2. Generate a cryptographically random token and store only its SHA-256 hash.
3. Send a seven-day link through a Convex Node action.
4. Use `company-invite/<invite-id>/<delivery-attempt>` as the Resend idempotency key.
5. The acceptance route preserves the invite through Clerk sign-in/registration.
6. Require the signed-in user’s verified normalized email to match.
7. Transactionally create or reactivate the membership, assign teams/roles, consume the token, and increment the company authorization epoch.
8. Support resend, revoke, expiry, and both existing and new Clerk users.

Resend supports explicit idempotency keys for safe delivery retries. [Resend idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys)

## Team visibility and workflows

### Issue visibility

- Every issue belongs to one company.
- An issue may be visible to zero or more teams:
  - no teams means company-wide;
  - one or more teams means any applicable team role granting `issues.read` exposes the complete issue.
- Access through any attached team exposes the whole issue, including comments, attachments, relations, and history.
- Editing uses the same union rule with the relevant write permission.
- Adding a team requires scope-management permission for that team.
- Removing a team must atomically clear or reassign team-scoped labels, cycles, workflow ownership, and project references that would become invalid.

### Workflow inheritance

Maintain:

- company base statuses;
- team overrides for inherited statuses;
- team-only statuses.

A team may override a base status’s name, color, semantic category, order, or visibility and may add arbitrary team statuses. Untouched base changes continue flowing into the effective team workflow. A team can hide every inherited status and use a completely different chain.

Semantic categories remain:

- backlog;
- unstarted;
- started;
- review;
- completed;
- canceled.

Names remain domain-specific. For example, `blocked` can map to `started`, while `customer subscribed` maps to `completed`.

Each issue has exactly one workflow owner:

- company workflow; or
- one team included in the issue’s team set.

The issue has one authoritative status regardless of how many teams can see it.

When changing workflow owner:

1. Reuse the same inherited base status when possible.
2. Otherwise choose the first effective target status with the same semantic category.
3. If no category match exists, require the caller to provide a target status.
4. Perform workflow and status changes atomically and record both in history.

Labels and cycles have company entries plus team-specific entries. Multi-team issues may use entries belonging to any attached team. Milestones remain project-owned.

### Issue navigation

- Company issue home aggregates all accessible workflows by semantic category and team.
- Selecting the company workflow or a team opens its precise ordered board/list.
- Never create a single board containing the union of unrelated sales and production statuses.
- Saved views can be:
  - private to their creator;
  - shared with selected teams;
  - company-wide.
- Shared-view creation and editing require the shared-view permission.

## Cloud projects and environment bindings

Create company-owned cloud projects with team visibility and an optional default workflow owner.

Store local bindings separately:

- company ID;
- cloud project ID;
- environment ID;
- local Pathway project ID;
- local workspace root;
- binding status and last-seen metadata.

One Pathway environment may register with several companies, with independent service roles and team scopes in each.

Behavior:

- A cloud project may have no local binding and remains visible in the portal-compatible model.
- Starting work requires an eligible online binding.
- If exactly one eligible binding exists, use it.
- If several exist, use the project’s preferred binding or ask the user to select one.
- If none exists, prompt to bind a local Pathway project before continuing.
- Thread links store both environment ID and thread ID so other clients can identify the origin without pretending the thread is portable.

## Synchronization protocol

### IDs and issue keys

- Generate stable UUIDv7 domain IDs client-side so offline relationships do not need ID remapping.
- Convex `_id` values remain storage implementation details.
- Human issue keys remain immutable and sequential per company.
- Lease blocks of 25 numbers per client while online and replenish when five remain.
- Never recycle unused leased numbers; gaps are acceptable.
- If a device exhausts its block offline, show a local `Draft` key while retaining the stable issue ID. Assign the real key before the create operation is accepted by Convex.

### Operations and versions

Define a tagged, versioned `SyncOperation` union whose issue-domain variants mirror the existing issue commands.

Each operation carries:

- protocol version;
- operation ID;
- company ID;
- source client/environment ID;
- authenticated actor;
- local sequence;
- base company version;
- entity ID and operation-specific arguments;
- dependency operation IDs where required.

Convex applies operations in deterministic serializable mutations, which Convex automatically retries under OCC. [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ)

For each accepted operation:

- verify membership/service identity and applicable permissions;
- deduplicate by operation ID;
- validate domain invariants;
- apply authoritative entity changes;
- write issue audit events;
- append full-entity sync changes or tombstones;
- assign contiguous company versions;
- return the accepted version range.

Use a maximum batch of 25 operations and 512 KiB of arguments. Files never travel in operation arguments.

### Change delivery

Expose:

- `sync.bootstrap`
- `sync.latestVersion`
- `sync.listChanges`
- `sync.applyOperations`
- `sync.reserveIssueKeys`

Clients subscribe only to the small `latestVersion` query. When it advances, they drain bounded change pages from their persisted cursor.

`listChanges` must:

- return at most 100 changes and remain under a configured byte ceiling;
- advance its cursor even when permission filtering yields an empty page;
- filter every change by current company/team authorization;
- include the current authorization epoch;
- never expose unauthorized payloads.

Keep sync changes and operation receipts for 90 days. A client whose cursor predates the retained feed discards its confirmed replica and performs a full paginated bootstrap. Issue audit history remains until company deletion.

Convex pagination and transaction-size limits require bounded reads and writes rather than unbounded collection queries. [Convex pagination](https://docs.convex.dev/database/pagination), [Convex limits](https://docs.convex.dev/production/state/limits)

### Local replica and optimistic state

Maintain two layers locally:

- confirmed state at a persisted Convex cursor;
- durable pending operations replayed as an optimistic overlay.

On startup:

1. Decode or quarantine the local schema.
2. Check the cached offline access grant.
3. Render confirmed state plus pending overlay immediately.
4. When online, authenticate, compare authorization epoch, bootstrap or drain changes, then send pending operations in local sequence.
5. Retain acknowledged operations until the confirmed cursor includes their final version.
6. Rebase remaining optimistic operations over every confirmed change.

Conflict policy:

- Different fields merge naturally.
- The later Convex-accepted operation wins for the same field.
- Client clocks never decide winners.
- Record stale-base overwrites in audit history with before/after values.
- A later delete tombstones the entity; updates to a deleted entity are rejected until an explicit restore.
- Invalid dependent operations become blocked with a visible reason rather than being silently discarded.
- Permission-rejected operations roll back their overlay, remain visible in a rejected-changes panel, and do not block independent operations.

Use fractional string order keys with ID tie-breaking for all offline-reorderable collections.

## Offline access and lifecycle

- Default offline access duration: 30 days.
- Company setting range: zero through 90 days.
- Zero disables opening company data without an online authorization check.
- Refresh the local access grant after each successful authorization.
- A new device cannot bootstrap offline.
- Permission, membership, role, team, company, integration, host, and project-binding administration remains online-only.
- Full offline writes cover issues, statuses/workflow edits already locally authorized, labels, milestones, cycles, views, todos, relations, comments, and attachments.
- Explicit sign-out:
  - if the outbox is empty, wipe that Clerk user’s replicas, pending blobs, cached grants, and encryption keys;
  - if pending work exists, require “sync first” or explicit destructive discard before signing out.
- Leaving a company or receiving an authorization-epoch change purges records no longer visible.
- Web storage is origin-scoped IndexedDB and makes no stronger at-rest claim than the browser/OS provides.
- Electron should encrypt local sync records with a key protected by Electron secure storage.
- Server SQLite continues to rely on the Pathway Home/OS trust boundary.

## Attachments

Offline attachments use local blob IDs referenced by optimistic comments.

On reconnect:

1. Request an authorized short-lived Convex upload URL.
2. Upload the blob directly.
3. Finalize metadata with company, issue, MIME type, size, checksum, and uploader.
4. Rewrite the pending comment operation to the resulting stable attachment ID.
5. Submit the comment only after all required uploads finalize.
6. Keep retry state idempotent and garbage-collect unattached uploads.

Convex’s supported flow is generate URL, upload bytes directly, then persist the storage ID. [Convex file uploads](https://docs.convex.dev/file-storage/upload-files)

Preserve existing image and evidence-video limits. Generate file URLs only through permission-checked queries.

## Environment credentials, leases, and execution

Extend the existing relay rather than adding another identity service:

- Environment registration remains key-bound.
- Relay token exchange accepts the existing DPoP proof and environment credential.
- Relay issues a short-lived bearer JWT with `aud=pathway-convex`, environment ID, public-key thumbprint, and token ID.
- Convex validates the relay issuer as a custom JWT provider, then resolves company registrations and service-role permissions from Convex.
- Revocation of the environment registration invalidates future exchanges.

Execution model:

- One company integration coordinator lease:
  - 90-second TTL;
  - renew every 30 seconds;
  - lease generation included with side-effect claims.
- Slack polling, cursor advancement, and integration coordination run only on the current coordinator.
- Project-bound agent/Git jobs are claimed separately by eligible environments with a valid local project binding.
- Claims are transactional, idempotent, renewable, and recoverable after expiry.
- Losing a lease prevents new side effects immediately.
- Shared Slack cursors, processed-message IDs, outbound IDs, automation audit records, and operation IDs prevent duplicate work after failover.
- Tests advance a controlled clock and await receipts/worker drains; never use sleeps or polling.

## Encrypted integration vault

Store per-company integration credentials as:

- ciphertext;
- AES-256-GCM nonce;
- authenticated metadata containing company/integration IDs;
- encryption key version;
- creation/update actor and timestamps.

Rules:

- Master keys live only in Convex environment configuration.
- Human queries return configured/presence/status metadata, never plaintext.
- Credential writes pass through an authorized Node action, encrypt, then call an internal mutation.
- Only the current coordinator service identity with applicable integration permission may request execution material.
- Every secret read/use is audited.
- Key rotation decrypts and re-encrypts in bounded resumable batches.
- Resend’s platform API key remains deployment configuration, not a company vault secret.

## Existing issue system conversion

Update all issue-related SQLite tables and repository calls to be company-scoped. Preserve the existing typed service and automation seams where possible, but make Convex operations the authority.

Sync all existing issue data:

- issues;
- statuses and workflow configuration;
- labels;
- milestones;
- cycles;
- todos;
- relations;
- comments and attachments;
- views;
- audit events;
- enrichment and comment-agent runs;
- thread links;
- automation assignments/audits;
- Slack watches, routes, cursors, processed messages, and outbound records;
- tracker configuration.

Runtime-only fibers, provider processes, filesystem paths, and Git state remain local.

Update `IssueActor` to distinguish:

- a specific member;
- an agent/provider;
- a system source.

Human assignees reference a specific membership rather than the current anonymous `{kind: "user"}` value. Preserve removed memberships as audit-safe tombstones so historical attribution remains meaningful.

The web/Electron UI stops reading `issues.stream` and issue mutation RPCs. After cloud cutover, old clients receive an explicit upgrade-required error rather than broad server-replica access without company authorization. MCP and server automation operate against the local synchronized repository using the project/thread’s company binding.

## Migration and cutover

Use a resumable import run with dry-run preview.

### First activation

- Ensure the Clerk user and default company exist.
- Detect existing local issue data.
- Require migration before opening the cloud-required issue tracker.
- Snapshot `state.sqlite` safely and preserve attachment files before import.
- Never point Convex tooling or migration code at the live SQLite database read-write outside the normal server service.

### Import behavior

For an empty target company:

- preserve domain IDs, issue keys, workflow catalog, labels, cycles, views, history, and timestamps;
- create cloud projects and local bindings from current Pathway projects;
- map anonymous human actors to the importing membership;
- stamp thread links with the source environment;
- set the next issue number above every preserved key using the selected current prefix.

For a non-empty target company:

- create/select an import team;
- import the local workflow as that team’s inherited overrides/team-only statuses;
- import local labels and cycles as team-scoped entries;
- attach imported issues/projects to that team;
- remap conflicting issue keys from a reserved block while preserving the former key in import metadata and audit history;
- preserve IDs unless an actual ID collision exists;
- show counts, key changes, workflow/team placement, attachments, secrets-presence, and rejected records before confirmation.

The import is idempotent by source environment ID and import run ID. It uploads attachments and encrypted Slack credentials in resumable bounded batches. Do not dual-write indefinitely: after checksum validation and final cursor catch-up, atomically mark the environment/company binding active and make the local tables a replica.

## UI changes

Web and Electron receive:

- company switcher;
- company creation and 30-day deletion recovery;
- members, invitations, teams, owners, roles, and permission switches;
- company/team-scoped environment and project binding settings;
- company issue overview grouped by semantic category;
- workflow-specific boards/lists;
- workflow-owner selection on issues;
- team visibility controls;
- private/team/company saved-view controls;
- explicit sync status: initializing, live, offline, syncing, blocked, or error;
- pending-operation indicators;
- rejected-change recovery panel;
- migration preview/progress/recovery UI;
- offline-expiry messaging;
- sign-out sync-or-discard flow.

The mobile release receives shared contracts, sync engine compatibility, and a persistence adapter only. It does not add issue, company, team, role, or migration screens.

## Documentation deliverables

- Add ADR `0007-convex-company-local-first-sync.md`.
  - Supersede deferred ADR 0005’s Clerk-Organization decision.
  - Amend ADR 0006’s environment-scoped issue-tracker assumption.
  - Record tenancy, ownership, authorization, conflict, retention, lease, and offline decisions.
- Add `docs/internals/cloud-sync.md` covering protocol, local replicas, outbox, cursors, compatibility, and failure recovery.
- Add `docs/internals/companies-and-permissions.md` covering companies, teams, multi-role authorization, owners, and invitations.
- Update:
  - `docs/internals/issue-tracker.md`
  - `docs/internals/connection-runtime.md`
  - `docs/internals/overview.md`
  - `docs/internals/glossary.md`
- Add user documentation for:
  - companies and teams;
  - roles and permissions;
  - offline issue behavior;
  - migration and rejected changes.
- Add `docs/operations/convex-sync.md` for deployment configuration, Resend, relay issuer setup, secret rotation, feed retention, import recovery, and incident diagnostics.

## Verification and acceptance tests

### Domain and authorization

- Users can join several companies and several teams in each.
- Multiple role assignments union correctly across company and team scopes.
- A role from one team cannot grant access through another.
- Any attached team can grant full issue access.
- Company-wide issues require applicable company-scoped permissions.
- Owners cannot all be removed or locked.
- Permission, membership, and team changes increment authorization epoch and force replica reseeding.
- Invitation acceptance is email-bound, single-use, expiring, resendable, revocable, and idempotent.

### Workflow behavior

- Team overrides inherit untouched company changes.
- Teams may hide every company status and add a distinct workflow.
- One multi-team issue uses exactly one workflow owner.
- Workflow-owner changes map status deterministically or require an explicit target.
- Cross-workflow company overview groups by semantic category.
- Team-scoped labels/cycles become invalid when their last applicable team is removed.

### Synchronization

- Two clients editing different fields offline merge both changes.
- Two clients editing the same field converge to Convex commit order and retain overwritten history.
- Duplicate submission applies exactly once.
- Restarted clients replay persisted outboxes once.
- Empty permission-filtered pages still advance cursors.
- Expired cursors trigger full bootstrap.
- Authorization changes purge inaccessible records.
- Rejected operations roll back only their optimistic effect and do not block independent work.
- Deletes, restores, dependent creates, and reorder collisions converge deterministically.
- Reserved issue-key blocks never collide and exhausted clients receive stable keys after reconnect.

### Files and integrations

- Offline attachment comments survive restart and upload in the required order.
- Unauthorized file URLs and uploads are rejected.
- Orphaned uploads are cleaned.
- Vault queries never return plaintext.
- Only the current coordinator can obtain integration execution material.
- Lease failover resumes Slack work without duplicate intake or outbound messages.
- Project jobs can be claimed only by environments with valid bindings and permissions.

### Migration

- Fixtures cover every issue-related table and attachment type.
- Empty-company import preserves IDs, keys, timestamps, links, actors, and history.
- Non-empty-company import remaps collisions and creates the expected team workflow.
- Interrupted imports resume without duplicates.
- Source SQLite and attachment backups remain recoverable.
- Post-import Convex and SQLite replica checksums match.

### Performance and compatibility

- Bootstrap and change pages stay under configured row/byte limits with thousands of issues.
- Issue list/board rendering does not subscribe per row.
- A high-volume company does not emit whole-company snapshots per edit.
- Convex protocol supports current and previous client versions; older incompatible clients receive upgrade-required.
- Run focused backend, contracts, client-runtime, server repository, relay, web state, and migration tests plus targeted typechecks/lint.
- Do not run repository-wide checks unless requested.
- Any integrated browser validation or before/after capture requires explicit approval before launching a browser.

## Rollout

1. Land ADRs, contracts, and schema behind a disabled cloud-sync capability.
2. Deploy Convex identity/company/authorization functions and relay JWT support.
3. Land the generic sync engine, local stores, and a test-only domain adapter.
4. Port the complete issue domain and server replica.
5. Add company/team/role/workflow UI and direct Convex authentication.
6. Add attachments, invitations, encrypted secrets, Slack coordination, and project claims.
7. Enable migration preview for internal companies and compare Convex/SQLite checksums without cutting over.
8. Canary cutover selected companies; monitor mutation failures, OCC retries, change-feed lag, outbox age, rejected operations, lease churn, and migration mismatches.
9. Enable cloud-required onboarding and migration for production after canary acceptance.
10. Remove the transitional local issue authority only after all supported clients enforce the new protocol.

## Explicit assumptions and exclusions

- Convex hosted deployments are the authoritative backend.
- Clerk remains mandatory user identity but does not own companies, teams, memberships, roles, or invitations.
- Resend delivers company invitation email.
- Offline access defaults to 30 days and is configurable from zero to 90 days.
- Change-feed retention is 90 days; issue audit history persists until company deletion.
- Company deletion is recoverable for 30 days.
- Company workflow plus inherited team overrides is the only workflow model.
- Company projects, issues, views, and related records can be visible to multiple teams.
- Billing permissions are placeholders for later functionality.
- The Vercel portal, real email synchronization, email UI, and mobile issue UI are outside v1.
- The future portal and email domain must reuse the typed sync primitives rather than creating a second replication system.
