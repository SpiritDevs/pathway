import { useEffect, useMemo, useRef, useState } from "react";
import {
  EnvironmentId,
  type ProviderInstanceId,
  type ProviderUsageDriver,
} from "@spiritdevs/contracts";
import {
  allocateProviderAllowance,
  allowanceAllocationProgress,
  allowanceScopeKey,
  allowanceWindowKey,
  budgetAdmission,
  type ProviderAllowanceBudget,
  type ProviderAllowanceScope,
} from "@spiritdevs/contracts/providerAllowanceBudget";
import type { Value } from "convex/values";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "../contacts/businessToolsCloud";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { randomUUID } from "../../lib/utils";
import { Progress } from "../ui/progress";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { AllowanceProviderTarget } from "./ProviderAllowanceDialog";
import { calendarInstantAt } from "../calendar/calendarGrid.logic";

type WindowChoice = {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  provider: ProviderUsageDriver;
  windowKey: string;
  label: string;
  authorizedPercent: number;
};
const field =
  "h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The same account allocation controls serve conversations and ordinary agent threads. */
export function AllowanceBudgets({
  companyId,
  scopes,
  title,
  target,
}: {
  companyId: string;
  scopes: readonly ProviderAllowanceScope[];
  title: string;
  target: AllowanceProviderTarget;
}) {
  const cloud = useBusinessToolsCloud();
  const now = Date.parse(useNowMinute());
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState<string>(target.environmentId);
  const environment = environments.find((e) => e.environmentId === environmentId);
  const usageTarget = useMemo(
    () =>
      environment
        ? serverEnvironment.providerUsageLive({
            environmentId: environment.environmentId,
            input: {},
          })
        : null,
    [environment?.environmentId],
  );
  const usage = useEnvironmentQuery(usageTarget);
  const rows = useBusinessToolsQuery<ProviderAllowanceBudget[]>(
    cloud.client,
    cloud.accountID,
    "providerAllowanceBudgets:list",
    { companyId },
  );
  const keys = new Set(scopes.map(allowanceScopeKey));
  // Every budget on this work participates in admission, even after an account changes.
  const budgets =
    rows.value?.filter((b) => b.scopes.some((s) => keys.has(allowanceScopeKey(s)))) ?? [];
  const [editing, setEditing] = useState<ProviderAllowanceBudget | "new" | null>(null);
  const [choices, setChoices] = useState<WindowChoice[]>([]);
  const [windowKey, setWindowKey] = useState("");
  const [percent, setPercent] = useState("");
  const [pending, setPending] = useState(false);
  const [resumeAt, setResumeAt] = useState("");
  const [resumeZone, setResumeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [error, setError] = useState<string>();
  const requestID = useRef(randomUUID());
  const generation = useRef(0);
  const scopeKey = JSON.stringify(scopes);
  useEffect(() => {
    generation.current++;
    setEditing(null);
    setChoices([]);
    setError(undefined);
    setPending(false);
    setResumeAt("");
    return () => {
      generation.current++;
    };
  }, [companyId, cloud.accountID, scopeKey]);
  const refreshUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const windows = (usage.data ?? []).flatMap((snapshot) =>
    snapshot.limits.map((limit) => ({
      snapshot,
      limit,
      key: JSON.stringify([snapshot.instanceId, allowanceWindowKey(limit)]),
    })),
  );
  const selected = windowKey
    ? windows.find((w) => w.key === windowKey)
    : environmentId === target.environmentId
      ? windows.find(
          (w) =>
            w.snapshot.instanceId === target.instanceId && w.snapshot.provider === target.provider,
        )
      : undefined;
  const preview = selected
    ? allocateProviderAllowance(
        selected.snapshot,
        allowanceWindowKey(selected.limit),
        Number(percent),
        Date.now(),
      )
    : null;
  const act = async (operation: () => Promise<unknown>) => {
    const version = generation.current;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      if (generation.current === version)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === version) setPending(false);
    }
  };
  const save = async () => {
    const version = generation.current;
    const allocations = [];
    for (const choice of choices) {
      const result = await refreshUsage({
        environmentId: choice.environmentId,
        input: { instanceId: choice.instanceId, provider: choice.provider, forceRefresh: true },
      });
      if (result._tag !== "Success")
        throw new Error(`Could not refresh ${choice.label}. The allowance has not changed.`);
      allocations.push({
        snapshot: result.value,
        windowKey: choice.windowKey,
        authorizedPercent: choice.authorizedPercent,
      });
    }
    if (generation.current !== version) return;
    const args = {
      companyId,
      budgetId: editing === "new" ? requestID.current : editing!.id,
      allocations,
    } as unknown as Record<string, Value>;
    if (editing === "new")
      await cloud.request("providerAllowanceBudgets:create", {
        ...args,
        title,
        scopes: scopes.map((s) => ({ ...s })),
      });
    else if (resumeAt) {
      const [date, time] = resumeAt.split("T");
      const [hours, minutes] = (time ?? "").split(":").map(Number);
      if (!date || hours === undefined || minutes === undefined)
        throw new Error("Choose a resume date and time.");
      const at = calendarInstantAt(date, hours * 60 + minutes, resumeZone);
      if (!Number.isFinite(at) || at <= Date.now()) throw new Error("Choose a future resume time.");
      await cloud.request("providerAllowanceBudgets:scheduleResume", {
        ...args,
        revision: editing!.revision,
        at,
        timeZone: resumeZone,
      });
    } else
      await cloud.request("providerAllowanceBudgets:resume", {
        ...args,
        revision: editing!.revision,
      });
    if (generation.current === version) {
      setEditing(null);
      setChoices([]);
      setResumeAt("");
      requestID.current = randomUUID();
    }
  };
  return (
    <section className="space-y-4 border-t pt-5" aria-label="Provider allowance budgets">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">Provider allowance</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !scopes.length}
          onClick={() => {
            setEditing("new");
            setEnvironmentId(target.environmentId);
            setWindowKey("");
            setPercent("");
            setChoices([]);
            setResumeAt("");
            requestID.current = randomUUID();
          }}
        >
          Set allowance
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Allocate percentage points of a full account window. For example, 10 points takes 60%
        remaining to 50%. All activity on that account counts. Delayed readings can allow overshoot.
      </p>
      <p className="text-sm text-muted-foreground">
        All allowances for this work are shown, including previous accounts. Start with{" "}
        {target.displayName} and add windows for any fallback accounts to the same allocation.
      </p>
      {budgets.map((budget) => (
        <div key={budget.id} className="space-y-3 rounded-xl border p-4">
          <div className="flex justify-between gap-3 text-sm">
            <span className="font-medium">{budget.title}</span>
            <span className="capitalize text-muted-foreground">
              {budget.status === "closed" ? "Limit removed" : budget.status}
            </span>
          </div>
          {budget.scheduledResume && (
            <div className="space-y-2 text-xs">
              <p>
                Resume once:{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: budget.scheduledResume.timeZone,
                }).format(budget.scheduledResume.at)}{" "}
                · {budget.scheduledResume.timeZone}
              </p>
              <ul className="space-y-1">
                {budget.scheduledResume.allocations.map((allocation) => (
                  <li
                    key={`${allocation.provider}:${allocation.accountKey}:${allocation.windowKey}`}
                  >
                    {allocation.provider} · {allocation.windowLabel ?? "Account window"} ·{" "}
                    {allocation.authorizedPercent} new percentage points
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                If fresh account readings are unavailable for more than an hour after this time,
                work stays held.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    cloud.request("providerAllowanceBudgets:cancelScheduledResume", {
                      companyId,
                      budgetId: budget.id,
                    }),
                  )
                }
              >
                Cancel scheduled resume
              </Button>
            </div>
          )}
          {budget.allocations.map((a) => {
            const progress = allowanceAllocationProgress(a);
            const admission = budgetAdmission({ status: budget.status, allocations: [a] }, a, now);
            return (
              <div
                key={JSON.stringify([a.provider, a.accountKey, a.windowKey])}
                className="space-y-1 text-xs"
              >
                <div className="flex justify-between gap-3">
                  <span>
                    {a.provider} · {a.windowLabel}
                  </span>
                  <span>
                    {progress.consumedPercent.toFixed(1)} / {a.authorizedPercent} points
                  </span>
                </div>
                <Progress
                  value={progress.consumedPercent / a.authorizedPercent}
                  aria-label={`${a.windowLabel} allowance consumed`}
                />
                <p className="text-muted-foreground">
                  {(100 - a.baselineUsedPercent).toFixed(1)}% →{" "}
                  {progress.targetRemainingPercent.toFixed(1)}% remaining ·{" "}
                  {budget.status === "closed"
                    ? "Limit removed"
                    : budget.status === "paused"
                      ? "Allocation retained"
                      : admission.canStart
                        ? "Available"
                        : admission.detail}
                </p>
                {progress.overshootPercent > 0 && (
                  <p className="text-amber-600 dark:text-amber-400">
                    Observed overshoot: {progress.overshootPercent.toFixed(1)} points.
                  </p>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            {budget.status === "active" && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    cloud.request("providerAllowanceBudgets:pause", {
                      companyId,
                      budgetId: budget.id,
                    }),
                  )
                }
              >
                Pause work
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                setEditing(budget);
                setEnvironmentId(target.environmentId);
                setWindowKey("");
                setPercent("");
                setChoices([]);
                setResumeAt("");
              }}
            >
              Authorize new allocation
            </Button>
            {budget.status !== "closed" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    cloud.request("providerAllowanceBudgets:close", {
                      companyId,
                      budgetId: budget.id,
                    }),
                  )
                }
              >
                Remove limit and resume
              </Button>
            )}
          </div>
        </div>
      ))}
      {editing && (
        <div className="space-y-4 rounded-xl border bg-muted/20 p-4 sm:p-5">
          <p className="text-sm font-semibold">
            {editing === "new" ? "New allocation" : "Resume with a new allocation"}
          </p>
          <p className="text-xs text-muted-foreground">
            This applies to the selected conversation or thread and its delegated work. Each
            fallback account needs its own allocation. A reset does not renew it.
          </p>
          {editing !== "new" && (
            <p className="rounded-lg border p-3 text-sm text-muted-foreground">
              Renew every account you want to include; authorizing replaces the whole allocation.
              Pause and remove actions also affect the whole allowance.
            </p>
          )}
          <label className="grid gap-1 text-xs">
            Environment
            <select
              className={field}
              value={environment?.environmentId ?? ""}
              onChange={(e) => {
                setEnvironmentId(e.target.value);
                setWindowKey("");
              }}
            >
              {environments.map((e) => (
                <option key={e.environmentId} value={e.environmentId}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Account window
            <select
              className={field}
              value={selected?.key ?? ""}
              onChange={(e) => setWindowKey(e.target.value)}
            >
              <option value="">Choose an account window</option>
              {windows.map((w) => (
                <option key={w.key} value={w.key}>
                  {environment?.serverConfig?.providers.find(
                    (p) => p.instanceId === w.snapshot.instanceId,
                  )?.displayName ?? w.snapshot.instanceId}{" "}
                  · {w.limit.window} ·{" "}
                  {w.limit.usedPercent === undefined
                    ? "Unknown"
                    : `${(100 - w.limit.usedPercent).toFixed(1)}% remaining`}
                </option>
              ))}
            </select>
          </label>
          {!windows.length && (
            <p className="text-xs text-muted-foreground">
              {usage.error ?? "Waiting for supported allowance readings from this environment."}
            </p>
          )}
          <label className="grid gap-1 text-xs">
            Allowance in percentage points
            <Input
              type="number"
              min={0.1}
              max={100}
              step="any"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="Choose an allowance"
            />
          </label>
          {preview?.allocation && (
            <p className="text-xs text-muted-foreground">
              {(100 - preview.allocation.baselineUsedPercent).toFixed(1)}% →{" "}
              {allowanceAllocationProgress(preview.allocation).targetRemainingPercent.toFixed(1)}%
              remaining. Readings are checked again when you authorize.
            </p>
          )}
          {preview?.error && percent && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{preview.error}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!preview?.allocation || !environment || choices.length >= 8}
              onClick={() => {
                if (!selected || !environment) return;
                const next = {
                  environmentId: environment.environmentId,
                  instanceId: selected.snapshot.instanceId,
                  provider: selected.snapshot.provider,
                  windowKey: allowanceWindowKey(selected.limit),
                  label: `${selected.snapshot.instanceId} · ${selected.limit.window}`,
                  authorizedPercent: Number(percent),
                };
                setChoices((prior) => [
                  ...prior.filter(
                    (c) =>
                      c.instanceId !== next.instanceId ||
                      c.environmentId !== next.environmentId ||
                      c.windowKey !== next.windowKey,
                  ),
                  next,
                ]);
              }}
            >
              Add account window
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !selected || !environment}
              onClick={() =>
                void act(async () => {
                  if (!selected || !environment) return;
                  const r = await refreshUsage({
                    environmentId: environment.environmentId,
                    input: {
                      instanceId: selected.snapshot.instanceId,
                      provider: selected.snapshot.provider,
                      forceRefresh: true,
                    },
                  });
                  if (r._tag !== "Success")
                    throw new Error("The provider could not refresh its allowance.");
                })
              }
            >
              Refresh reading
            </Button>
          </div>
          {choices.map((choice, i) => (
            <div
              key={JSON.stringify([choice.environmentId, choice.instanceId, choice.windowKey])}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span>
                {choice.label}: {choice.authorizedPercent} points
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setChoices((old) => old.filter((_, index) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          {editing !== "new" && editing.status !== "closed" && (
            <div className="space-y-2 border-t pt-3">
              <label className="grid gap-1 text-xs">
                Resume at (optional)
                <Input
                  type="datetime-local"
                  value={resumeAt}
                  onChange={(e) => setResumeAt(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs">
                Timezone
                <Input
                  value={resumeZone}
                  onChange={(e) => setResumeZone(e.target.value)}
                  placeholder="Australia/Sydney"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Choosing a time pauses work now and authorizes this new allowance once, from fresh
                readings at that time. If the resume is missed by over one hour, work remains held.
                Leave the time empty to authorize immediately.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button disabled={pending || !choices.length} onClick={() => void act(save)}>
              {pending
                ? "Saving…"
                : resumeAt
                  ? "Pause and schedule allocation"
                  : "Authorize allocation"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(error || rows.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? rows.error}
        </p>
      )}
    </section>
  );
}
