# Cloud sync smoke test (relay → Convex trust chain)

> For maintainers. Using Pathway? See [docs/user](../user/).

An env-gated integration test walks the full Phase 1 trust chain against a real deployed relay and
Convex deployment: stored CLI credential → environment link → DPoP + key-binding token exchange at
`POST /v1/environment/convex-token` → service-token claim and live-JWKS signature checks →
authenticated Convex sync calls → negative cases (rogue key, key mismatch, revocation, each
asserted against its exact `auth_invalid` reason, then a re-exchange proving the credential stayed
valid) → cleanup. The harness lives in `apps/server/src/cloud/convexSyncSmoke.ts`; registration
state is managed by the internal-only `smoke:*` functions in `packages/backend/convex/smoke.ts`,
invoked via `apps/server/src/cloud/convexSmokeHooks.ts`. Everything it seeds is confined to the
reserved smoke company (`00000000-0000-7000-8000-736d6f6b6501`) and deleted afterwards, even on
failure.

The authenticated sync calls exercise the issue-domain apply handlers for real, not just
authentication. In order:

1. `sync.latestVersion` — the head the later cursors anchor on.
2. `sync.applyOperations` with an `issueLabel.create` (the smallest issue-domain entity: one row,
   no audit event, exactly one feed change) — the receipt must be **accepted**, which also proves
   the seeded smoke role authorizes a company-scoped `workflow.manage` write.
3. `sync.listChanges` drained from the pre-create head — the label's `upsert` must surface, with
   matching entity kind and id.
4. `sync.bootstrap` with `pageSize: 1` — the smallest a `SyncBootstrapRequest` allows — for **one
   page only**, so the seed is deliberately left mid-walk. Its `version` is the resume position a
   fresh client persists, and page one's cursor is kept as an opaque token.
5. `sync.applyOperations` with a **second** `issueLabel.create` while the seed is suspended: the
   write the finding below calls for, landing between two pages of the same snapshot.
6. `sync.bootstrap` resumed from page one's original cursor and paged to completion. Every page
   must report page one's `version` — a seed that re-captured the head per page would hand back a
   resume position past the mid-seed write — and the label created before the seed must appear in
   the snapshot as a whole.
