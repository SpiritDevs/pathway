/**
 * The queued-message strip above the composer.
 *
 * The list is the queue: row one is the next user turn Pathway dispatches, and
 * a finished drag persists exactly one `queued-run.reorder` — the moved run
 * plus the run that should follow it — rather than a command per pointer move.
 * The dragged order is held locally until the projection echoes it back, so the
 * strip stays responsive without ever outranking the server.
 *
 * Hidden automatic completion deliveries never reach this list
 * (`deriveThreadQueueWorkflowState` filters them out) and keep the precedence
 * the server gave them; optimistic messages sit after the committed runs and
 * are neither draggable nor drop anchors until they have a run id. Provider
 * continuation wakes (agent-authored messages such as "Background command
 * completed") do appear, badged as agent-queued with edit and steer withheld,
 * so an internal wake is never mistaken for the user's own words.
 *
 * @module components/chat/QueuedRunsControl
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadQueueWorkflowState,
  isQueuedRunOrderStale,
  orderQueuedRuns,
  resolveQueuedRunReorder,
  type QueuedThreadRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  Clock3Icon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";

const EMPTY_QUEUED_RUNS: ReadonlyArray<QueuedThreadRun> = [];

const ROW_CLASS_NAME =
  "flex min-w-0 items-center gap-1 border-border/45 border-t py-1 first:border-t-0";

/**
 * Tracked live rather than read once, because the sortable's sibling animation
 * is the only motion this strip produces and the preference can change mid-session.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (query === undefined) return;
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** The queue row for a committed run while sorting is available. */
function SortableQueuedRow(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly position: number;
  readonly reducedMotion: boolean;
  readonly runId: RunId;
  readonly children: ReactNode;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: props.runId, disabled: props.disabled });

  return (
    <li
      aria-busy={props.busy}
      className={cn(
        ROW_CLASS_NAME,
        isDragging && "relative z-10 rounded-sm bg-accent/60 shadow-xs",
        props.busy && "opacity-60",
      )}
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        ...(props.reducedMotion ? {} : { transition }),
      }}
    >
      <button
        {...attributes}
        {...listeners}
        aria-label={props.label}
        className="flex size-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground/50 hover:text-foreground focus-visible:text-foreground active:cursor-grabbing disabled:cursor-default disabled:text-muted-foreground/30"
        disabled={props.disabled}
        ref={setActivatorNodeRef}
        type="button"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <QueuedRowPosition position={props.position} />
      {props.children}
    </li>
  );
}

function QueuedRowPosition(props: { readonly position: number }) {
  return (
    <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/65">
      {props.position}
    </span>
  );
}

