import { Fragment, type ReactNode, useState } from "react";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@spiritdevs/contracts";
import type { TimestampFormat } from "@spiritdevs/contracts/settings";
import {
  getChangeRequestTerminologyFromUrl,
  sourceControlMarkerLabel,
} from "@spiritdevs/shared/sourceControl";
import {
  ArrowRightLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  GitForkIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MinusIcon,
  CopyIcon,
  type LucideIcon,
  XIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { PROVIDER_ICON_BY_PROVIDER, getTriggerDisplayModelName } from "./providerIconUtils";
import { AgentElapsed } from "./AgentElapsed";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readLocalApi } from "../../localApi";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "source_control",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

// Aborted subagents (cancelled/interrupted) keep whatever result text had
// streamed before the abort, so only completed/failed results are final.
const FINAL_RESULT_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
]);

// Once a subagent stops, its last streamed result says more than the stale
// progress line; while it runs, live progress comes first.
const TERMINAL_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

/**
 * The subset of a projection subagent that subagent cards read. The turn item
 * carries the driver and instance but not the model, so the card joins on
 * `subagentId` to label which model the child is running.
 */
export type SubagentTimelineModel = Pick<OrchestrationV2Subagent, "id" | "model">;

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly subagents: ReadonlyArray<SubagentTimelineModel>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onDetachPullRequest?:
    | ((pullRequest: { readonly number: number; readonly url: string }) => void)
    | undefined;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    return <CompactionLifecycleRow item={item} providerStatuses={props.providerStatuses} />;
  }
  if (item.type === "handoff") {
    // Items persisted before models were stamped only carry instance ids;
    // recover the models from the thread's runs (the handoff's own run is
    // the target, the newest earlier run per source instance is the origin).
    // ProviderModelEndpoint falls back to the provider display name when neither
    // source has a model.
    const handoffRun =
      item.runId === null ? undefined : props.runs.find((run) => run.id === item.runId);
    const toModel =
      item.toModel ??
      (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
        ? handoffRun.modelSelection.model
        : undefined);
    const fromEndpoints: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly model?: string | undefined;
    }> =
      item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
        ? item.fromModelSelections
        : item.fromProviderInstanceIds.map((instanceId) => ({
            instanceId,
            model: latestRunModelBefore(props.runs, instanceId, handoffRun?.ordinal),
          }));
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ArrowRightLeftIcon}
        showDetailSeparator={false}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {fromEndpoints.map((endpoint, index) => (
              <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="-ml-1">
                    ,
                  </span>
                ) : null}
                <ProviderModelEndpoint
                  providers={props.providerStatuses}
                  instanceId={endpoint.instanceId}
                  model={endpoint.model}
                />
              </Fragment>
            ))}
            {fromEndpoints.length > 0 ? (
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <ProviderModelEndpoint
              providers={props.providerStatuses}
              instanceId={item.toProviderInstanceId}
              model={toModel}
            />
          </span>
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    const isSideChat = item.forkKind === "side_chat";
    return (
      <TimelineSystemDivider
        label={
          isSideChat
            ? "Side chat created"
            : item.source.type === "run"
              ? "Forked from conversation"
              : "Conversation fork"
        }
        icon={isSideChat ? MessagesSquareIcon : GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "source_control") {
    const commitSha = item.commitSha;
    const changeRequestLabel =
      item.pullRequest === null
        ? "PR"
        : getChangeRequestTerminologyFromUrl(item.pullRequest.url).shortLabel;
    return (
      <TimelineSystemDivider
        label={sourceControlMarkerLabel(item)}
        icon={item.pullRequestAction === undefined ? GitCommitHorizontalIcon : GitPullRequestIcon}
        detail={
          commitSha === undefined && item.pullRequest === null ? null : (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {commitSha === undefined ? null : (
                <span
                  className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-[10px]"
                  title={`Commit ${commitSha}`}
                >
                  {commitSha.slice(0, 7)}
                </span>
              )}
              {item.pullRequest === null ? null : (
                <a
                  href={item.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
                  aria-label={`Open ${changeRequestLabel} #${item.pullRequest.number}`}
                  title={
                    props.onDetachPullRequest
                      ? `Open ${changeRequestLabel}. Right-click to detach from thread.`
                      : undefined
                  }
                  onContextMenu={(event) => {
                    if (!props.onDetachPullRequest || item.pullRequest === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const api = readLocalApi();
                    if (!api) return;
                    void api.contextMenu
                      .show(
                        [
                          {
                            id: "detach-pull-request",
                            label: `Detach ${changeRequestLabel} from thread`,
                          },
                        ],
                        { x: event.clientX, y: event.clientY },
                      )
                      .then((action) => {
                        if (action === "detach-pull-request" && item.pullRequest !== null) {
                          props.onDetachPullRequest?.(item.pullRequest);
                        }
                      })
                      .catch((cause: unknown) => {
                        console.error("[source-control-marker] context menu failed", cause);
                      });
                  }}
                >
                  #{item.pullRequest.number}
                  <ExternalLinkIcon aria-hidden="true" className="size-2.5" />
                </a>
              )}
            </span>
          )
        }
      />
    );
  }
  if (item.type === "thread_created") {
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={MessageSquareIcon}
        title={item.title ?? "Created thread"}
        detail=""
        endpoint={
          <ProviderModelEndpoint
            providers={props.providerStatuses}
            instanceId={item.targetProviderInstanceId}
            model={item.targetModel}
          />
        }
        badge="created"
        threadId={item.targetThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentCard
        items={[item]}
        providerStatuses={props.providerStatuses}
        subagents={props.subagents}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function CompactionLifecycleRow(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "compaction" }>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<null>({
    timeout: 1_500,
    target: "compaction summary",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy compaction summary",
          description: error.message,
        }),
      );
    },
  });
  const { item } = props;
  const isRunning = item.status === "pending" || item.status === "running";
  const tokenDetail =
    item.beforeTokenCount === undefined && item.afterTokenCount === undefined
      ? null
      : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
  const methodDetail =
    item.method === "fallback"
      ? "Deterministic fallback"
      : item.method === "model"
        ? "Model summary"
        : item.method === "direct"
          ? "Direct handoff"
          : null;
  const target =
    item.kind === "model_switch" && item.toProviderInstanceId !== undefined ? (
      <ProviderModelEndpoint
        providers={props.providerStatuses}
        instanceId={item.toProviderInstanceId}
        model={item.toModel}
      />
    ) : null;
  const label = isRunning
    ? "Compacting context…"
    : item.kind === "provider_native"
      ? "Claude context compacted"
      : "Context compacted";
  const detail =
    target === null ? (
      (methodDetail ?? tokenDetail)
    ) : (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {target}
        {methodDetail ? <span>· {methodDetail}</span> : null}
        {item.coveredRunOrdinals ? (
          <span>
            · runs {item.coveredRunOrdinals.from}–{item.coveredRunOrdinals.to}
          </span>
        ) : null}
      </span>
    );
  return (
    <div data-v2-item-type="compaction">
      <TimelineSystemDivider
        label={label}
        detail={detail}
        icon={MinusIcon}
        {...(item.summary
          ? {
              actionLabel: expanded ? "Hide compaction summary" : "Show compaction summary",
              onAction: () => setExpanded((value) => !value),
            }
          : {})}
      />
      {expanded && item.summary ? (
        <div className="mx-auto mt-1 max-w-3xl rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-medium text-muted-foreground">Compaction summary</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => copyToClipboard(item.summary ?? "", null)}
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-foreground/90">
            {item.summary}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function RelatedThreadCard(props: {
  readonly itemType: "thread_created";
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
  /** Provider icon + model label for the thread this card points at. */
  readonly endpoint?: ReactNode;
  readonly badge: string;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const Icon = props.icon;
  const threadId = props.threadId;
  const content = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
      {props.detail === "" ? null : (
        <span className="max-w-[40%] truncate text-xs text-muted-foreground">{props.detail}</span>
      )}
      {props.endpoint === undefined ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{props.endpoint}</span>
      )}
      <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {props.badge}
      </span>
    </>
  );

  return threadId === null ? (
    <div
      data-v2-item-type={props.itemType}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2"
    >
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-v2-item-type={props.itemType}
      aria-label={`Open ${props.title}`}
      onClick={() => props.onOpenThread(threadId)}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
    >
      {content}
      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

/**
 * In-flight states read as one family (info dot); only settled states
 * differentiate. Labels match what a user would say about the child.
 */
const SUBAGENT_STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { readonly dotClass: string; readonly label: string }
> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  completed: { dotClass: "bg-success", label: "Finished" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

/** The server's placeholder when a child ends without output; the status label already says it. */
const GENERIC_CHILD_END = /^Child task ended with status\b/i;

/** One line of a markdown result: drop link targets, code ticks, and list bullets. */
function subagentOneLine(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "2 running · 1 finished", in first-seen order. */
export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItem["status"]>,
): string {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    const label = SUBAGENT_STATUS_VISUALS[status].label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
}

/**
 * Subagents a turn launched together, drawn as one card of rows. A group of
 * two or more gets a count + status summary header.
 */
export function SubagentCard(props: {
  readonly items: ReadonlyArray<SubagentTurnItem>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly subagents: ReadonlyArray<SubagentTimelineModel>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const grouped = props.items.length > 1;
  return (
    <div
      data-subagent-group={grouped ? "true" : undefined}
      className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-card/30 p-1"
    >
      {grouped ? (
        <div className="flex min-w-0 items-baseline gap-2 px-2 pt-1 pb-0.5 text-[11px]">
          <span className="shrink-0 font-medium text-foreground">
            {props.items.length} subagents
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {summarizeSubagentStatuses(props.items.map((item) => item.status))}
          </span>
        </div>
      ) : null}
      {props.items.map((item) => (
        <SubagentRow
          key={item.id}
          item={item}
          providerStatuses={props.providerStatuses}
          // The item only records the instance; the model lives on the
          // projection's subagent record, which the timeline threads through.
          model={props.subagents.find((subagent) => subagent.id === item.subagentId)?.model}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </div>
  );
}

function SubagentAvatar(props: {
  readonly driver: SubagentTurnItem["driver"];
  readonly status: OrchestrationV2TurnItem["status"];
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driver] ?? null;
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted"
    >
      {Icon === null ? (
        <BotIcon className="size-3.5 text-muted-foreground" />
      ) : (
        <Icon className="size-3.5" />
      )}
      <span
        className={cn(
          "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
          SUBAGENT_STATUS_VISUALS[props.status].dotClass,
        )}
      />
    </span>
  );
}

/**
 * One subagent: provider avatar with a status dot, title, status and model,
 * a one-line activity (live progress while running, the result once settled),
 * and elapsed time. Clicking opens the child thread; a settled result can be
 * read in full in place.
 */
function SubagentRow(props: {
  readonly item: SubagentTurnItem;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly model: string | null | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const [resultOpen, setResultOpen] = useState(false);
  const title = subagentDisplayTitle(item.title ?? "Subagent");
  const visual = SUBAGENT_STATUS_VISUALS[item.status];
  const failed = item.status === "failed";
  const live = item.status === "pending" || item.status === "running" || item.status === "waiting";
  const result = item.result?.trim() || null;
  const progress = item.progress?.trim() || null;
  // Live rows lead with what is happening now; settled rows with the outcome.
  const rawDetail = TERMINAL_SUBAGENT_STATUSES.has(item.status)
    ? (result ?? progress)
    : (progress ?? result);
  const detail =
    rawDetail !== null && !GENERIC_CHILD_END.test(rawDetail) ? subagentOneLine(rawDetail) : "";
  const fullResult =
    FINAL_RESULT_SUBAGENT_STATUSES.has(item.status) &&
    result !== null &&
    !GENERIC_CHILD_END.test(result)
      ? result
      : null;
  const modelLabel = providerModelLabel(
    props.providerStatuses,
    item.providerInstanceId,
    props.model ?? undefined,
  );
  const threadId = item.childThreadId;
  const content = (
    <>
      <SubagentAvatar driver={item.driver} status={item.status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
          <span
            className={cn(
              "shrink-0 text-[11px]",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {visual.label}
          </span>
          <span aria-hidden="true" className="shrink-0 text-[11px] text-muted-foreground/50">
            ·
          </span>
          <span className="max-w-40 shrink truncate text-[11px] text-muted-foreground">
            {modelLabel}
          </span>
        </span>
        {detail === "" ? null : (
          <span
            className={cn(
              "block truncate text-[11px] leading-relaxed",
              failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {detail}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        <AgentElapsed
          startedAtMs={item.startedAt ? DateTime.toEpochMillis(item.startedAt) : null}
          completedAtMs={item.completedAt ? DateTime.toEpochMillis(item.completedAt) : null}
          live={live}
        />
      </span>
    </>
  );
  const rowClassName = "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <div data-v2-item-type="subagent" aria-description={visual.label}>
      <div className="flex min-w-0 items-center gap-0.5">
        {threadId === null ? (
          <div className={rowClassName}>{content}</div>
        ) : (
          <button
            type="button"
            aria-label={`Open ${title}`}
            onClick={() => props.onOpenThread(threadId)}
            className={cn(
              rowClassName,
              "group/subagent cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            )}
          >
            {content}
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
            />
          </button>
        )}
        {fullResult === null ? null : (
          <button
            type="button"
            data-v2-subagent-result-disclosure="true"
            aria-expanded={resultOpen}
            aria-label={`${resultOpen ? "Hide" : "Show"} full result for ${title}`}
            title={resultOpen ? "Hide result" : "Show result"}
            onClick={() => setResultOpen((open) => !open)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", resultOpen && "rotate-180")}
            />
          </button>
        )}
      </div>
      {resultOpen && fullResult !== null ? (
        <p
          data-v2-subagent-result="true"
          className="mx-2 mb-1.5 max-h-64 overflow-auto rounded-md bg-muted/30 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
        >
          {fullResult}
        </p>
      ) : null}
    </div>
  );
}

function subagentDisplayTitle(title: string): string {
  return title.replace(/^Subagent:\s*/i, "");
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/**
 * A provider endpoint: the provider's brand icon plus the model's display
 * name. Used for both sides of a context handoff and for the provider/model a
 * related thread (subagent or created thread) runs on. Falls back to the raw
 * model slug when the instance no longer lists it, and to the instance display
 * name (or id) when no model was recorded on the item.
 */
function providerModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  model: string | undefined,
): string {
  const entry = getProviderInstanceEntry(providers, instanceId);
  const slug = model?.trim();
  if (slug === undefined || slug.length === 0) return entry?.displayName ?? instanceId;
  const providerModel = entry?.models.find((candidate) => candidate.slug === slug);
  return providerModel === undefined ? slug : getTriggerDisplayModelName(providerModel);
}

export function ProviderModelEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const Icon = entry === undefined ? null : (PROVIDER_ICON_BY_PROVIDER[entry.driverKind] ?? null);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon === null ? null : <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="max-w-40 truncate">
        {providerModelLabel(props.providers, props.instanceId, props.model)}
      </span>
    </span>
  );
}
