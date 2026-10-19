# Load balancing integration research

Research date: September 8, 2026. This is a source review and proposed integration plan; no runtime implementation or live verification is included.

The subsequent environment-placement implementation and its verification boundaries are documented in [the implementation evidence](load-balancing-evidence/README.md).

The best starting point is t3code #9895: opt-in placement of new threads across environments. Port its small resource sampler and placement policy, adapting eligibility and draft state to Pathway. Keep automatic recovery from exhausted subscriptions as a separate server feature using Pathway's existing v2 session transitions and context handoff.

## The upstream PRs

| PR                                                                                                                               | Verified state           | Purpose                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#9895: balance new threads across connected machines](https://github.com/pingdotgg/t3code/pull/9895)                            | Merged September 6, 2026 | Chooses a connected environment using CPU, available memory, and user preferences. Most likely the requested PR.                                                             |
| [#10300: pool subscription limits per provider across accounts and environments](https://github.com/pingdotgg/t3code/pull/10300) | Merged September 6, 2026 | Aggregates subscription usage for display. It does not route work or switch accounts.                                                                                        |
| [#9181: switch accounts mid-thread and track usage limits](https://github.com/pingdotgg/t3code/pull/9181)                        | Open at research time    | Proposes manual and automatic account fallback after usage limits, including Claude transcript copying. The closest match if the intended feature was subscription failover. |

Reviewed #9895 at head `61423c5e15777e89375c2be6cb21029c700c8db1`, merged as `420fd76f60433fe05b8d2c76f4fbde430dc49968`; #10300 at `83eaf1b835756ae1d9185af056bad24e554baacd`; and #9181 at `ea8ee31e8e9acbbc5c76632b7792831b58b4d0fb`. GitHub API supplied current state, files, descriptions, and review discussion. Conclusions below distinguish source behavior from recommendations.

## What #9895 actually implements

The server adds an authenticated `server.getHostResources` RPC. Its [HostResources service](https://github.com/pingdotgg/t3code/blob/61423c5e15777e89375c2be6cb21029c700c8db1/apps/server/src/resourceTelemetry/HostResources.ts) samples whole-host CPU over 200 milliseconds and available memory using Linux `MemAvailable`, macOS `vm_stat`, or Windows OS values. A server-lifetime five-second cache shares samples between clients. This is a small on-demand snapshot, without process trees or continuous polling.

The [pure selector](https://github.com/pingdotgg/t3code/blob/61423c5e15777e89375c2be6cb21029c700c8db1/packages/client-runtime/src/load-balancing.ts) computes:

```text
score = preference weight × CPU count × idle CPU fraction × available memory fraction
```

It rejects missing or stale measurements, unknown CPU utilization, CPU utilization of at least 95%, available memory of at most 5%, and nonpositive weights. It uses client receipt timestamps where available to avoid differences between machine clocks. Samples older than 15 seconds are excluded. The highest score wins; equal scores retain the first candidate. This is best-effort placement, not round-robin distribution, capacity reservation, or a global scheduler.

The [client hook](https://github.com/pingdotgg/t3code/blob/61423c5e15777e89375c2be6cb21029c700c8db1/apps/web/src/hooks/useLoadBalancedEnvironment.ts) gathers resource queries for unresolved automatic drafts. Each RPC has a five-second client deadline. The composer keeps the result stable, exposes an explicit recheck, and pins manual environment/branch/worktree choices. Attachments constrain movement because uploaded assets belong to their environment. Project remapping clears the old automatic selection. No eligible result requires manual selection. Settings default off and weights are stored per client. Existing threads and native mobile retain their previous routing.

The PR description explicitly leaves native macOS/Windows resource sampling unverified. Its older automated summary says the setting defaults on; the final human description and merged revision say off. Use the final revision.

## What Pathway already has

| Existing code                                                                                                                                                                                             | Integration value                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Project grouping](../../packages/client-runtime/src/state/projectGrouping.ts) and [composer environment selection](../../apps/web/src/components/ChatView.tsx)                                           | Already map logical projects to environment-local project IDs.                                                                                                            |
| [Provider usage contract](../../packages/contracts/src/providerUsage.ts) and [ProviderUsageService](../../apps/server/src/providerUsage/ProviderUsageService.ts)                                          | Already expose instance-scoped quota windows, status, staleness, reset times, and optional hashed account identity. Usage drivers are Codex, Claude, and Cursor.          |
| [Account collector](../../apps/web/src/components/usage/providerUsageAccounts.ts)                                                                                                                         | Already deduplicates known accounts across environments by driver plus account key and selects a preferred snapshot. Unknown identities stay environment/instance-scoped. |
| [Resource telemetry contract](../../packages/contracts/src/resourceTelemetry.ts)                                                                                                                          | Existing diagnostics focus on Pathway processes; do not substitute their CPU/RSS totals for whole-host headroom.                                                          |
| [ThreadLaunchService](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts)                                                                                                                      | Existing environment-local launch, workspace preparation, and command receipts.                                                                                           |
| [ProviderSessionTransitionPolicy](../../apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts) and [ContextHandoffService](../../apps/server/src/orchestration-v2/ContextHandoffService.ts) | Already distinguish session reuse, compatible restart/resume, and fresh sessions with context handoff.                                                                    |
| [Usage-limit recovery](../../packages/client-runtime/src/state/usageLimitRecovery.ts) and [ChatView recovery action](../../apps/web/src/components/ChatView.tsx)                                          | Already recognize usage failures and let users continue in the same chat with another model through a recovery prompt.                                                    |
| [Native thread creation](../../apps/pathway-ios/Pathway/shared/datalayer/PathwayAgentThreadCreationModel.swift)                                                                                           | Separate Swift launch implementation requiring explicit parity work. This checkout's mobile app is native Swift, despite the older React Native description in AGENTS.md. |

No load-balancing implementation was found in this checkout. Subscription identity and recovery foundations are already present, so copying either upstream feature wholesale would duplicate or replace useful Pathway behavior.

## Recommended first implementation

### 1. Resolve a concrete launch destination

Return a placement containing `environmentId`, `projectId`, and the target environment's `modelSelection`, plus a reason for selection or unavailability. Keep the pure selection logic in `packages/client-runtime`, separate from React. The composer and other new-thread entry points should call the same resolution path before uploads, worktree creation, and launch.

Only consider connected environments the signed-in user can use, with an eligible binding for the project, an available workspace, and an enabled/authenticated provider supporting the requested model and options. Scope cloud projects by company and their explicit bindings. Repository grouping is useful discovery input; manually putting unrelated projects in one sidebar group must not silently authorize routing between them. Rootless projects need explicit placement support and should retain their current destination initially.

Upstream's composer eligibility compares `provider.instanceId` with the current instance ID on every candidate environment. Pathway instance IDs are environment-local. Resolve an eligible instance on each environment, matching the requested driver/model/capabilities. If the user explicitly chose an account, preserve that account through its known account identity; automatically choosing a different account requires a separate opt-in. With unknown account identity, retain the explicit selection rather than infer equivalence from display names or matching IDs.

### 2. Reuse the small sampler, harden draft lifecycle

Adapt the upstream sampler, RPC schema, authorization entry, and short-lived shared query cache. Keep measurements on demand and query candidates concurrently with a bounded deadline. Older servers without the RPC remain manually selectable. Distinguish an unavailable measurement from a busy machine in the result.

Persist selection mode and the full resolved destination with the draft. Changing project, provider/account constraints, or model invalidates an automatic result. Once uploaded assets, a selected branch, or a worktree bind the draft to a machine, keep it pinned. An explicit return to Auto must account for those bindings. Revalidate destination eligibility at send time without continuously moving a healthy draft as CPU readings fluctuate.

Resolve before dispatch and keep the same destination and command ID when retrying an uncertain launch response. Receipts are local to each environment: sending the same command ID to a second environment after a network timeout can still create duplicate work. Changing destination after dispatch requires establishing the first launch's outcome.

Use the upstream score as an initial heuristic. A stable draft-based tie breaker can prevent identical candidates always favoring list order. It still provides no shared reservation across clients, and CPU headroom is not a prediction of agent throughput. Add active-run pressure or a coordinator only if measurements demonstrate a placement problem.

### 3. Make placement visible and reversible

Expose Auto in the new-thread environment picker and Prefer / Normal / Less often / Manual only in Connections. Default off. Display the chosen environment in the picker details and resulting thread, with a short reason such as available resources or manual choice. With one eligible machine, explain that balancing needs another eligible destination. When none qualify, retain the draft and offer a manual choice.

For the smallest port, use existing client-settings persistence and clearly preserve upstream's per-client preference scope. All access remains behind Pathway Cloud sign-in. Account-wide preference synchronization can be a separate improvement using authenticated cloud policy storage; do not imply the settings already synchronize between devices.

## Subscription-aware routing and recovery

After environment placement is stable, allow explicit pools of provider instances for new work. Evaluate quota per distinct account, then resolve a usable instance and environment for that account. Logging into one subscription on three machines does not create three allowances. Move the reusable account collector into shared runtime code and retain all account-to-environment bindings: its current display-oriented result keeps only one representative, which is insufficient for routing.

Use applicable quota windows, including model scope, with missing and stale values represented as unknown. Avoid an exhausted account before launch when there is a known eligible alternative. Do not use #10300's pooled mean as routing capacity: different subscription plans do not provide comparable absolute capacity, and a healthy average can conceal an exhausted member. Pathway's hashed account identity is preferable to importing email-based grouping.

For mid-thread failover, use #9181 as behavioral reference rather than porting its legacy reactor. Its source uses an in-memory bounded retry set and re-dispatches the failed user message. Pathway should instead persist a recovery decision keyed by source run, record the chosen account, and execute it once through v2 commands/outbox handling after the failed run has settled. Cancel recovery if the user stops the thread, advances it, or changes its selection. Handle all accounts exhausted with the existing wait/recovery experience and a known reset time where available.

Preserve the current environment and workspace during account recovery. Reuse native continuation only when `ProviderSessionTransitionPolicy` permits it; otherwise use the existing context handoff and disclose that it starts a fresh provider session. A handoff summary is not a byte-for-byte native transcript. Do not broaden all Claude continuation keys or copy session directories as an initial implementation. Existing Claude homes intentionally have distinct continuation identities.

Use a continuation instruction that preserves completed work, as Pathway already does, rather than blindly repeating the original request after tools may have changed files or performed external actions. Automatic recovery must be opt-in and bounded across the recovery chain. Transient throttling, exhausted subscription quota, authentication failures, and provider outages need distinct decisions; the existing broad UI failure recognizer alone is insufficient authority for automatic account switching.

Codex and Claude are the initial account-recovery candidates. Cursor has quota reporting but needs independent recovery classification and adapter verification. Grok and OpenCode can participate in environment placement when provider/model eligibility is known; their missing normalized subscription telemetry must remain unknown. Apply the same capability-driven rule to additional registered drivers.

## Delivery and verification

Deliver separate changes for: host-resource RPC; automatic new-thread placement and controls; optional account-aware placement; optional durable account recovery. Pooled usage presentation is independent and lower priority because Pathway already deduplicates accounts.

| Surface / boundary                        | Required treatment                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web and Electron                          | Shared placement behavior; verify browser and desktop settings hydration and persistence.                                                                                                |
| Native iOS                                | Implement a small Swift adapter/selector with shared JSON conformance fixtures; a TypeScript module alone cannot provide parity. Include Auto, manual override, and destination display. |
| Chat, sidebar, palette, keybinding        | All applicable new-thread paths use the same placement boundary. Explicit branch/worktree/PR creation stays pinned.                                                                      |
| Background jobs and issue/mail automation | Preserve their explicit environment assignments initially. Client-side draft placement does not balance unattended jobs.                                                                 |
| Direct remote, relay, tunnel              | Use the existing authenticated environment RPC, without additional ports or hardcoded origins. Test partial connectivity and mixed server versions.                                      |
| Multiple clients                          | Placement is advisory; launch retry stays pinned and durable account recovery runs once on the owning environment.                                                                       |
| Reverse actions and docs                  | Auto off, Manual only, explicit destination, recheck, and recovery cancellation must work. Add shipped behavior to user docs when implemented.                                           |

Focused tests should cover resource parsing and cache deduplication; unequal environment instance IDs; model/account eligibility; stale and missing measurements; account deduplication without losing destination bindings; manual pins and attachments; project/model changes; target disconnects; ambiguous launch responses; and durable recovery across duplicate events/restart/cancellation. Use controlled clocks and worker drains. Do not run the repository-wide suite.

After implementation, request the repository-required permission for one integrated client verification pass. No browser, simulator, provider invocation, deployment, or production data mutation was performed for this research.