export function QueuedRunsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<Pick<ChatMessage, "id" | "inputIntent" | "text">>;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const edit = useAtomCommand(threadEnvironment.editQueuedRun);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [dismissedMessageIds, setDismissedMessageIds] = useState<ReadonlySet<MessageId>>(
    () => new Set(),
  );
  const [editing, setEditing] = useState<{ runId: RunId; draft: string } | null>(null);
  /**
   * The order a completed drag produced, shown until the projection agrees or
   * moves on, alongside the projected order it was committed against.
   */
  const [draggedOrder, setDraggedOrder] = useState<{
    readonly order: ReadonlyArray<RunId>;
    readonly baseline: ReadonlyArray<RunId>;
  } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const projectedQueued = workflow?.queuedRuns ?? EMPTY_QUEUED_RUNS;
  const queued = useMemo(
    () => projectedQueued.filter(({ run }) => !dismissedMessageIds.has(run.userMessageId)),
    [dismissedMessageIds, projectedQueued],
  );
  const activeRun = workflow?.activeRun ?? null;
  const serverRunIds = useMemo(() => queued.map(({ run }) => run.id), [queued]);
  const ordered = useMemo(
    () => orderQueuedRuns(queued, draggedOrder?.order ?? null),
    [queued, draggedOrder],
  );
  const orderedRunIds = useMemo(() => ordered.map(({ run }) => run.id), [ordered]);

  useEffect(() => {
    if (draggedOrder === null) return;
    const stale = isQueuedRunOrderStale({
      serverRunIds,
      order: draggedOrder.order,
      baselineRunIds: draggedOrder.baseline,
    });
    if (stale) setDraggedOrder(null);
  }, [draggedOrder, serverRunIds]);

  useEffect(() => {
    setDismissedMessageIds(new Set());
  }, [props.environmentId, props.threadId]);

  const acknowledgedQueuedMessageIds = new Set([
    ...queued.map(({ run }) => run.userMessageId),
    ...(projection?.messages.map((message) => message.id) ?? []),
  ]);
  const optimisticQueued = props.optimisticMessages.filter(
    (message) =>
      message.inputIntent === "queued_turn" &&
      !acknowledgedQueuedMessageIds.has(message.id) &&
      !dismissedMessageIds.has(message.id),
  );
  const total = ordered.length + optimisticQueued.length;
  // One reorderable row cannot move, and a provider that cannot reorder its
  // queue must not advertise sorting at all.
  const sortable = workflow?.canReorder === true && ordered.length > 1;

  if (total === 0) return null;

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    try {
      const result = await reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      });
      // A rejected destination — the run started, vanished, or stopped being
      // reorderable — falls back to the projection; the command reports itself.
      if (result._tag === "Failure") setDraggedOrder(null);
    } catch {
      setDraggedOrder(null);
    } finally {
      setBusyRunId(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    const plan = resolveQueuedRunReorder({
      orderedRunIds,
      activeRunId: String(event.active.id) as RunId,
      overRunId: String(event.over.id) as RunId,
    });
    if (plan === null) return;
    setDraggedOrder({ order: plan.order, baseline: serverRunIds });
    void move(plan.runId, plan.beforeRunId);
  };

  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null) return;
    setBusyRunId(queuedRunId);
    try {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const remove = async (runId: RunId, messageId: MessageId) => {
    setDismissedMessageIds((current) => new Set(current).add(messageId));
    setBusyRunId(runId);
    try {
      const result = await cancel({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId },
      });
      if (result._tag === "Failure") {
        setDismissedMessageIds((current) => {
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      }
    } catch {
      setDismissedMessageIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const saveEdit = async (runId: RunId, originalText: string) => {
    if (editing === null || editing.runId !== runId) return;
    const text = editing.draft.trim();
    if (text.length === 0) return;
    if (text === originalText) {
      setEditing(null);
      return;
    }
    setBusyRunId(runId);
    try {
      await edit({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, text },
      });
      setEditing(null);
    } finally {
      setBusyRunId(null);
    }
  };

  const positionOf = (id: string) => orderedRunIds.indexOf(id as RunId) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up queued message ${positionOf(String(active.id))} of ${ordered.length}.`,
    onDragOver: ({ over }) =>
      over === null
        ? undefined
        : `Queued message will move to position ${positionOf(String(over.id))} of ${ordered.length}.`,
    onDragEnd: ({ active, over }) =>
      over === null
        ? `Queued message stays at position ${positionOf(String(active.id))} of ${ordered.length}.`
        : `Queued message dropped at position ${positionOf(String(over.id))} of ${ordered.length}.`,
    onDragCancel: ({ active }) =>
      `Reorder cancelled. Queued message stays at position ${positionOf(String(active.id))} of ${ordered.length}.`,
  };

  /** Everything after the handle and position: the text or its editor, and the row actions. */
  const rowBody = (input: {
    readonly runId: RunId | null;
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdBy: QueuedThreadRun["createdBy"];
  }) => {
    // Provider continuation wakes carry internal text the adapter swaps out on
    // dispatch, so editing or steering them would corrupt the wake.
    const agentAuthored = input.createdBy !== "user";
    const rowEditing =
      input.runId !== null && editing !== null && editing.runId === input.runId ? editing : null;
    if (rowEditing !== null) {
      return (
        <>
          <input
            aria-label="Edit queued message"
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-border/60 bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-border"
            value={rowEditing.draft}
            onChange={(event) =>
              setEditing((current) =>
                current === null ? current : { ...current, draft: event.target.value },
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (input.runId !== null) void saveEdit(input.runId, input.text);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Save queued message"
            className="size-6 text-muted-foreground"
            disabled={busyRunId !== null || rowEditing.draft.trim().length === 0}
            onClick={() => {
              if (input.runId !== null) void saveEdit(input.runId, input.text);
            }}
          >
            <CheckIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel editing queued message"
            className="size-6 text-muted-foreground"
            disabled={busyRunId !== null}
            onClick={() => setEditing(null)}
          >
            <XIcon className="size-3" />
          </Button>
        </>
      );
    }

    return (
      <>
        {agentAuthored ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            title="Queued automatically by an agent, not typed by you"
          >
            <BotIcon aria-hidden className="size-3" />
            Agent
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs" title={input.text}>
          {input.text}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit queued message"
          className="size-6 text-muted-foreground"
          disabled={input.runId === null || busyRunId !== null || agentAuthored}
          title={agentAuthored ? "Agent-queued messages cannot be edited" : undefined}
          onClick={() => {
            if (input.runId !== null) {
              setEditing({ runId: input.runId, draft: input.text });
            }
          }}
        >
          <PencilIcon className="size-3" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
          disabled={
            input.runId === null ||
            busyRunId !== null ||
            !workflow?.canPromoteToSteer ||
            agentAuthored
          }
          title={
            agentAuthored
              ? "Agent-queued messages cannot be sent as a steer"
              : activeRun === null
                ? "There is no active run to steer"
                : "Send as a steer instead"
          }
          onClick={() => {
            if (input.runId !== null) {
              void steer(input.runId);
            }
          }}
        >
          <CornerUpRightIcon className="size-3" />
          Steer
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Remove queued message"
          className="size-6 text-muted-foreground"
          disabled={input.runId === null || busyRunId !== null}
          title="Remove from queue"
          onClick={() => {
            if (input.runId !== null) void remove(input.runId, input.messageId);
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </>
    );
  };

  const committedRows = ordered.map(({ run, text, createdBy }, index) =>
    sortable ? (
      <SortableQueuedRow
        busy={busyRunId === run.id}
        disabled={busyRunId !== null || editing?.runId === run.id}
        key={run.id}
        label={`Reorder queued message ${index + 1} of ${ordered.length}: ${text}`}
        position={index + 1}
        reducedMotion={reducedMotion}
        runId={run.id}
      >
        {rowBody({ runId: run.id, messageId: run.userMessageId, text, createdBy })}
      </SortableQueuedRow>
    ) : (
      <li
        aria-busy={busyRunId === run.id}
        className={cn(ROW_CLASS_NAME, busyRunId === run.id && "opacity-60")}
        key={run.id}
      >
        <QueuedRowPosition position={index + 1} />
        {rowBody({ runId: run.id, messageId: run.userMessageId, text, createdBy })}
      </li>
    ),
  );

  const list = (
    <ol className="max-h-32 overflow-y-auto px-1">
      {sortable ? (
        <SortableContext items={orderedRunIds} strategy={verticalListSortingStrategy}>
          {committedRows}
        </SortableContext>
      ) : (
        committedRows
      )}
      {optimisticQueued.map((message, index) => (
        <li className={ROW_CLASS_NAME} key={message.id}>
          {/* Sits where a committed row's handle sits: visibly present, not draggable. */}
          <Clock3Icon
            aria-label="Saving queued message"
            className="size-4 shrink-0 p-px text-muted-foreground/60"
          />
          <QueuedRowPosition position={ordered.length + index + 1} />
          {rowBody({ runId: null, messageId: message.id, text: message.text, createdBy: "user" })}
        </li>
      ))}
    </ol>
  );

  return (
    <section
      aria-label={`${total} queued message${total === 1 ? "" : "s"}`}
      aria-live="polite"
      className="chat-composer-queue-strip relative z-0 -mb-4 mx-auto w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] px-2 pt-1.5 pb-5"
    >
      <header className="flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-medium text-muted-foreground">
        <ListOrderedIcon className="size-3.5" />
        <span>Queued</span>
        <span className="rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums">{total}</span>
      </header>
      {sortable ? (
        <DndContext
          accessibility={{ announcements }}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={handleDragEnd}
          sensors={sensors}
        >
          {list}
        </DndContext>
      ) : (
        list
      )}
    </section>
  );
}
