import { scopedThreadKey, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  orderWebThreadLineageRows,
  resolveThreadForkKind,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "@spiritdevs/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@spiritdevs/client-runtime/state/thread-workflows";
import { useAtomValue } from "@effect/atom-react";
import type {
  ContextMenuItem,
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  CornerLeftUpIcon,
  ListIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TerminalIcon,
  UnplugIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { readLocalApi } from "../../localApi";
import { environmentServerConfigsAtom } from "../../state/server";
import { openThreadParentPicker } from "../../threadParentBus";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { ProviderModelEndpoint } from "./V2LifecycleRow";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_MENU_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_RELATIONSHIP_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

// Lineage paging: a busy thread can accumulate dozens of forks and subagents,
// and the panel it lives in already scrolls. Show a workable window, keep the
// rest behind Show more, and bound what is shown so the sections below Lineage
// stay reachable.
const THREAD_LINEAGE_INITIAL_COUNT = 6;
const THREAD_LINEAGE_PAGE_COUNT = 12;

export function resolveThreadLineageWindow<Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number,
): { readonly visibleRows: ReadonlyArray<Row>; readonly hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

export function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  /** What the list is of, for the sections that reuse this window for something other than threads. */
  readonly ariaLabel?: string;
  /** How many rows `onShowMore` adds. The button says the number, so it has to be given the number. */
  readonly pageCount?: number;
  readonly children: ReactNode;
}) {
  const pageCount = props.pageCount ?? THREAD_LINEAGE_PAGE_COUNT;
  return (
    <>
      {/*
        Bounded rather than free-growing so Lineage cannot push the rest of the
        thread details panel out of view. Plain overflow, not a ScrollArea
        component: this sits inside an already scrolling panel, where a
        max-height-only virtual viewport measures badly. Let wheel and touch
        scrolling chain to the surrounding details panel when this list reaches
        an edge; containing overscroll here makes the panel feel stuck whenever
        the pointer is over a lineage row. Every row is a focusable button, so
        keyboard users reach and scroll the region through the rows themselves
        and the container needs no extra tab stop of its own.
      */}
      <ul
        aria-label={props.ariaLabel ?? "Related threads"}
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0"
      >
        {props.children}
      </ul>
      {props.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={props.onShowMore}
          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]"
        >
          <PlusIcon aria-hidden className="-mx-0.5 size-4 shrink-0" />
          Show {Math.min(props.hiddenCount, pageCount)} more
        </button>
      ) : null}
    </>
  );
}

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  if (edge.kind === "attached") {
    return edge.sourceThreadId === currentThreadId ? "Attached thread" : "Parent thread";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

function statusDotClass(status: string | null): string {
  if (status === "running" || status === "in_progress") return "bg-info";
  if (status === "failed" || status === "error") return "bg-destructive";
  if (status === "completed") return "bg-success";
  return "bg-muted-foreground/45";
}

function statusTextClass(status: string | null): string {
  if (isLiveAgentStatus(status)) return "text-info";
  if (status === "failed" || status === "error") return "text-destructive";
  if (status === "completed") return "text-success";
  return "text-muted-foreground";
}

const LIVE_AGENT_STATUSES = new Set([
  "pending",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "in_progress",
]);
const FINISHED_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
  "error",
]);

export function isLiveAgentStatus(status: string | null): boolean {
  return status !== null && LIVE_AGENT_STATUSES.has(status);
}

/** Subagents this thread started that have stopped; Lineage files them under Previous agents. */
export function isPreviousAgentRow(
  edge: Pick<ThreadRelationshipEdge, "kind" | "sourceThreadId" | "status">,
  currentThreadId: ThreadId,
): boolean {
  return (
    edge.kind === "subagent" &&
    edge.sourceThreadId === currentThreadId &&
    edge.status !== null &&
    FINISHED_AGENT_STATUSES.has(edge.status)
  );
}

