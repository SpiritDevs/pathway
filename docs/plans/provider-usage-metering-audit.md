# Provider usage metering — audit & remediation plan (2026-08-30)

Scope: the provider allowance bars (action palette "Usage" section, provider settings cards, sidebar account menu) — contract `packages/contracts/src/providerUsage.ts`, server `apps/server/src/providerUsage/ProviderUsageService.ts`, UI `apps/web/src/components/usage/*`. This is system A (subscription quota % + reset times), distinct from system B (token/cost analytics in `apps/server/src/usage/*`).

Benchmarks: steipete/CodexBar (69 providers, best-in-class docs), codex-rs source, Anthropic/OpenAI/Cursor official docs, community tools (ccusage, Claude-Code-Usage-Monitor).

## Current architecture (as-built)

- Web-only. iOS and desktop have no provider-usage surface.
- Pull-only request/response RPC (`server.getProviderUsage`); no subscription, no polling. Client SWR atom `staleTimeMs: 60s`; server in-memory cache TTL 5 min ok / 60 s degraded.
- Three drivers: Codex (`chatgpt.com/backend-api/wham/usage`, creds from `auth.json`/Keychain), Claude (`api.anthropic.com/api/oauth/usage`, creds from `.credentials.json`/Keychain), Cursor (`api2.cursor.sh` Connect-RPC, creds from Cursor's `state.vscdb`).
- Read-only credential access, no OAuth refresh (correct per CodexBar's hard-learned discipline — the owning CLI refreshes).

## Findings

### P0 — correctness bugs

1. **Codex windows mislabeled and half-dropped** (`ProviderUsageService.ts:373-379`). Only one window is emitted, labeled "Weekly", preferring `primary_window`. Per codex-rs (`rate_limits.rs`) and our own checked-in fixture (`codex_transcript.ndjson:25`), `primary_window` is the **5-hour** lane and `secondary_window` is weekly. Codex users see 5h usage labeled "Weekly" with fabricated `windowDurationMins: 10080`, and the real weekly window is dropped (`??` short-circuit). `ProviderUsageService.test.ts:11-32` asserts the bug. Fix: emit both windows, derive labels from `limit_window_seconds` (or `x-codex-*-window-minutes` headers, currently unread), read both `used-percent` headers.
2. **Force-refresh never reaches the shared atom** (`ProviderUsage.tsx:74-137`). Refreshed snapshots live in component-local `useState`; the `serverEnvironment.providerUsage` atom is never invalidated, so sibling views (`ConnectedProviderUsageRow`, `UsageLimitRecoveryActions`) keep pre-refresh data and the fresh value dies on unmount. Fix: write through to / invalidate the query atom.
3. **Stale snapshots lie about `updatedAt`** (`ProviderUsageService.ts:820-832`). On error-with-prior-ok, the old snapshot is returned with `stale: true` but `updatedAt` rewritten to now; true `fetchedAtMs` never surfaced. CodexBar's pattern: keep last-good visible **with capture age**. Fix: preserve original timestamp (or add `fetchedAt`), let UI show age.
4. **`forceRefresh` ignored when a fetch is in flight** (`ProviderUsageService.ts:813-815`) — pending non-forced promise returned before the flag is checked.

### P1 — architecture & rot

5. **Codex push data discarded.** The Codex app-server already pushes `account/rateLimits/updated` (correct labels, live) over a connection Pathway holds; we ignore it (schema generated in `effect-codex-app-server`, only routing-tested). Wiring it into the snapshot cache + a `providerUsageLive` subscription atom (pattern exists: `scheduledTasksLive`, `resourceTelemetry`) converts pull→push for Codex, kills finding #1's endpoint dependence, and follows the community's #1 best practice: passive sources over polling private endpoints.
6. **Claude parser misses the newer response shape.** Only `five_hour`/`seven_day`/`seven_day_sonnet`/`seven_day_opus` are read. Anthropic now also returns scoped `limits[]` entries (`kind`, `group`, `percent`, `resets_at`, `scope`, `is_active`) and other `seven_day_*` keys (`_oauth_apps`, `_routines`/`_cowork`); unknown windows are silently dropped.
7. **Hardcoded impersonation rots** (`User-Agent: claude-code/2.1.69`, `anthropic-beta: oauth-2025-04-20`). The UA is effectively required (non-Claude-Code UAs get punitive 429s — claude-code #31021/#31637), so keep impersonating but detect the installed Claude version like CodexBar (fallback pinned). Same rot class: `wham/usage`, `api2.cursor.sh` — undocumented, with real breakage history (CodexBar #3248 bogus weekly resets, #1844 Keychain shape drift).
8. **No 429/`Retry-After` handling** — a rate-limited token is retried on next TTL expiry. CodexBar gates per-token until the retry date.
9. **`window` is a display string doubling as identity.** `"5h" | "Weekly" | "Sonnet" | "Opus" | "Current"` in one free-form field; model-scoped windows get fabricated durations; UI keys on it. Contract needs a machine-readable `windowKey`/`scope` alongside the label.
10. **Claude credential fallback aborts on network errors** (`:583-613`) — thrown fetch returns immediately; Keychain credential never tried.

### P2 — polish

11. Limits with `resetsAt` but no `usedPercent` are dropped by `deriveProviderUsageLimits` (`providerUsageDisplay.ts:34`) → "No quota data reported yet" despite data. (Real case: org-managed Claude plans return no numerics — show reset-only rather than blank; never synthesize %.)
12. `titleCase` renders "Chatgpt Plus"; map known `plan_type`/`rate_limit_tier` values ("ChatGPT Plus", "Max (20x)").
13. Cursor Windows path falls back to Linux layout when `APPDATA` unset (`:729-733`).
14. `snapshotCache` unbounded (header comment claims bounded); entries outlive deleted instances.
15. `formatDuration` over-rounds (`Math.ceil` per tier: 61 min → "2h", 49 h → "3d").
16. Credits line renders when `has_credits` merely absent (`:385`); no handling of `unlimited` flag.
17. JWT `exp` used as hard gate → `needs-auth`; better used as scheduling hint with grace, message "waiting for CLI to refresh".

### Non-issues (validated against best practice)

- Read-only creds, never refreshing another tool's tokens: correct.
- `selectPrimaryProviderUsageLimit` picking the binding (lowest-remaining) window: correct.
- Keychain access via `security` CLI, darwin-gated: fine.
- Bars showing % **left** with danger ≤10 / warning ≤25 thresholds: matches CodexBar's red/amber convention.

## Remediation order

1. **P0 fixes** (1–4) + regression tests replacing the bug-asserting test.
2. **Contract v2**: add `windowKey` (`"session" | "weekly" | "monthly" | "custom"`), `scope` (model name), `fetchedAt`, `retryAfterSeconds`; keep `window` as label. Parse Claude `limits[]` + unknown-key passthrough; both Codex windows + `additional_rate_limits[]`.
3. **Push pipeline**: consume `account/rateLimits/updated` → snapshot cache → new `subscribeProviderUsage` WS method → `providerUsageLive` subscription atom → all mounts move off request/response. HTTP fetch becomes fallback/bootstrap for providers without push.
4. **Hygiene**: Retry-After gates, UA version detection, credential-fallback continue-on-error, bounded cache, plan-name map, Cursor path fix.

The menu bar feature (see `menu-bar-spec.md`) consumes the step-3 pipeline; steps 1–2 are prerequisites.

## Grill decisions (2026-08-30)

- **Stage A scope [locked]:** all of the above — P0 fixes, contract v2, push pipeline, and every hygiene item (steps 1–4), in one pass. Independently shippable; draft PR with focused tests.
- Provider scope stays Codex/Claude/Cursor; no new drivers in this effort.
- Contract v2 is additive (optional `windowKey`/`scope`/`fetchedAt`/`retryAfterSeconds`); `window` remains the display label so existing clients keep rendering.
- Executed by Codex gpt-5.6-sol agents (high reasoning) orchestrated by Fable 5; commits on the working branch, draft PR per stage.
