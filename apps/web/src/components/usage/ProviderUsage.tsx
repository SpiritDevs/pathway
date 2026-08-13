import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderUsageDriver,
  type ServerProvider,
  type ServerProviderUsageSnapshot,
} from "@t3tools/contracts";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS } from "../chat/threadDetailsPanelStyles";
import {
  deriveProviderUsageLimits,
  selectPrimaryProviderUsageLimit,
  shouldCollapseProviderUsage,
  type ProviderUsageDisplayLimit,
} from "./providerUsageDisplay";

const SUPPORTED_PROVIDERS = new Set<ProviderUsageDriver>(["codex", "claudeAgent", "cursor"]);
const SLOW_REFRESH_SPIN_CLASS = "animate-spin [animation-duration:2s] motion-reduce:animate-none";

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return SUPPORTED_PROVIDERS.has(driver as ProviderUsageDriver);
}

function providerName(provider: ProviderUsageDriver): string {
  return PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(provider)] ?? provider;
}

interface ProviderUsageRefreshTarget {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderUsageDriver;
  readonly label: string;
}

function providerUsageSnapshotKey(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): string {
  return `${environmentId}:${instanceId}`;
}

function refreshFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The provider did not return updated usage.";
}

function useForcedProviderUsageRefresh(
  environmentId: EnvironmentId,
  targets: ReadonlyArray<ProviderUsageRefreshTarget>,
) {
  const refreshUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const [refreshedSnapshots, setRefreshedSnapshots] = useState<
    ReadonlyMap<string, ServerProviderUsageSnapshot>
  >(() => new Map());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current || targets.length === 0) return;
    inFlightRef.current = true;
    setIsRefreshing(true);
    const failed: Array<{ readonly target: ProviderUsageRefreshTarget; readonly error: unknown }> =
      [];
    try {
      await Promise.all(
        targets.map(async (target) => {
          const result = await refreshUsage({
            environmentId,
            input: {
              instanceId: target.instanceId,
              provider: target.provider,
              forceRefresh: true,
            },
          });
          if (result._tag === "Success") {
            setRefreshedSnapshots((current) => {
              const next = new Map(current);
              next.set(providerUsageSnapshotKey(environmentId, target.instanceId), result.value);
              return next;
            });
          } else if (!isAtomCommandInterrupted(result)) {
            failed.push({ target, error: squashAtomCommandFailure(result) });
          }
        }),
      );

      if (failed.length > 0) {
        const failedLabels = failed.map(({ target }) => target.label).join(", ");
        const allFailed = failed.length === targets.length;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: allFailed ? "Couldn’t refresh usage" : "Some usage couldn’t be refreshed",
            description:
              targets.length === 1
                ? refreshFailureMessage(failed[0]?.error)
                : `Couldn’t refresh ${failedLabels}.`,
          }),
        );
      }
    } finally {
      inFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [environmentId, refreshUsage, targets]);

  return { isRefreshing, refresh, refreshedSnapshots };
}

function usageSectionHeading({
  id,
  refreshDisabled,
  refreshing,
  onRefresh,
}: {
  readonly id?: string;
  readonly refreshDisabled: boolean;
  readonly refreshing: boolean;
  readonly onRefresh: () => Promise<void>;
}) {
  const handleRefreshClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onRefresh();
  };

  return (
    <div className="flex min-h-6 items-center justify-between gap-2 px-3.5 pb-1 pt-3">
      <h3 id={id} className="text-[11px] font-medium text-muted-foreground">
        Usage
      </h3>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-keep-action-card-open
              aria-label="Refresh usage"
              aria-busy={refreshing}
              disabled={refreshDisabled || refreshing}
              onClick={handleRefreshClick}
              className="pointer-events-none -my-1 -mr-1 size-6 opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/usage:pointer-events-auto group-hover/usage:opacity-100 group-focus-within/usage:pointer-events-auto group-focus-within/usage:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 motion-reduce:transition-none"
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  refreshing && "text-foreground",
                  refreshing && SLOW_REFRESH_SPIN_CLASS,
                )}
                aria-hidden="true"
              />
            </Button>
          }
        />
        <TooltipPopup side="top">Refresh usage</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function useProviderUsage(input: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  provider: ProviderUsageDriver;
  enabled: boolean;
  forceRefresh?: boolean;
}): EnvironmentQueryView<ServerProviderUsageSnapshot> {
  const target = useMemo(
    () =>
      input.enabled
        ? serverEnvironment.providerUsage({
            environmentId: input.environmentId,
            input: {
              instanceId: input.instanceId,
              provider: input.provider,
              ...(input.forceRefresh ? { forceRefresh: true } : {}),
            },
          })
        : null,
    [input.enabled, input.environmentId, input.forceRefresh, input.instanceId, input.provider],
  );
  return useEnvironmentQuery(target);
}

