import { useAtomValue } from "@effect/atom-react";
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
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsSection } from "../settings/settingsLayout";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  deriveProviderUsageLimits,
  selectPrimaryProviderUsageLimit,
  shouldCollapseProviderUsage,
  type ProviderUsageDisplayLimit,
} from "./providerUsageDisplay";

const SUPPORTED_PROVIDERS = new Set<ProviderUsageDriver>(["codex", "claudeAgent", "cursor"]);

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return SUPPORTED_PROVIDERS.has(driver as ProviderUsageDriver);
}

function providerName(provider: ProviderUsageDriver): string {
  return PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(provider)] ?? provider;
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
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const usage = useProviderUsage({
    environmentId,
    instanceId: provider.instanceId,
    provider: provider.driver as ProviderUsageDriver,
    enabled,
  });
  const primary = selectPrimaryProviderUsageLimit(usage.data);
  const limits = usage.data?.status === "ok" ? deriveProviderUsageLimits(usage.data.limits) : [];
  const summary =
    primary?.remainingLabel ??
    (usage.isPending
      ? "Loading…"
      : usage.data?.status === "needs-auth"
        ? "Not signed in"
        : usage.data?.status === "error" || usage.error
          ? "Unavailable"
          : "Usage");

  if (!shouldCollapseProviderUsage(limits)) {
    return (
      <section aria-label="Provider usage" className="border-t border-border/70 py-2">
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Usage</p>
        {primary ? (
          <div className="flex items-start gap-2 px-2 py-1.5">
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={
                provider.displayName ?? providerName(provider.driver as ProviderUsageDriver)
              }
              accentColor={provider.accentColor}
              className="mt-0.5 size-4"
              iconClassName="size-4"
            />
            <div className="min-w-0 flex-1">
              <UsageLimitRow limit={primary} compact resetInline />
              {usage.data?.status === "ok" && usage.data.usageLines.length > 0 ? (
                <div className="mt-2 space-y-1 border-t border-border/70 pt-2">
                  {usage.data.usageLines.map((line) => (
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
          </div>
        ) : (
          <div className="px-2 py-1.5">
            <ProviderUsageDetails
              snapshot={usage.data}
              loading={usage.isPending}
              error={usage.error}
              compact
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Provider usage" className="border-t border-border/70 py-2">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Usage</p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <button
          type="button"
          data-keep-action-card-open
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((value) => !value)}
        >
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={
              provider.displayName ?? providerName(provider.driver as ProviderUsageDriver)
            }
            accentColor={provider.accentColor}
            className="size-4"
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1 truncate">{summary}</span>
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
              snapshot={usage.data}
              loading={usage.isPending}
              error={usage.error}
              compact
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function ProviderUsageCard({
  environmentId,
  provider,
  refreshVersion,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  refreshVersion: number;
}) {
  const usageProvider = provider.driver as ProviderUsageDriver;
  const usage = useProviderUsage({
    environmentId,
    instanceId: provider.instanceId,
    provider: usageProvider,
    enabled: true,
  });
  const refreshUsage = useAtomCommand(serverEnvironment.refreshProviderUsage, {
    reportFailure: false,
  });
  const [refreshedSnapshot, setRefreshedSnapshot] = useState<ServerProviderUsageSnapshot | null>(
    null,
  );
  useEffect(() => {
    if (refreshVersion === 0) return;
    let cancelled = false;
    void refreshUsage({
      environmentId,
      input: {
        instanceId: provider.instanceId,
        provider: usageProvider,
        forceRefresh: true,
      },
    }).then((result) => {
      if (!cancelled && result._tag === "Success") setRefreshedSnapshot(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, provider.instanceId, refreshUsage, refreshVersion, usageProvider]);
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
  refreshVersion,
}: {
  environmentId: EnvironmentId;
  refreshVersion: number;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
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
          {supported.map((provider) => (
            <ProviderUsageCard
              key={provider.instanceId}
              environmentId={environmentId}
              provider={provider}
              refreshVersion={refreshVersion}
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
  const [refreshVersion, setRefreshVersion] = useState(0);

  return (
    <SettingsSection
      title="Provider limits"
      headerAction={
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setRefreshVersion((value) => value + 1)}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
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
            refreshVersion={refreshVersion}
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
