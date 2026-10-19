# Pathway provider allowance budgets

Status: implemented in the worktree preview; native build verification is pending. This is a Pathway-wide requirement raised during the [orchestrator interview](pathway-ai-orchestrators.md). Agent visibility, durable cloud allocations, admission checks, running-turn interruption, sourced numeric chat allocations, one-time scheduled resumption, and web/native controls are implemented. Signed-in checks cover coordinator and ordinary-thread manual pause/resume, sourced coordinator allocation, a one-time scheduled allocation, and automatic continuation of an interrupted worker on its original thread. Physical-device and production remote/tunnel checks remain outstanding.

## Requested behavior

Ordinary agents and orchestrators can inspect provider account allowance. A user can assign work conversationally with a limit such as “use 10% of the allowance tonight, then stop and wait until morning.” Pathway monitors the allowance, stops new dispatches as the threshold approaches, and requests interruption of managed active turns when the observed limit is reached. Queued work and partial results are retained. The percentage is user-selected; 10% is an example, not a product default.

Orchestrator model fallbacks are ordered by a draggable list, with reasoning effort and supported performance options per choice. Allowance controls must remain meaningful when work is delegated, moves between environments, or selects another provider account.

## Known constraints

- `packages/contracts/src/providerUsage.ts` currently models Codex, Claude, and Cursor account quota snapshots, potentially including multiple windows, used percentage, reset times, fetch times, stale status, and a hashed account identity for cross-environment grouping.
- Snapshot fields are optional; unsupported, unauthenticated, stale, and failed readings must remain distinguishable from available allowance.
- Account quota, task token usage, context occupancy, and API-equivalent costs are different measurements. They cannot be silently substituted for one another.
- Account-wide changes alone do not prove how much one task consumed when other activity shares that account.
- Provider reporting delay and already-running model calls may prevent an exact percentage cutoff. The product must distinguish an enforceable dispatch limit from a guaranteed provider-side quota ceiling.
- Current healthy snapshots are cached for five minutes. Refresh ticks run every minute while subscribed and stop when the last subscriber leaves. Autonomous enforcement needs a backend-owned monitoring lifecycle. Force refresh must still respect provider throttling.
- Codex also provides pushed limit updates; each limit's freshness matters because updates can be partial. Only Codex currently populates the cross-environment account identity. Claude and Cursor account linking cannot be inferred from their provider instance IDs.
- `pathway_provider_allowance` now exposes account snapshots to ordinary agents and delegated workers. It is a read tool and does not enforce a budget. Coordinators also receive the reasoning host’s current allowance when granted environment visibility. Existing client APIs are `serverGetProviderUsage` and `serverSubscribeProviderUsage`; the usage service and provider adapters are the starting points for exposure and monitoring.
- A backend runtime now supervises cloud assignment guards independently of client subscriptions. It checks admission before managed turns, requests interruption when the observed limit is reached or readings become unreliable, and retains the queued request when held before launch. Native child supervision continues after the root reply. Local lineage, independent thread creation, remote dispatch, scheduled workers, and collaboration groups inherit the originating guards. Destination accounts require their own authorized allocation. Coordination decisions recheck allocation revisions at commit.
- Existing scheduled tasks are recurring and use the environment's local timezone. A durable one-shot resume in the user's selected timezone, with an explicit missed-time policy, is not already provided by those primitives.

Code references: [usage snapshots](../../packages/contracts/src/providerUsage.ts), [usage service](../../apps/server/src/providerUsage/ProviderUsageService.ts), [account grouping](../../apps/web/src/components/usage/providerUsageAccounts.ts), and [scheduled task contracts](../../packages/contracts/src/scheduledTask.ts).

## Accepted behavior

1. Budgets use percentage points of a selected full allowance window. In the example, 60% remaining becomes 50% remaining. Display the selected account, window, interpretation, and baseline when the budget is set. Other provider limits still apply.
2. Use a conservative account-wide guard: all observed consumption counts toward its threshold, including unrelated work. Do not present the change as exact consumption attributable to the assignment.
3. The coordinator, delegated threads, and subagents share the assignment's guard across environments. Model fallback to another account requires a configured budget for that destination; it cannot bypass the limit.
4. Stop admitting work as the threshold approaches. At the observed threshold, request interruption of managed active turns and preserve partial work. Pause budget-controlled work if reliable readings become unavailable. The UI and tools must explain that delayed readings and in-flight work can overshoot the threshold.
5. “Wait until morning” waits for the user unless automatic resumption is explicitly specified. Scheduled resumption uses the user's selected timezone and an explicit allowance allocation. A quota reset does not renew an assignment's authorization.

These decisions are recorded in the [allowance ADR](../adr/0037-allowance-budgets-use-observed-account-consumption.md). Enforcement belongs in the runtime as well as an agent-visible usage tool.

## Implementation requirements

- Persist each assignment's guard, selected account/window, observed baseline and reset boundary, authorized allocation, affected work, and pause/resume state. Preserve these through environment handover, process restart, and model fallback.
- Provide shared agent tools to inspect allowance and manage authorized budgets. Return source, per-window freshness, availability, and account identity where known. Budget changes follow the actor's permissions.
- Supervise allowance on the backend independently of connected clients. Reuse provider fetch/push data and throttle handling. Dispatch admission and interruption controls must be effective even if an agent ignores its conversational instructions.
- Associate each descendant with the originating guard. Apply every relevant guard before dispatch, so parallel assignments and fallback accounts cannot each independently treat the same allocation as unused.
- Make account identity reliable before promising shared-account enforcement across environments. Where account identity or quota telemetry cannot be established, expose the limitation and pause affected allowance-controlled work. Do not infer account identity solely from matching provider names.
- Keep allowance windows and reset generations distinct. A reset or late snapshot must not erase already-accounted consumption or renew authorization. Detailed accounting and near-threshold margins require focused provider fixtures during implementation.
- Make explicit scheduled resumption durable. Select and document a missed-schedule policy consistent with the user's time and allocation instruction; avoid an indefinite recurring schedule for a one-off instruction.

## Acceptance criteria

- A user-selected ten-point example begins at 60% remaining and targets 50%; there is no baked-in 10% default.
- Every ordinary agent and orchestrator with permission can inspect supported provider allowance, including freshness and unsupported states.
- Managed descendants share the same guard across environments. A fallback account without an authorized allocation cannot continue the work.
- Unrelated account consumption counts conservatively and is described as account-wide consumption.
- Threshold, stale-reading, provider-throttle, reset, reconnect, and process-restart scenarios preserve the limit and queued work. Interruption uncertainty and observed overshoot remain visible.
- Monitoring continues when all clients close, provided an eligible execution environment remains online.
- A request to wait remains paused until the user resumes it; explicit scheduled resumption uses the configured timezone and allocation.
- Web, desktop, and mobile present consistent budget state and controls, with permission enforcement in the server/cloud path.