function agentStatusLabel(status: string | null): string | null {
  if (status === null || status === "idle") return null;
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatAgentElapsed(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Self-ticking while the agent runs so only this span re-renders each second.
function AgentElapsed(props: {
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly live: boolean;
}) {
  const [, setTick] = useState(0);
  const ticking = props.live && props.startedAtMs !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (props.startedAtMs === null) return null;
  const endMs = props.live ? Date.now() : props.completedAtMs;
  if (endMs === null) return null;
  return <span className="tabular-nums">{formatAgentElapsed(endMs - props.startedAtMs)}</span>;
}

interface SubagentDetails {
  readonly providerInstanceId: OrchestrationV2ThreadShell["providerInstanceId"] | null;
  readonly model: string | undefined;
  readonly status: string | null;
  readonly live: boolean;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly activity: string | null;
}

const toEpochMillis = (value: DateTime.Utc | null | undefined) =>
  value ? DateTime.toEpochMillis(value) : null;

/** What a subagent is doing, preferring the parent's live record over the child thread's shell. */
function resolveSubagentDetails(input: {
  readonly subagent: OrchestrationV2Subagent | undefined;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly status: string | null;
}): SubagentDetails {
  const { subagent, thread, status } = input;
  const live = isLiveAgentStatus(status);
  // A follow-up run on a finished subagent's thread: its record describes the earlier task.
  const task = live && !isLiveAgentStatus(subagent?.status ?? null) ? undefined : subagent;
  const progress = task?.progress?.trim() || null;
  const result = task?.result?.trim() || null;
  return {
    providerInstanceId: subagent?.providerInstanceId ?? thread?.providerInstanceId ?? null,
    model: subagent?.model ?? thread?.modelSelection.model,
    status,
    live,
    startedAtMs: toEpochMillis(task?.startedAt ?? thread?.latestRunStartedAt),
    completedAtMs: toEpochMillis(task?.completedAt ?? thread?.latestRunCompletedAt),
    activity: live ? progress : (result ?? progress),
  };
}

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return input.title.replace(/^Subagent:\s*/i, "");
}

function useThreadRelationshipsModel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const threadShells = useThreadShells();
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  // Attachments can cross environments: a thread started here from another environment points at
  // its parent there, and threads elsewhere point at parents here.
  const { graph, environmentByThreadId } = useMemo(() => {
    const parent = projection?.thread.lineage;
    const shells: OrchestrationV2ThreadShell[] = [];
    const environmentByThreadId = new Map<ThreadId, EnvironmentId>();
    for (const thread of threadShells) {
      const lineage = thread.source.lineage;
      if (
        thread.environmentId === props.environmentId ||
        lineage.parentEnvironmentId === props.environmentId ||
        (thread.environmentId === parent?.parentEnvironmentId &&
          thread.source.id === parent.parentThreadId)
      ) {
        shells.push(thread.source);
        environmentByThreadId.set(thread.source.id, thread.environmentId);
      }
    }
    shells.push(...(archivedShells ?? []));
    return {
      graph: deriveThreadRelationshipGraph({ threads: shells, projection }),
      environmentByThreadId,
    };
  }, [archivedShells, projection, props.environmentId, threadShells]);
  const navigate = useNavigate();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const setParent = useAtomCommand(threadEnvironment.setParent);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const settleThread = useAtomCommand(threadEnvironment.settle);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const [settlingThreadId, setSettlingThreadId] = useState<ThreadId | null>(null);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = useMemo(
    () =>
      orderWebThreadLineageRows({
        graph,
        rows: immediateThreadRelationships(graph, props.threadId),
        currentThreadId: props.threadId,
        mergeTargetThreadId,
      }),
    [graph, mergeTargetThreadId, props.threadId],
  );
  const chatRows = useMemo(
    () =>
      relationshipRows.filter(({ threadId, edge }) => {
        const thread = graph.nodes.get(threadId)?.thread;
        return (
          edge.kind === "fork" &&
          edge.sourceThreadId === props.threadId &&
          thread?.settledOverride !== "settled"
        );
      }),
    [graph.nodes, props.threadId, relationshipRows],
  );
  const lineageRows = useMemo(
    () =>
      relationshipRows.filter(
        ({ edge }) => !(edge.kind === "fork" && edge.sourceThreadId === props.threadId),
      ),
    [props.threadId, relationshipRows],
  );
  const { activeLineageRows, previousAgentRows } = useMemo(() => {
    const activeLineageRows: typeof lineageRows = [];
    const previousAgentRows: typeof lineageRows = [];
    for (const row of lineageRows) {
      (isPreviousAgentRow(row.edge, props.threadId) ? previousAgentRows : activeLineageRows).push(
        row,
      );
    }
    return { activeLineageRows, previousAgentRows };
  }, [lineageRows, props.threadId]);
  const runningAgentCount = activeLineageRows.filter(
    ({ edge }) =>
      edge.kind === "subagent" &&
      edge.sourceThreadId === props.threadId &&
      isLiveAgentStatus(edge.status),
  ).length;
  const subagents = projection?.subagents;
  const subagentByThreadId = useMemo(() => {
    const byThreadId = new Map<ThreadId, OrchestrationV2Subagent>();
    for (const subagent of subagents ?? []) {
      if (subagent.childThreadId !== null) byThreadId.set(subagent.childThreadId, subagent);
    }
    return byThreadId;
  }, [subagents]);
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  const [visibleCount, setVisibleCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const [visibleChatCount, setVisibleChatCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const [visiblePreviousCount, setVisiblePreviousCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const lineageResetKey = scopedThreadKey(ref);
  const lastLineageResetKeyRef = useRef(lineageResetKey);
  if (lastLineageResetKeyRef.current !== lineageResetKey) {
    lastLineageResetKeyRef.current = lineageResetKey;
    setVisibleCount(THREAD_LINEAGE_INITIAL_COUNT);
    setVisibleChatCount(THREAD_LINEAGE_INITIAL_COUNT);
    setVisiblePreviousCount(THREAD_LINEAGE_INITIAL_COUNT);
  }
  const showMore = useCallback(
    () => setVisibleCount((count) => count + THREAD_LINEAGE_PAGE_COUNT),
    [],
  );
  const showMorePrevious = useCallback(
    () => setVisiblePreviousCount((count) => count + THREAD_LINEAGE_PAGE_COUNT),
    [],
  );
  const showMoreChats = useCallback(
    () => setVisibleChatCount((count) => count + THREAD_LINEAGE_PAGE_COUNT),
    [],
  );
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(activeLineageRows, visibleCount);
  const { visibleRows: visiblePreviousRows, hiddenCount: hiddenPreviousCount } =
    resolveThreadLineageWindow(previousAgentRows, visiblePreviousCount);
  const { visibleRows: visibleChatRows, hiddenCount: hiddenChatCount } = resolveThreadLineageWindow(
    chatRows,
    visibleChatCount,
  );

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(environmentByThreadId.get(threadId) ?? props.environmentId, threadId),
      ),
    });
  };

  // "Set parent…" and "Move to threads list" for the open thread or any row.
  const parentMenuItems = (
    threadId: ThreadId,
  ): ReadonlyArray<ContextMenuItem<ThreadParentMenuAction>> => {
    const thread =
      threadId === props.threadId
        ? (projection?.thread ?? null)
        : (graph.nodes.get(threadId)?.thread ?? null);
    const environmentId = environmentByThreadId.get(threadId) ?? props.environmentId;
    if (
      thread === null ||
      serverConfigs.get(environmentId)?.environment.capabilities.threadParent !== true
    )
      return [];
    return [
      { id: "set-parent", label: "Set parent…" },
      ...(thread.lineage.parentThreadId === null
        ? []
        : [{ id: "move-to-threads-list" as const, label: "Move to threads list" }]),
    ];
  };

  const runParentMenuAction = (threadId: ThreadId, action: ThreadParentMenuAction) => {
    const environmentId = environmentByThreadId.get(threadId) ?? props.environmentId;
    if (action === "set-parent") {
      openThreadParentPicker({ environmentId, threadId });
      return;
    }
    void setParent({ environmentId, input: { threadId, parent: null } });
  };

  const showParentContextMenu = (threadId: ThreadId, position: { x: number; y: number }) => {
    const items = parentMenuItems(threadId);
    const api = readLocalApi();
    if (items.length === 0 || !api) return;
    void api.contextMenu.show(items, position).then((action) => {
      if (action !== null) runParentMenuAction(threadId, action);
    });
  };

  const openChat = (threadId: ThreadId) => {
    useRightPanelStore.getState().openThread(ref, threadId);
  };

  const settleChat = async (threadId: ThreadId, kind: "manual" | "side_chat") => {
    if (settlingThreadId !== null) return;
    setSettlingThreadId(threadId);
    const result = await settleThread({
      environmentId: props.environmentId,
      input: { threadId },
    });
    setSettlingThreadId(null);
    if (result._tag === "Success" && kind === "side_chat") {
      useRightPanelStore.getState().closeSurface(ref, `thread:${threadId}`);
    }
  };

  const merge = async () => {
    if (!latestMergeBackRun || mergeTargetThreadId === null || busyAction !== null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  const providersFor = (threadId: ThreadId) =>
    serverConfigs.get(environmentByThreadId.get(threadId) ?? props.environmentId)?.providers ?? [];

  // A subagent row shows the brand icon of the provider it runs on, when that provider is known.
  // The parent's subagent record is authoritative; the child shell covers subagents without one.
  const providerIcon = (threadId: ThreadId) => {
    const thread = graph.nodes.get(threadId)?.thread;
    const driver =
      subagentByThreadId.get(threadId)?.driver ??
      (thread
        ? providersFor(threadId).find(
            (provider) => provider.instanceId === thread.providerInstanceId,
          )?.driver
        : undefined);
    return driver === undefined ? null : (PROVIDER_ICON_BY_PROVIDER[driver] ?? null);
  };

  const subagentDetails = (threadId: ThreadId, status: string | null) =>
    resolveSubagentDetails({
      subagent: subagentByThreadId.get(threadId),
      thread: graph.nodes.get(threadId)?.thread ?? null,
      status,
    });

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return {
    busyAction,
    canDetach,
    canMerge,
    chatRows,
    detach,
    graph,
    hiddenChatCount,
    hiddenCount,
    latestMergeBackRun,
    lineageRows,
    merge,
    mergeTargetThreadId,
    openChat,
    openThread,
    parentMenuItems,
    parentTitle,
    previousAgentRows,
    hiddenPreviousCount,
    providerIcon,
    providersFor,
    runningAgentCount,
    runParentMenuAction,
    showParentContextMenu,
    settleChat,
    settlingThreadId,
    showMore,
    showMoreChats,
    showMorePrevious,
    subagentDetails,
    threadId: props.threadId,
    visibleChatRows,
    visiblePreviousRows,
    visibleRows,
  } as const;
}

type ThreadParentMenuAction = "set-parent" | "move-to-threads-list";

type ThreadRelationshipsModel = ReturnType<typeof useThreadRelationshipsModel>;
const ThreadRelationshipsContext = createContext<ThreadRelationshipsModel | null>(null);

export function ThreadRelationshipsProvider(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const model = useThreadRelationshipsModel(props);
  return <ThreadRelationshipsContext value={model}>{props.children}</ThreadRelationshipsContext>;
}

function useThreadRelationshipsContext(): ThreadRelationshipsModel {
  const model = useContext(ThreadRelationshipsContext);
  if (model === null) {
    throw new Error("Thread relationship sections must be inside ThreadRelationshipsProvider");
  }
  return model;
}

export function ThreadChatsPanel() {
  const {
    chatRows,
    graph,
    hiddenChatCount,
    openChat,
    parentMenuItems,
    settleChat,
    settlingThreadId,
    showMoreChats,
    showParentContextMenu,
    visibleChatRows,
  } = useThreadRelationshipsContext();

  return chatRows.length > 0 ? (
    <section
      aria-labelledby="thread-details-chats-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-chats-panel
    >
      <div className="mb-1 flex min-h-8 items-center px-2">
        <h3
          id="thread-details-chats-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Forks &amp; side chats
        </h3>
      </div>
      <ThreadLineageRowList
        ariaLabel="Forks and side chats"
        hiddenCount={hiddenChatCount}
        onShowMore={showMoreChats}
      >
        {visibleChatRows.map(({ threadId }) => {
          const node = graph.nodes.get(threadId);
          const thread = node?.thread;
          if (!thread) return null;
          const kind = resolveThreadForkKind(thread) ?? "manual";
          const isSideChat = kind === "side_chat";
          const ChatIcon = isSideChat ? MessagesSquareIcon : GitForkIcon;
          const label = isSideChat ? "Side chat" : "Forked";
          return (
            <li
              key={threadId}
              className="group flex h-9 items-center rounded-lg"
              onContextMenu={(event) => {
                if (parentMenuItems(threadId).length === 0) return;
                event.preventDefault();
                showParentContextMenu(threadId, { x: event.clientX, y: event.clientY });
              }}
            >
              <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={node.missing}
                        onClick={() => openChat(threadId)}
                        className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                      />
                    }
                  >
                    <ChatIcon aria-label={label} className={THREAD_RELATIONSHIP_ICON_CLASS} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-4 text-foreground/85">
                      {thread.title}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="left">{label}</TooltipPopup>
                </Tooltip>
                <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
                        aria-label={`Settle ${isSideChat ? "side chat" : "fork"} ${thread.title}`}
                        disabled={settlingThreadId !== null}
                        onClick={() => void settleChat(threadId, kind)}
                      />
                    }
                  >
                    {settlingThreadId === threadId ? (
                      <LoaderCircleIcon className="size-3 animate-spin" />
                    ) : (
                      <CheckIcon className="size-3" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="left">
                    Settle {isSideChat ? "side chat" : "fork"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </li>
          );
        })}
      </ThreadLineageRowList>
    </section>
  ) : null;
}

function ThreadParentMenuItems(props: {
  readonly items: ReadonlyArray<ContextMenuItem<ThreadParentMenuAction>>;
  readonly onAction: (action: ThreadParentMenuAction) => void;
}) {
  return props.items.map((item) => (
    <MenuItem key={item.id} onClick={() => props.onAction(item.id)}>
      {item.id === "set-parent" ? (
        <CornerDownRightIcon className="size-3.5" />
      ) : (
        <ListIcon className="size-3.5" />
      )}
      {item.label}
    </MenuItem>
  ));
}

function SubagentDetailsCard(props: {
  readonly title: string;
  readonly details: SubagentDetails;
  readonly providers: ReturnType<ThreadRelationshipsModel["providersFor"]>;
}) {
  const { details } = props;
  const statusLabel = agentStatusLabel(details.status);
  return (
    <div className="grid w-64 gap-1.5 py-1 text-left text-xs text-muted-foreground">
      <div className="truncate font-medium text-foreground">{props.title}</div>
      {details.providerInstanceId === null ? null : (
        <ProviderModelEndpoint
          providers={props.providers}
          instanceId={details.providerInstanceId}
          model={details.model}
        />
      )}
      {statusLabel === null ? null : (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("mx-0.5 size-2 shrink-0 rounded-full", statusDotClass(details.status))}
          />
          <span className={cn("flex-1 truncate", statusTextClass(details.status))}>
            {statusLabel}
          </span>
          <AgentElapsed
            startedAtMs={details.startedAtMs}
            completedAtMs={details.completedAtMs}
            live={details.live}
          />
        </div>
      )}
      {details.activity === null ? null : (
        <div className="flex min-w-0 items-start gap-1.5">
          <TerminalIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-3 min-w-0 break-words">{details.activity}</span>
        </div>
      )}
    </div>
  );
}

export function ThreadLineagePanel() {
  const {
    busyAction,
    canDetach,
    canMerge,
    detach,
    graph,
    hiddenCount,
    hiddenPreviousCount,
    latestMergeBackRun,
    lineageRows,
    merge,
    mergeTargetThreadId,
    openThread,
    parentMenuItems,
    parentTitle,
    previousAgentRows,
    providerIcon,
    providersFor,
    runningAgentCount,
    runParentMenuAction,
    showMore,
    showMorePrevious,
    showParentContextMenu,
    subagentDetails,
    threadId: currentThreadId,
    visiblePreviousRows,
    visibleRows,
  } = useThreadRelationshipsContext();
  const currentThreadMenuItems = parentMenuItems(currentThreadId);

  const renderRow = ({ threadId, edge }: (typeof visibleRows)[number]) => {
    const node = graph.nodes.get(threadId);
    const isSubagent = edge.kind === "subagent";
    const isMergeTarget = threadId === mergeTargetThreadId;
    const isParent = isParentThreadRelationship(edge, currentThreadId);
    const RelationshipIcon = isParent
      ? CornerLeftUpIcon
      : isSubagent
        ? (providerIcon(threadId) ?? BotIcon)
        : edge.kind === "attached"
          ? CornerDownRightIcon
          : GitForkIcon;
    const relationship = relationshipLabel(edge, currentThreadId);
    const threadTitle = relationshipThreadTitle({
      title: node?.thread?.title ?? threadId,
      isSubagent,
    });
    // Subagents this thread started get a details card; every other row keeps its one-line hint.
    const details = isSubagent && !isParent ? subagentDetails(threadId, edge.status) : null;
    const statusLabel = details === null ? null : agentStatusLabel(details.status);
    const relationshipContent = (
      <>
        <span className="relative -mx-0.5 grid size-4 shrink-0 place-items-center">
          <RelationshipIcon className={THREAD_RELATIONSHIP_ICON_CLASS} />
          <span
            className={cn(
              "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
              statusDotClass(edge.status),
            )}
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-4 text-foreground/85">
            {threadTitle}
          </span>
        </span>
        {details === null ? (
          <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        ) : (
          <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            <AgentElapsed
              startedAtMs={details.startedAtMs}
              completedAtMs={details.completedAtMs}
              live={details.live}
            />
            {statusLabel}
          </span>
        )}
      </>
    );
    const rowTooltip = node?.missing ? (
      "This related thread is unavailable"
    ) : details !== null ? (
      <SubagentDetailsCard
        title={threadTitle}
        details={details}
        providers={providersFor(threadId)}
      />
    ) : (
      `Open ${relationship.toLowerCase()} in this chat`
    );
    const rowMenuItems = parentMenuItems(threadId);
    return (
      <li
        key={threadId}
        className="group flex h-9 items-center rounded-lg"
        onContextMenu={(event) => {
          if (rowMenuItems.length === 0) return;
          event.preventDefault();
          showParentContextMenu(threadId, { x: event.clientX, y: event.clientY });
        }}
      >
        {isMergeTarget ? (
          <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                    disabled={node?.missing === true}
                    onClick={() => openThread(threadId)}
                  />
                }
              >
                {relationshipContent}
              </TooltipTrigger>
              <TooltipPopup side="left">{rowTooltip}</TooltipPopup>
            </Tooltip>
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
                    aria-label={
                      parentTitle
                        ? `Merge back to ${parentTitle}`
                        : "Merge back to source conversation"
                    }
                    disabled={!canMerge || busyAction !== null}
                    onClick={() => void merge()}
                  >
                    {busyAction === "merge" ? (
                      <LoaderCircleIcon className="size-3 animate-spin" />
                    ) : (
                      <GitMergeIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="left">
                {latestMergeBackRun === null
                  ? "Complete a run in this fork before merging it back"
                  : parentTitle
                    ? `Merge this conversation back into ${parentTitle}`
                    : "Merge this conversation back into its source"}
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={node?.missing === true}
                  onClick={() => openThread(threadId)}
                  className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
                />
              }
            >
              {relationshipContent}
            </TooltipTrigger>
            <TooltipPopup side="left">{rowTooltip}</TooltipPopup>
          </Tooltip>
        )}
        {rowMenuItems.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={cn(
                    THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
                    "shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100",
                  )}
                  aria-label={`More actions for ${threadTitle}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
              <ThreadParentMenuItems
                items={rowMenuItems}
                onAction={(action) => runParentMenuAction(threadId, action)}
              />
            </MenuPopup>
          </Menu>
        ) : null}
      </li>
    );
  };

  // With nothing related yet, the section still offers to file the open thread under another.
  const offersSetParent = currentThreadMenuItems.some(({ id }) => id === "set-parent");
  return lineageRows.length > 0 || offersSetParent ? (
    <section
      aria-labelledby="thread-details-lineage-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-relationships-panel
    >
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
        <h3
          id="thread-details-lineage-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Lineage
          {runningAgentCount > 0 ? ` · ${runningAgentCount} running` : null}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {canDetach || currentThreadMenuItems.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
                    aria-label="More thread actions"
                    disabled={busyAction !== null}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
                <ThreadParentMenuItems
                  items={currentThreadMenuItems}
                  onAction={(action) => runParentMenuAction(currentThreadId, action)}
                />
                {canDetach ? (
                  <MenuItem onClick={() => void detach()}>
                    <UnplugIcon className="size-3.5" />
                    Disconnect agent session
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      {lineageRows.length === 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => runParentMenuAction(currentThreadId, "set-parent")}
          className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
        >
          <CornerDownRightIcon className={THREAD_RELATIONSHIP_ICON_CLASS} />
          <span className="truncate text-muted-foreground">Set parent…</span>
        </Button>
      ) : (
        <>
          {visibleRows.length > 0 ? (
            <ThreadLineageRowList hiddenCount={hiddenCount} onShowMore={showMore}>
              {visibleRows.map(renderRow)}
            </ThreadLineageRowList>
          ) : null}
          {previousAgentRows.length > 0 ? (
            <Collapsible key={currentThreadId} defaultOpen={false}>
              <CollapsibleTrigger className="group/previous flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground/80">
                <span className="shrink-0">Previous agents ({previousAgentRows.length})</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border/65" />
                <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[panel-open]/previous:rotate-180" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <ThreadLineageRowList
                  ariaLabel="Previous agents"
                  hiddenCount={hiddenPreviousCount}
                  onShowMore={showMorePrevious}
                >
                  {visiblePreviousRows.map(renderRow)}
                </ThreadLineageRowList>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </>
      )}
    </section>
  ) : null;
}

/** Existing combined presentation retained for callers that do not need custom ordering. */
export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <ThreadRelationshipsProvider {...props}>
      <ThreadChatsPanel />
      <ThreadLineagePanel />
    </ThreadRelationshipsProvider>
  );
}
