/**
 * `/email?analytics=true` — the aggregates for whichever inbox the sidebar left selected.
 *
 * A lens on the scope above it, not a second top-level view: the scope comes in from the URL, so
 * All mail, one project, and Unassigned all read the same panel. Only the per-project breakdown is
 * scope-dependent, and it hides outside All mail rather than drawing a one-row bar chart of the
 * total it already shows.
 *
 * Charts are hand-rolled from `div`s: this app has no chart dependency, and adding one to draw
 * columns and horizontal bars would be a lot of bundle for two marks. Everything renders once and
 * stays put — no transitions on the marks, no ticking clock — because a chart that repaints is a
 * chart that pegs the GPU on a high-refresh display (AGENTS.md).
 *
 * Marks follow one rule each, from the dataviz method: a single series, so a single hue
 * (`--primary`, which is theme- and mode-aware) and no legend; thin marks capped at 24px with a 4px
 * rounded data-end and a square baseline; a 2px surface gap doing the separating rather than a
 * stroke; hairline solid gridlines one step off the surface; and text in text tokens, never in the
 * series color. Values are never gated behind the tooltip — the axis, the row labels, the peak
 * call-out, and the data table each reach them without a pointer.
 *
 * @module components/email/EmailAnalyticsPanel
 */
import type {
  EmailAddressMessageCount,
  EmailAnalyticsInterval,
  EmailAnalyticsResult,
  EmailInboxScope,
  ProjectId,
} from "@t3tools/contracts";
import { BarChart3Icon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useEmailAnalytics } from "~/state/email";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import {
  deriveEmailAnalyticsWindow,
  emailAnalyticsInput,
  emailAxisLabelStride,
  emailWindowAdvanceDelayMs,
  emailBarPercent,
  emailPeakBucketIndex,
  emailProjectCountLabel,
  emailVolumeAxis,
  emailVolumeTotal,
  EMAIL_ANALYTICS_RANGES,
  DEFAULT_EMAIL_ANALYTICS_RANGE,
  fillEmailVolumeBuckets,
  formatEmailBucketRangeLabel,
  isEmailAnalyticsEmpty,
  isEmailAxisLabelled,
  showsEmailProjectBreakdown,
  TOP_EMAIL_ADDRESS_LIMIT,
  type EmailAnalyticsRangeId,
  type EmailAnalyticsWindow,
  type EmailVolumeBucket,
} from "./emailAnalytics.logic";
import { formatEmailDurationMs } from "./emailView.logic";

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`;
}

export function EmailAnalyticsPanel({
  scope,
  inboxName,
  projectTitles,
}: {
  scope: EmailInboxScope;
  inboxName: string;
  projectTitles: ReadonlyMap<ProjectId, string>;
}) {
  const [rangeId, setRangeId] = useState<EmailAnalyticsRangeId>(DEFAULT_EMAIL_ANALYTICS_RANGE.id);
  // Anchored, not ticking: a window that slid under the reader would repaint the chart on a timer
  // for no new information. But a mount-time anchor alone goes stale — a panel left open across an
  // hour or UTC-day boundary keeps requesting its original exclusive `to`, and every
  // stream-triggered refresh after the boundary silently excludes the very mail that caused it.
  const [windowAnchor, setWindowAnchor] = useState(() => new Date());
  const analyticsWindow = useMemo(
    () => deriveEmailAnalyticsWindow(rangeId, windowAnchor),
    [rangeId, windowAnchor],
  );
  // One timeout per bucket boundary — it fires when `to` passes, advancing the anchor so the next
  // window can contain what arrives after it. Re-armed off the new window it causes; an early
  // firing just re-derives the same window and re-arms for the remainder.
  useEffect(() => {
    const timer = setTimeout(
      () => setWindowAnchor(new Date()),
      emailWindowAdvanceDelayMs(analyticsWindow, new Date()),
    );
    return () => clearTimeout(timer);
  }, [analyticsWindow]);
  const { analytics, isPending, error, refresh } = useEmailAnalytics(
    emailAnalyticsInput(scope, analyticsWindow),
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 py-4 sm:px-5">
        {/* One filter row, above everything it scopes — never a range per card. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div aria-label="Time range" className="flex items-center gap-0.5" role="group">
            {EMAIL_ANALYTICS_RANGES.map((range) => {
              const active = range.id === rangeId;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={range.id}
                  onClick={() => setRangeId(range.id)}
                  type="button"
                >
                  Last {range.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground/70">
            {inboxName} · buckets are UTC, matching how capture groups them
          </p>
          {isPending ? <Spinner className="ms-auto size-3" /> : null}
        </div>

        <AnalyticsBody
          analytics={analytics}
          analyticsWindow={analyticsWindow}
          error={error}
          inboxName={inboxName}
          interval={analyticsWindow.range.interval}
          isPending={isPending}
          onRetry={refresh}
          projectTitles={projectTitles}
          rangeLabel={analyticsWindow.range.label}
          scope={scope}
        />
      </div>
    </div>
  );
}

function AnalyticsBody({
  analytics,
  analyticsWindow,
  error,
  inboxName,
  interval,
  isPending,
  onRetry,
  projectTitles,
  rangeLabel,
  scope,
}: {
  analytics: EmailAnalyticsResult | null;
  analyticsWindow: EmailAnalyticsWindow;
  error: string | null;
  inboxName: string;
  interval: EmailAnalyticsInterval;
  isPending: boolean;
  onRetry: () => void;
  projectTitles: ReadonlyMap<ProjectId, string>;
  rangeLabel: string;
  scope: EmailInboxScope;
}) {
  if (error !== null && analytics === null) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BarChart3Icon />
          </EmptyMedia>
          <EmptyTitle>Analytics are unavailable</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onRetry} size="xs" variant="outline">
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (analytics === null) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (isEmailAnalyticsEmpty(analytics)) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BarChart3Icon />
          </EmptyMedia>
          <EmptyTitle>Nothing captured in this window</EmptyTitle>
          <EmptyDescription>
            {inboxName} received no mail in the last {rangeLabel}. Widen the range, or point a local
            app&rsquo;s SMTP host at this server and its next send lands here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const buckets = fillEmailVolumeBuckets(analyticsWindow, analytics.volumeOverTime);
  const total = emailVolumeTotal(analytics.volumeOverTime);
  const latency = analytics.captureLatency;

  return (
    // A refetch holds the previous render at reduced opacity: no skeleton flash, no layout jump.
    <div className={cn("flex flex-col gap-4", isPending && "opacity-60")}>
      <AnalyticsCard
        description={`${plural(total, "message")} in the last ${rangeLabel}.`}
        title="Volume over time"
      >
        <VolumeChart buckets={buckets} interval={interval} />
      </AnalyticsCard>

      {/* The contract always carries capture latency, but it describes the messages in range — with
          none of them it would be five zeros pretending to be a measurement. */}
      {latency.messageCount > 0 ? (
        <AnalyticsCard
          description="Connection open to stored on disk, for the messages in this window."
          title="Capture latency"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <StatTile label="Messages" value={latency.messageCount.toLocaleString()} />
            <StatTile label="Average" value={formatEmailDurationMs(latency.averageMs)} />
            <StatTile label="Median (p50)" value={formatEmailDurationMs(latency.p50Ms)} />
            <StatTile label="p95" value={formatEmailDurationMs(latency.p95Ms)} />
            <StatTile label="Slowest" value={formatEmailDurationMs(latency.maxMs)} />
          </div>
        </AnalyticsCard>
      ) : null}

      {showsEmailProjectBreakdown(scope) ? (
        <AnalyticsCard
          description="Where routing sent each message. Unassigned is the inbox for mail no rule claimed."
          title="Per-project counts"
        >
          <CountBars
            emptyLabel="Nothing was routed in this window."
            rows={analytics.perProjectCounts.map((row) => ({
              // The server groups by id *and* slug, so a project whose slug changed mid-window can
              // appear twice; both halves need their own key.
              key: `${row.projectId ?? "unassigned"}:${row.mailSlug ?? ""}`,
              label: emailProjectCountLabel(row, projectTitles),
              value: row.messageCount,
            }))}
          />
        </AnalyticsCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <AnalyticsCard
          description={`The ${TOP_EMAIL_ADDRESS_LIMIT} envelope senders that sent the most.`}
          title="Top senders"
        >
          <CountBars
            emptyLabel="No sender addresses were recorded."
            rows={addressRows(analytics.topSenders)}
          />
        </AnalyticsCard>
        <AnalyticsCard
          description={`The ${TOP_EMAIL_ADDRESS_LIMIT} addresses that received the most.`}
          title="Top recipients"
        >
          <CountBars
            emptyLabel="No recipient addresses were recorded."
            rows={addressRows(analytics.topRecipients)}
          />
        </AnalyticsCard>
      </div>
    </div>
  );
}

function addressRows(addresses: ReadonlyArray<EmailAddressMessageCount>) {
  return addresses.map((row) => ({
    key: row.address,
    label: row.address,
    value: row.messageCount,
  }));
}

function AnalyticsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/50 bg-card p-3 sm:p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-0.5 text-xs text-muted-foreground/70">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Proportional figures, not `tabular-nums`: equal-width digits make a standalone value look loose. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <div className="text-lg font-semibold leading-tight text-foreground">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

const PLOT_HEIGHT_CLASS = "h-40";
/** The y-tick gutter (`w-8`) plus the gap to the plot, so the x labels line up under the columns. */
const PLOT_INSET_CLASS = "ps-10";

function VolumeChart({
  buckets,
  interval,
}: {
  buckets: ReadonlyArray<EmailVolumeBucket>;
  interval: EmailAnalyticsInterval;
}) {
  // Hover and keyboard focus are the same state, so a tooltip is never pointer-only.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const peakIndex = emailPeakBucketIndex(buckets);
  const peak = peakIndex === -1 ? 0 : (buckets[peakIndex]?.messageCount ?? 0);
  const axis = emailVolumeAxis(peak);
  const stride = emailAxisLabelStride(buckets.length);
  const lastIndex = buckets.length - 1;

  return (
    <div>
      <div className="flex gap-2">
        <div className={cn("relative w-8 shrink-0", PLOT_HEIGHT_CLASS)}>
          {axis.ticks.map((tick) => (
            <span
              className="absolute end-0 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground/70"
              key={tick}
              style={{ top: `${100 - (tick / axis.max) * 100}%` }}
            >
              {tick.toLocaleString()}
            </span>
          ))}
        </div>

        <div className={cn("relative min-w-0 flex-1", PLOT_HEIGHT_CLASS)}>
          {axis.ticks.map((tick) => (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 h-px bg-border/60"
              key={tick}
              style={{ top: `${100 - (tick / axis.max) * 100}%` }}
            />
          ))}

          {/* gap-0.5 is the 2px surface gap doing the separating; the marks carry no stroke. */}
          <div className="absolute inset-0 flex items-end gap-0.5">
            {buckets.map((bucket, index) => {
              const height = emailBarPercent(bucket.messageCount, axis.max);
              const active = activeIndex === index;
              return (
                <button
                  aria-label={`${formatEmailBucketRangeLabel(bucket.bucketStart, interval)}: ${plural(bucket.messageCount, "message")}`}
                  className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                  key={bucket.bucketStart}
                  onBlur={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onPointerEnter={() => setActiveIndex(index)}
                  onPointerLeave={() => setActiveIndex(null)}
                  type="button"
                >
                  {/* Capped at 24px so a seven-column week is thin marks with air, not slabs. */}
                  {height > 0 ? (
                    <span
                      aria-hidden="true"
                      className="w-full max-w-6 rounded-t-[4px] bg-primary"
                      style={{ height: `${height}%` }}
                    />
                  ) : null}

                  {/* The extreme is the one point worth a direct label; the axis carries the rest.
                      The scale keeps a whole step of headroom, so this always has room to sit. */}
                  {index === peakIndex && !active ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-1/2 mb-0.5 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium tabular-nums text-muted-foreground"
                      style={{ bottom: `${height}%` }}
                    >
                      {bucket.messageCount.toLocaleString()}
                    </span>
                  ) : null}

                  {active ? (
                    <span
                      className={cn(
                        "pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-md",
                        index === 0
                          ? "left-0"
                          : index === lastIndex
                            ? "right-0"
                            : "left-1/2 -translate-x-1/2",
                      )}
                    >
                      {/* Value leads, label follows — the reader already has the bucket. */}
                      <span className="font-medium tabular-nums text-foreground">
                        {plural(bucket.messageCount, "message")}
                      </span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {formatEmailBucketRangeLabel(bucket.bucketStart, interval)}
                      </span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={cn("mt-1.5 flex gap-0.5", PLOT_INSET_CLASS)}>
        {buckets.map((bucket, index) => (
          <span
            // Not truncated: a thinned tick has its neighbours' empty cells to spill into, and a
            // clipped "Aug 1…" is worse than a label that overhangs by a few pixels.
            className="min-w-0 flex-1 whitespace-nowrap text-center text-[10px] tabular-nums text-muted-foreground/70"
            key={bucket.bucketStart}
          >
            {isEmailAxisLabelled(index, buckets.length, stride) ? bucket.label : ""}
          </span>
        ))}
      </div>

      {/* The table twin: every bucket's value without a pointer, and the honest home for the ones
          the axis thinned out. */}
      <details className="mt-3">
        <summary className="w-fit cursor-pointer text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Show data table
        </summary>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr>
              <th className="py-1 text-start font-medium text-muted-foreground">Bucket</th>
              <th className="py-1 text-end font-medium text-muted-foreground">Messages</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.bucketStart}>
                <td className="py-0.5 text-foreground/90">
                  {formatEmailBucketRangeLabel(bucket.bucketStart, interval)}
                </td>
                <td className="py-0.5 text-end tabular-nums text-foreground/90">
                  {bucket.messageCount.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

interface CountRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/**
 * Nominal categories, so every bar wears the same hue: the length already encodes the value, and
 * spending the identity channel on it again would say nothing new. Each row is direct-labeled, so
 * these need no tooltip and no table twin.
 */
function CountBars({ rows, emptyLabel }: { rows: ReadonlyArray<CountRow>; emptyLabel: string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground/70">{emptyLabel}</p>;
  }
  const max = rows.reduce((highest, row) => Math.max(highest, row.value), 0);

  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li
          className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-2"
          key={row.key}
        >
          <span className="truncate text-xs text-foreground" title={row.label}>
            {row.label}
          </span>
          <span aria-hidden="true" className="block h-2 rounded-sm bg-muted">
            <span
              className="block h-full rounded-e-[4px] bg-primary"
              style={{ width: `${emailBarPercent(row.value, max)}%` }}
            />
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {row.value.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
