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

## Prerequisites

- **Pathway Connect CLI credential** on this machine: run `t3 connect login` first. The harness
  loads the stored credential the same way `t3 connect` relay calls do; without it the first step
  fails with instructions.
- **`npx convex run` works from `packages/backend`** with admin access to the target deployment.
  The hooks shell out with that directory as cwd and every subprocess pinned to
  `PATHWAY_CONVEX_SMOKE_DEPLOYMENT` via `CONVEX_DEPLOYMENT` — the convex CLI never resolves the
  deployment from `.env.local` or an inherited variable. Verify with
  `CONVEX_DEPLOYMENT=dev:<slug> npx convex run smoke:inspect '{"environmentId":"probe"}'` from
  `packages/backend`.
- **Target Convex deployment configuration**: `PATHWAY_CLOUD_SYNC=enabled` and
  `PATHWAY_RELAY_JWT_ISSUER` set to the relay issuer, or every authenticated call fails with
  `cloud-sync-disabled`.

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

From the repo root (the `t3` package's test script is `vp test run`, so extra arguments select
files):

```sh
PATHWAY_CONVEX_SMOKE=1 \
CONVEX_URL=https://<deployment>.convex.cloud \
PATHWAY_CONVEX_SMOKE_DEPLOYMENT=dev:<deployment> \
vp run --filter t3 test src/cloud/convexSyncSmoke.integration.test.ts
```

The test prints a per-step `PASS`/`FAIL` report on failure. Steps are ordered so the negative cases
(`setThumbprint` mismatch, revocation) run only **after** the happy-path round-trip, and cleanup
(relay unlink + `smoke:cleanup`, which deletes — it never restores) always runs, even when earlier
steps fail. Cleanup treats "already gone" as success, and intent is recorded **before** each
mutating request goes out, so a link or seed whose response was lost is still cleaned up.

One deliberate exception: if the reserved smoke company holds rows in any table the smoke flow
never writes (memberships, issues, …), `smoke:cleanup` throws `smoke-cleanup-refused` instead of
deleting the company — and since a thrown Convex error rolls back the whole mutation, its
registration deletes are undone too, leaving the company fully intact for a human to inspect. The
cleanup step (and the run) then fails, and the recovery state file is kept so every subsequent run
keeps failing loudly until an operator resolves it by hand.

## Crash recovery

`Effect.ensuring` cannot run under SIGKILL, so before its first mutating request the harness writes
a recovery state file — `$TMPDIR/pathway-convex-smoke/<environmentId>.json`, carrying the
environment id, relay URL, deployment, and company id — and removes it only after cleanup fully
succeeds. On startup, the harness lists leftover state files from prior runs and recovers them
before proceeding: it unlinks each stale environment at the relay (by environment id, under the
operator's account) and runs the registration cleanup (`smoke:cleanup` sweeps every `env-smoke-*`
registration). Each recovery attempt appears as its own step in the report.

At intent time the harness also logs the manual cleanup commands, so an operator can recover a dead
run by hand:

```sh
# Convex registration/company state (from packages/backend):
CONVEX_DEPLOYMENT=dev:<deployment> npx convex run smoke:cleanup '{"environmentId":"env-smoke-<uuid>"}'

# Relay environment link (any authenticated relay client works the same way):
curl -X DELETE https://relay.spiritdevs.com/v1/client/environment-links/env-smoke-<uuid> \
  -H 'Authorization: Bearer <t3 connect CLI access token>'
```

Afterwards, delete the state file so the next run does not re-attempt recovery.

The CI-safe unit tests for the harness and hooks need no environment:

```sh
vp run --filter t3 test src/cloud/convexSyncSmoke.test.ts src/cloud/convexSmokeHooks.test.ts
```