const TONE_CLASS_NAME: Record<ProviderUsageDisplayLimit["tone"], string> = {
  healthy: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

function UsageLimitRow({
  limit,
  compact = false,
  resetInline = false,
}: {
  limit: ProviderUsageDisplayLimit;
  compact?: boolean;
  resetInline?: boolean;
}) {
  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{limit.window}</span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-muted-foreground">
          <span>{limit.remainingLabel}</span>
          {resetInline && limit.resetLabel ? (
            <span className="text-[11px]">{limit.resetLabel}</span>
          ) : null}
        </span>
      </div>
      <div className={cn("h-1.5 overflow-hidden rounded-full bg-muted", compact && "h-1")}>
        <div
          role="progressbar"
          aria-label={`${limit.window} quota remaining`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={limit.remainingPercent}
          className={cn("h-full rounded-full", TONE_CLASS_NAME[limit.tone])}
          style={{ width: `${limit.remainingPercent}%` }}
        />
      </div>
      {!resetInline && limit.resetLabel ? (
        <p className="text-right text-[11px] tabular-nums text-muted-foreground">
          {limit.resetLabel}
        </p>
      ) : null}
    </div>
  );
}

function ProviderUsageDetails({
  snapshot,
  loading,
  error,
  compact = false,
}: {
  snapshot: ServerProviderUsageSnapshot | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  if (loading && snapshot === null) {
    return <p className="text-xs text-muted-foreground">Loading provider usage…</p>;
  }
  if (error && snapshot === null) {
    return (
      <p className="text-xs text-muted-foreground">Usage is unavailable on this environment.</p>
    );
  }
  if (snapshot === null) return null;
  if (snapshot.status !== "ok") {
    return <p className="text-xs leading-relaxed text-muted-foreground">{snapshot.detail}</p>;
  }
  const limits = deriveProviderUsageLimits(snapshot.limits);
  if (limits.length === 0 && snapshot.usageLines.length === 0) {
    return <p className="text-xs text-muted-foreground">No quota data reported yet.</p>;
  }
  return (
    <div className={cn("space-y-3", compact && "space-y-2.5")}>
      {snapshot.stale && snapshot.detail ? (
        <p className="text-xs leading-relaxed text-warning-foreground">{snapshot.detail}</p>
      ) : null}
      {limits.map((limit) => (
        <UsageLimitRow key={limit.window} limit={limit} compact={compact} />
      ))}
      {snapshot.usageLines.length > 0 ? (
        <div className={cn("space-y-1 border-t border-border/70 pt-2.5", compact && "pt-2")}>
          {snapshot.usageLines.map((line) => (
            <div
              key={`${line.label}:${line.value}`}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <span className="text-muted-foreground">{line.label}</span>
              <span className="text-right tabular-nums text-foreground">{line.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EnvironmentProviderUsage({
  environmentId,
  provider,
  enabled,
  displayMode = "card",
  grouped = false,
  refreshedSnapshot,
  parentRefreshing = false,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  enabled: boolean;
  displayMode?: "card" | "panel";
  grouped?: boolean;
  refreshedSnapshot?: ServerProviderUsageSnapshot;
  parentRefreshing?: boolean;
}) {
  const isPanel = displayMode === "panel";
  const [open, setOpen] = useState(false);
  const usageProvider = provider.driver as ProviderUsageDriver;
  const usage = useProviderUsage({
    environmentId,
    instanceId: provider.instanceId,
    provider: usageProvider,
    enabled,
  });
  const displayName = provider.displayName ?? providerName(usageProvider);
  const refreshTargets = useMemo(
    () => [{ instanceId: provider.instanceId, provider: usageProvider, label: displayName }],
    [displayName, provider.instanceId, usageProvider],
  );
  const singleRefresh = useForcedProviderUsageRefresh(environmentId, refreshTargets);
  const snapshot =
    refreshedSnapshot ??
    singleRefresh.refreshedSnapshots.get(
      providerUsageSnapshotKey(environmentId, provider.instanceId),
    ) ??
    usage.data;
  const refreshing = grouped ? parentRefreshing : singleRefresh.isRefreshing;
  const primary = selectPrimaryProviderUsageLimit(snapshot);
  const limits = snapshot?.status === "ok" ? deriveProviderUsageLimits(snapshot.limits) : [];
  const summary =
    primary?.remainingLabel ??
    (usage.isPending
      ? "Loading…"
      : snapshot?.status === "needs-auth"
        ? "Not signed in"
        : snapshot?.status === "error" || usage.error
          ? "Unavailable"
          : "Usage");

  const heading =
    !grouped && isPanel
      ? usageSectionHeading({
          refreshDisabled: !enabled,
          refreshing,
          onRefresh: singleRefresh.refresh,
        })
      : null;

  if (!shouldCollapseProviderUsage(limits)) {
    return (
      <section
        aria-label={`${displayName} provider usage`}
        className={cn(
          !grouped && isPanel && "group/usage",
          !grouped && "border-t",
          !grouped && (isPanel ? "border-border/65" : "border-border/70 py-2"),
        )}
      >
        {grouped ? null : isPanel ? (
          heading
        ) : (
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Usage</p>
        )}
        <div className={isPanel ? "px-2 pb-2.5" : undefined}>
          {primary ? (
            <div className="flex items-start gap-2 px-2 py-1.5">
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={displayName}
                accentColor={provider.accentColor}
                className="mt-0.5 size-4"
                iconClassName="size-4"
              />
              <div className="min-w-0 flex-1">
                {grouped ? (
                  <p className="mb-1 truncate text-xs font-medium text-foreground">{displayName}</p>
                ) : null}
                <UsageLimitRow limit={primary} compact resetInline />
                {snapshot?.status === "ok" && snapshot.usageLines.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-border/70 pt-2">
                    {snapshot.usageLines.map((line) => (
                      <div
                        key={`${line.label}:${line.value}`}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span className="text-muted-foreground">{line.label}</span>
                        <span className="text-right tabular-nums text-foreground">
                          {line.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="px-2 py-1.5">
              <ProviderUsageDetails
                snapshot={snapshot}
                loading={usage.isPending}
                error={usage.error}
                compact
              />
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={`${displayName} provider usage`}
      className={cn(
        !grouped && isPanel && "group/usage",
        !grouped && "border-t",
        !grouped && (isPanel ? "border-border/65" : "border-border/70 py-2"),
      )}
    >
      {grouped ? null : isPanel ? (
        heading
      ) : (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Usage</p>
      )}
      <div className={isPanel ? "px-2 pb-2.5" : undefined}>
        <Collapsible open={open} onOpenChange={setOpen}>
          <button
            type="button"
            data-keep-action-card-open
            aria-expanded={open}
            className={cn(
              isPanel
                ? THREAD_DETAILS_PANEL_DISCLOSURE_ROW_CLASS
                : "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            )}
            onClick={() => setOpen((value) => !value)}
          >
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={displayName}
              accentColor={provider.accentColor}
              className="size-4"
              iconClassName="size-4"
            />
            <span className="min-w-0 flex-1 truncate">{grouped ? displayName : summary}</span>
            {grouped ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {summary}
              </span>
            ) : null}
            {primary?.resetLabel ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {primary.resetLabel}
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
          <CollapsiblePanel>
            <div className="px-2 pt-2 pb-1">
              <ProviderUsageDetails
                snapshot={snapshot}
                loading={usage.isPending}
                error={usage.error}
                compact
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </section>
  );
}

export function EnvironmentProviderUsageList({
  environmentId,
  enabled,
}: {
  environmentId: EnvironmentId;
  enabled: boolean;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const supported = useMemo(
    () =>
      (providers ?? []).filter(
        (provider) =>
          provider.enabled && provider.installed && isProviderUsageDriver(provider.driver),
      ),
    [providers],
  );
  const refreshTargets = useMemo(
    () =>
      supported.map((provider) => ({
        instanceId: provider.instanceId,
        provider: provider.driver as ProviderUsageDriver,
        label: provider.displayName ?? providerName(provider.driver as ProviderUsageDriver),
      })),
    [supported],
  );
  const usageRefresh = useForcedProviderUsageRefresh(environmentId, refreshTargets);

  if (providers !== null && supported.length === 0) return null;

  return (
    <section
      aria-labelledby="new-thread-provider-usage-heading"
      className="group/usage border-t border-border/65"
    >
      {usageSectionHeading({
        id: "new-thread-provider-usage-heading",
        refreshDisabled: !enabled || supported.length === 0,
        refreshing: usageRefresh.isRefreshing,
        onRefresh: usageRefresh.refresh,
      })}
      {providers === null ? (
        <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">Loading provider accounts…</p>
      ) : (
        <div className="divide-y divide-border/70">
          {supported.map((provider) => {
            const refreshedSnapshot = usageRefresh.refreshedSnapshots.get(
              providerUsageSnapshotKey(environmentId, provider.instanceId),
            );
            return (
              <EnvironmentProviderUsage
                key={provider.instanceId}
                environmentId={environmentId}
                provider={provider}
                enabled={enabled}
                displayMode="panel"
                grouped
                {...(refreshedSnapshot === undefined ? {} : { refreshedSnapshot })}
                parentRefreshing={usageRefresh.isRefreshing}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProviderUsageCard({
  environmentId,
  provider,
  refreshedSnapshot,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  refreshedSnapshot?: ServerProviderUsageSnapshot;
}) {
  const usageProvider = provider.driver as ProviderUsageDriver;
  const usage = useProviderUsage({
    environmentId,
    instanceId: provider.instanceId,
    provider: usageProvider,
    enabled: true,
  });
  const snapshot = refreshedSnapshot ?? usage.data;
  const statusLabel = snapshot?.stale
    ? "Last known"
    : snapshot?.status === "needs-auth"
      ? "Not signed in"
      : snapshot?.status === "unsupported"
        ? "Unsupported"
        : snapshot?.status === "error" || usage.error
          ? "Unavailable"
          : snapshot?.planName;
  const statusClassName =
    snapshot?.stale || snapshot?.status === "needs-auth"
      ? "bg-warning/12 text-warning-foreground"
      : snapshot?.status === "error" || usage.error
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60">
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={provider.displayName ?? providerName(usageProvider)}
              accentColor={provider.accentColor}
              className="size-4"
              iconClassName="size-4"
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {provider.displayName ?? providerName(usageProvider)}
            </p>
            {provider.displayName ? (
              <p className="text-[11px] text-muted-foreground">{providerName(usageProvider)}</p>
            ) : null}
          </div>
        </div>
        {statusLabel ? (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[11px] leading-none",
              statusClassName,
            )}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>
      <ProviderUsageDetails snapshot={snapshot} loading={usage.isPending} error={usage.error} />
    </article>
  );
}

function EnvironmentProviderUsageCards({
  environmentId,
  providers,
  refreshedSnapshots,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider> | null;
  refreshedSnapshots: ReadonlyMap<string, ServerProviderUsageSnapshot>;
}) {
  const supported = (providers ?? []).filter(
    (provider) => provider.enabled && provider.installed && isProviderUsageDriver(provider.driver),
  );
  if (providers !== null && supported.length === 0) return null;

  return (
    <div className="space-y-3">
      {providers === null ? (
        <div className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">
          Loading provider accounts…
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {supported.map((provider) => {
            const refreshedSnapshot = refreshedSnapshots.get(
              providerUsageSnapshotKey(environmentId, provider.instanceId),
            );
            return (
              <ProviderUsageCard
                key={provider.instanceId}
                environmentId={environmentId}
                provider={provider}
                {...(refreshedSnapshot === undefined ? {} : { refreshedSnapshot })}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConnectedEnvironmentProviderUsage({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const supported = (providers ?? []).filter(
    (provider) => provider.enabled && provider.installed && isProviderUsageDriver(provider.driver),
  );

  return (
    <section aria-label={`${label} provider usage`} className="space-y-2 px-2 py-2">
      <p className="truncate px-1 text-[11px] font-medium text-muted-foreground">{label}</p>
      {providers === null ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">Loading provider accounts…</p>
      ) : supported.length === 0 ? (
        <p className="px-1 py-1 text-xs text-muted-foreground">No supported accounts found.</p>
      ) : (
        <div className="space-y-1">
          {supported.map((provider) => (
            <ConnectedProviderUsageRow
              key={provider.instanceId}
              environmentId={environmentId}
              provider={provider}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ConnectedProviderUsageRow({
  environmentId,
  provider,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
}) {
  const usageProvider = provider.driver as ProviderUsageDriver;
  const usage = useProviderUsage({
    environmentId,
    instanceId: provider.instanceId,
    provider: usageProvider,
    enabled: true,
  });
  const label = provider.displayName ?? providerName(usageProvider);

  return (
    <div className="rounded-md bg-muted/45 px-2.5 py-2.5">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={label}
          accentColor={provider.accentColor}
          className="size-4"
          iconClassName="size-4"
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{label}</span>
        {usage.data?.status === "ok" && usage.data.planName ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{usage.data.planName}</span>
        ) : null}
      </div>
      <ProviderUsageDetails
        snapshot={usage.data}
        loading={usage.isPending}
        error={usage.error}
        compact
      />
    </div>
  );
}

export function ConnectedProviderUsageMenu() {
  const { isReady, environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );

  return (
    <div className="min-w-0">
      <div className="px-3 pb-2 pt-2">
        <p className="text-sm font-medium text-foreground">Provider usage</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Live subscription limits from connected environments.
        </p>
      </div>
      <div className="mx-2 h-px bg-border" />
      {!isReady ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Loading environments…</p>
      ) : connected.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">No environments connected.</p>
      ) : (
        <div className="divide-y divide-border/70">
          {connected.map((environment) => (
            <ConnectedEnvironmentProviderUsage
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProviderUsageSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const supported = useMemo(
    () =>
      (providers ?? []).filter(
        (provider) =>
          provider.enabled && provider.installed && isProviderUsageDriver(provider.driver),
      ),
    [providers],
  );
  const refreshTargets = useMemo(
    () =>
      supported.map((provider) => ({
        instanceId: provider.instanceId,
        provider: provider.driver as ProviderUsageDriver,
        label: provider.displayName ?? providerName(provider.driver as ProviderUsageDriver),
      })),
    [supported],
  );
  const usageRefresh = useForcedProviderUsageRefresh(environmentId, refreshTargets);

  return (
    <SettingsSection
      title="Provider limits"
      headerAction={
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Refresh provider usage"
          aria-busy={usageRefresh.isRefreshing}
          disabled={usageRefresh.isRefreshing || supported.length === 0}
          onClick={() => void usageRefresh.refresh()}
        >
          <RefreshCwIcon
            className={cn("size-3.5", usageRefresh.isRefreshing && SLOW_REFRESH_SPIN_CLASS)}
            aria-hidden="true"
          />
          Refresh
        </button>
      }
    >
      <div className="space-y-4 px-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Live subscription quota from each provider account on this environment.
        </p>
        <div className="space-y-5">
          <EnvironmentProviderUsageCards
            environmentId={environmentId}
            providers={providers}
            refreshedSnapshots={usageRefresh.refreshedSnapshots}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Pathway reads the CLI&apos;s stored sign-in on this environment and sends only the quota
          summary to this client. Credentials stay on that environment.
        </p>
      </div>
    </SettingsSection>
  );
}

export function supportsProviderUsage(
  provider: ServerProvider | undefined,
): provider is ServerProvider {
  return provider !== undefined && isProviderUsageDriver(provider.driver);
}