7. `sync.listChanges` drained from that same `version`: the interleaved write must arrive **exactly
   once**, counting the remaining seed pages and the drain together. It must be in the drain (its
   version is past the seed's, so a resume there that misses it is a lost write), at most once on
   either side, and every delivery must be the create's `upsert` stamped with the version its
   receipt reported. Appearing on both sides is not a duplicate and is not an error: the seed is
   pinned to page one's head, so a row the remaining pages still read is re-delivered by the drain
   with the same stamp and folds through one idempotent upsert. Which side delivers it depends on
   where the walk stood when the write landed — an internal detail the smoke deliberately does not
   assert on.
8. `sync.applyOperations` with an `issueLabel.delete` for the interleaved label, then one for the
   original, then `sync.listChanges` resumed from the bootstrap `version` again — the tombstone
   written after the snapshot must be the change the resumed feed yields for each, proving the
   snapshot→feed handoff is gap-free and that the run left no live row behind.

The two tombstoned `issueLabels` rows are the only authoritative rows the run leaves behind; they
are removed with the company by `smoke:cleanup`, whose sweep list already covers `issueLabels`.

The seed the two bootstrap steps page through is not issue-only. `BOOTSTRAP_ENTITY_ORDER` walks the
company domain after the issue domain — the company itself, its settings, memberships, teams, team
memberships, roles, and role assignments — so a one-row-per-page walk of even an empty smoke company
takes a page for each of the rows its own setup created. That is why `SMOKE_BOOTSTRAP_MAX_PAGES`
exists and why it is a ceiling rather than an expected count: it catches a walk that is not
advancing, not a walk that has more kinds than it used to. Growing the walk order means checking
that ceiling still has headroom.

## Prerequisites

- **Pathway Connect CLI credential** on this machine: run `pathway connect login` first. The harness
  loads the stored credential the same way `pathway connect` relay calls do; without it the first step
  fails with instructions.
- **`npx convex run` works from `packages/backend`** with admin access to the target deployment.
  The hooks shell out with that directory as cwd and every subprocess pinned to
  `PATHWAY_CONVEX_SMOKE_DEPLOYMENT` via `CONVEX_DEPLOYMENT` — the convex CLI never resolves the
  deployment from `.env.local` or an inherited variable. Verify with
  `CONVEX_DEPLOYMENT=dev:<slug> npx convex run smoke:inspect '{"environmentId":"probe"}'` from
  `packages/backend`.
- **Target Convex deployment configuration**: `PATHWAY_RELAY_JWT_ISSUER` set to the relay issuer.
- **A deployment carrying the issue-domain apply handlers** (`convex/lib/issueApply.ts` registered
  in `convex/sync.ts`) and a smoke role granting `workflow.manage` — `smoke:seed` converges the
  role's permissions from `smokeServiceRolePermissions()` on every run, so redeploying the backend
  and rerunning is enough after a permission change. Without the write permission the
  `issueLabel.create` step fails with an exact `permission-denied` receipt in the report.

## Environment variables

| Variable                                  | Required | Meaning                                                                                                                                                                               |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATHWAY_CONVEX_SMOKE=1`                  | yes      | Enables the otherwise-skipped suite.                                                                                                                                                  |
| `CONVEX_URL`                              | yes      | Convex deployment URL (e.g. `https://<name>.convex.cloud`).                                                                                                                           |
| `PATHWAY_CONVEX_SMOKE_DEPLOYMENT`         | yes      | Deployment the admin hooks may mutate, e.g. `dev:chatty-ermine-52`. Passed as `CONVEX_DEPLOYMENT` to every `npx convex run`; its slug must match `CONVEX_URL`'s first hostname label. |
| `PATHWAY_CONVEX_SMOKE_ALLOW_URL_MISMATCH` | no       | Set to `1` only when `CONVEX_URL` is a custom domain that can never match the deployment slug.                                                                                        |
| `PATHWAY_RELAY_URL`                       | no       | Defaults to `https://relay.spiritdevs.com`.                                                                                                                                           |
| `PATHWAY_CONVEX_SMOKE_COMPANY_ID`         | no       | Defaults to the reserved smoke company id.                                                                                                                                            |
| `PATHWAY_CONVEX_SMOKE_BACKEND_DIR`        | no       | Defaults to the repo's `packages/backend` next to the harness.                                                                                                                        |

The deployment/URL cross-check exists because the hooks mutate whatever deployment the convex CLI
targets, while the authenticated client calls go to `CONVEX_URL` — a silent mismatch could seed and
revoke registrations on the wrong (even production) deployment. The harness refuses to run any
mutation until the two provably agree (or the operator explicitly accepts a custom-domain
mismatch).

## Running it

From the repo root (the `@spiritdevs/pathway` package's test script is `vp test run`, so extra arguments select
files):

```sh
PATHWAY_CONVEX_SMOKE=1 \
CONVEX_URL=https://<deployment>.convex.cloud \
PATHWAY_CONVEX_SMOKE_DEPLOYMENT=dev:<deployment> \
vp run --filter @spiritdevs/pathway test src/cloud/convexSyncSmoke.integration.test.ts
```

The test prints a per-step `PASS`/`FAIL` report on failure. Steps are ordered so the negative cases
(`setThumbprint` mismatch, revocation) run only **after** the happy-path round-trip, and cleanup
(relay unlink + `smoke:cleanup`, which deletes — it never restores) always runs, even when earlier
steps fail. Cleanup treats "already gone" as success, and intent is recorded **before** each
mutating request goes out, so a link or seed whose response was lost is still cleaned up.

One deliberate exception: if the reserved smoke company holds rows in any table the smoke flow
never writes (memberships, teams, `companySettings`, `environmentCommands`, a role other than the
seeded one, …), `smoke:cleanup` throws `smoke-cleanup-refused` instead of deleting the company —
and since a thrown Convex error rolls back the whole mutation, its registration deletes are undone
too, leaving the company fully intact for a human to inspect. The cleanup step (and the run) then
fails, and the recovery state file is kept so every subsequent run keeps failing loudly until an
operator resolves it by hand. Only the tables the smoke flow _can_ write — change-feed rows,
operation receipts, issue-key leases, and the issue-domain rows the sync surface writes on its
behalf (the run's tombstoned `issueLabels` rows) — are swept. `companySettings` and
`environmentCommands` are deliberately on the foreign side: no sync operation kind writes either
and every `environmentCommands` mutation is still unimplemented, so a row there is somebody else's
data. They move to the sweep list when phase 8 gives the environment actor a real write path.

## One run at a time

Every run shares the reserved smoke company, so two overlapping runs (two operators, or a CI job
racing its own retry) contend for the same rows: treat the smoke as single-flight per deployment.
The one place it would have been destructive is guarded — `smoke:cleanup` sweeps another run's
`env-smoke-*` registration only after it has sat untouched for `SMOKE_ORPHAN_MIN_AGE_MS`
(15 minutes, far longer than a run takes), so a live registration is retained instead of deleted
and the company survives with it. The trade-off is that a genuinely orphaned registration younger
than the threshold outlives the recovery pass; the next run sweeps it once it ages out, or an
operator runs the manual cleanup below.

## Crash recovery

`Effect.ensuring` cannot run under SIGKILL, so before its first mutating request the harness writes
a recovery state file — `$TMPDIR/pathway-convex-smoke/<environmentId>.json`, carrying the
environment id, relay URL, deployment, and company id — and removes it only after cleanup fully
succeeds. On startup, the harness lists leftover state files from prior runs and recovers them
before proceeding: it unlinks each stale environment at the relay (by environment id, under the
operator's account) and runs the registration cleanup (`smoke:cleanup` sweeps the aged-out
`env-smoke-*` registrations). Each recovery attempt appears as its own step in the report.

Recovery is pinned to the _current_ run's relay and deployment, so it only touches leftovers whose
state file records those same targets. A leftover from a run against a different deployment or
relay — the state directory is shared per machine — is reported as a failed
`recovery.foreignRun[<environmentId>]` step carrying the manual commands below, and its state file
is kept: cleaning it from here would sweep the wrong deployment, ask a relay that never held the
link (which answers "already gone"), and then delete the only record of the real leftovers.

At intent time the harness also logs the manual cleanup commands, so an operator can recover a dead
run by hand:

```sh
# Convex registration/company state (from packages/backend):
CONVEX_DEPLOYMENT=dev:<deployment> npx convex run smoke:cleanup '{"environmentId":"env-smoke-<uuid>"}'

# Relay environment link (any authenticated relay client works the same way):
curl -X DELETE https://relay.spiritdevs.com/v1/client/environment-links/env-smoke-<uuid> \
  -H 'Authorization: Bearer <pathway connect CLI access token>'
```

Afterwards, delete the state file so the next run does not re-attempt recovery.

The CI-safe unit tests for the harness and hooks need no environment:

```sh
vp run --filter @spiritdevs/pathway test src/cloud/convexSyncSmoke.test.ts src/cloud/convexSmokeHooks.test.ts
```
