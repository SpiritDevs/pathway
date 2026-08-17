/**
 * The mobile queue card.
 *
 * Ordering is a drag, not a pair of arrows: the handle picks a row up after a
 * long press, the rows it passes slide out of the way on the UI thread, and the
 * drop sends the one `queued-run.reorder` the web composer sends — the moved
 * run plus the run that should follow it. VoiceOver gets the same move through
 * the handle's adjustable actions, because a drag is not an accessible gesture.
 *
 * @module features/threads/ThreadQueueControl
 */
import * as Haptics from "expo-haptics";
import {
  deriveThreadQueueWorkflowState,
  isQueuedRunOrderStale,
  orderQueuedRuns,
  resolveQueuedRunReorder,
} from "@spiritdevs/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@spiritdevs/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  type AccessibilityActionEvent,
  type ColorValue,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import {
  QUEUE_ROW_HEIGHT,
  buildCancelQueuedRunCommand,
  resolveQueueDropIndex,
  resolveThreadQueueRowControls,
  type ThreadQueueRowControls,
} from "./threadQueueControlPresentation";

const EMPTY_QUEUED_RUNS: ReturnType<typeof deriveThreadQueueWorkflowState>["queuedRuns"] = [];

interface QueueDragState {
  /** The row being dragged, and the row it is currently hovering over. */
  readonly activeIndex: SharedValue<number>;
  readonly overIndex: SharedValue<number>;
  readonly translateY: SharedValue<number>;
}

function QueueRow(props: {
  readonly controls: ThreadQueueRowControls;
  readonly count: number;
  readonly drag: QueueDragState;
  readonly iconColor: ColorValue;
  readonly index: number;
  readonly onDrop: (fromIndex: number, toIndex: number) => void;
  readonly onMoveBy: (index: number, offset: number) => void;
  readonly onDismiss: () => void;
  readonly onSteer: () => void;
}) {
  const { drag, index } = props;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(props.controls.canDrag)
        .activateAfterLongPress(180)
        .onStart(() => {
          drag.activeIndex.value = index;
          drag.overIndex.value = index;
          drag.translateY.value = 0;
          runOnJS(Haptics.selectionAsync)();
        })
        .onUpdate((event) => {
          drag.translateY.value = event.translationY;
          drag.overIndex.value = resolveQueueDropIndex({
            startIndex: index,
            translationY: event.translationY,
            rowHeight: QUEUE_ROW_HEIGHT,
            count: props.count,
          });
        })
        .onEnd(() => {
          runOnJS(props.onDrop)(index, drag.overIndex.value);
        })
        .onFinalize(() => {
          drag.activeIndex.value = -1;
          drag.overIndex.value = -1;
          drag.translateY.value = 0;
        }),
    [drag, index, props.controls.canDrag, props.count, props.onDrop],
  );

  // Every row's movement is derived from the same three shared values, so a
  // drag repaints on the UI thread without re-rendering the list.
  const animatedStyle = useAnimatedStyle(() => {
    const active = drag.activeIndex.value;
    if (active === -1) return { opacity: 1, transform: [{ translateY: 0 }], zIndex: 0 };
    if (active === index) {
      return { opacity: 0.92, transform: [{ translateY: drag.translateY.value }], zIndex: 10 };
    }
    const over = drag.overIndex.value;
    const shift =
      index > active && index <= over
        ? -QUEUE_ROW_HEIGHT
        : index < active && index >= over
          ? QUEUE_ROW_HEIGHT
          : 0;
    return { opacity: 1, transform: [{ translateY: shift }], zIndex: 0 };
  });

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "decrement" && props.controls.canMoveUp) {
      props.onMoveBy(index, -1);
    }
    if (event.nativeEvent.actionName === "increment" && props.controls.canMoveDown) {
      props.onMoveBy(index, 1);
    }
  };

  return (
    <Animated.View
      className="flex-row items-center gap-1.5 bg-card px-2"
      style={[{ height: QUEUE_ROW_HEIGHT }, animatedStyle]}
    >
      <GestureDetector gesture={gesture}>
        <Pressable
          accessibilityActions={[
            { name: "decrement", label: "Move up" },
            { name: "increment", label: "Move down" },
          ]}
          accessibilityLabel={props.controls.reorderAccessibilityLabel}
          accessibilityRole="adjustable"
          accessibilityValue={{ text: props.controls.positionAccessibilityText }}
          className="h-9 w-7 items-center justify-center disabled:opacity-30"
          disabled={!props.controls.canDrag}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <SymbolView
            name="line.3.horizontal"
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
        </Pressable>
      </GestureDetector>
      <Text className="w-5 text-right text-3xs tabular-nums text-foreground-muted">
        {index + 1}
      </Text>
      {props.controls.agentAuthored ? (
        <View
          accessibilityLabel="Queued automatically by an agent"
          className="rounded-full bg-neutral-200/70 px-1.5 py-px dark:bg-white/[0.1]"
        >
          <Text className="font-pathway-medium text-3xs text-foreground-muted">Agent</Text>
        </View>
      ) : null}
      <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
        {props.controls.displayText}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Promote queued message to steer"
        disabled={!props.controls.canSteer}
        onPress={props.onSteer}
        className="min-h-8 flex-row items-center gap-1 rounded-lg border border-neutral-300/60 px-2 disabled:opacity-30 dark:border-white/[0.1]"
      >
        <SymbolView
          name="arrow.turn.left.up"
          size={12}
          tintColor={props.iconColor}
          type="monochrome"
        />
        <Text className="font-pathway-medium text-2xs text-foreground">Steer</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.controls.dismissAccessibilityLabel}
        disabled={!props.controls.canDismiss}
        onPress={props.onDismiss}
        className="h-9 w-9 items-center justify-center disabled:opacity-30"
      >
        <SymbolView name="xmark" size={13} tintColor={props.iconColor} type="monochrome" />
      </Pressable>
    </Animated.View>
  );
}

export function ThreadQueueControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scoped = useThreadProjection(props);
  const workflow = useMemo(
    () => (scoped ? deriveThreadQueueWorkflowState(scoped.projection) : null),
    [scoped],
  );
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "cancel queued message");
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  /**
   * The order a completed drag produced, shown until the projection agrees or
   * moves on, alongside the projected order it was committed against.
   */
  const [draggedOrder, setDraggedOrder] = useState<{
    readonly order: ReadonlyArray<RunId>;
    readonly baseline: ReadonlyArray<RunId>;
  } | null>(null);
  const iconColor = useThemeColor("--color-icon-subtle");
  const activeIndex = useSharedValue(-1);
  const overIndex = useSharedValue(-1);
  const translateY = useSharedValue(0);
  const drag = useMemo(
    () => ({ activeIndex, overIndex, translateY }),
    [activeIndex, overIndex, translateY],
  );

  const queued = workflow?.queuedRuns ?? EMPTY_QUEUED_RUNS;
  const serverRunIds = useMemo(() => queued.map(({ run }) => run.id), [queued]);
  const ordered = useMemo(
    () => orderQueuedRuns(queued, draggedOrder?.order ?? null),
    [queued, draggedOrder],
  );
  // Gestures are created once per row; they read the queue through this ref so
  // a projection that arrives mid-drag cannot be dropped on the floor.
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const serverRunIdsRef = useRef(serverRunIds);
  serverRunIdsRef.current = serverRunIds;

  useEffect(() => {
    if (draggedOrder === null) return;
    const stale = isQueuedRunOrderStale({
      serverRunIds,
      order: draggedOrder.order,
      baselineRunIds: draggedOrder.baseline,
    });
    if (stale) setDraggedOrder(null);
  }, [draggedOrder, serverRunIds]);

  const move = useCallback(
    async (runId: RunId, beforeRunId: RunId | null) => {
      setBusyRunId(runId);
      void Haptics.selectionAsync();
      const result = await reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      });
      // A rejected destination falls back to the projection; the command reports itself.
      if (result._tag === "Failure") setDraggedOrder(null);
      setBusyRunId(null);
    },
    [props.environmentId, props.threadId, reorder],
  );

  const moveBetween = useCallback(
    (fromIndex: number, toIndex: number) => {
      const runIds = orderedRef.current.map(({ run }) => run.id);
      const activeRunId = runIds[fromIndex];
      const overRunId = runIds[toIndex];
      if (activeRunId === undefined || overRunId === undefined) return;
      const plan = resolveQueuedRunReorder({ orderedRunIds: runIds, activeRunId, overRunId });
      if (plan === null) return;
      setDraggedOrder({ order: plan.order, baseline: serverRunIdsRef.current });
      void move(plan.runId, plan.beforeRunId);
    },
    [move],
  );

  const moveBy = useCallback(
    (index: number, offset: number) => moveBetween(index, index + offset),
    [moveBetween],
  );

  const steer = async (queuedRunId: RunId) => {
    if (!workflow?.activeRun || !workflow.canPromoteToSteer) return;
    setBusyRunId(queuedRunId);
    void Haptics.selectionAsync();
    await promote({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        queuedRunId,
        targetRunId: workflow.activeRun.id,
      },
    });
    setBusyRunId(null);
  };

  const dismiss = async (runId: RunId) => {
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    await cancel(
      buildCancelQueuedRunCommand({
        environmentId: props.environmentId,
        runId,
        threadId: props.threadId,
      }),
    );
    setBusyRunId(null);
  };

  if (!workflow || ordered.length === 0) return null;

  return (
    <View className="mx-4 mb-3 overflow-hidden rounded-2xl border border-neutral-300/60 bg-card dark:border-white/[0.1]">
      <View className="flex-row items-center gap-2 border-b border-neutral-300/50 px-3 py-2 dark:border-white/[0.08]">
        <SymbolView name="list.number" size={13} tintColor={iconColor} type="monochrome" />
        <Text className="font-pathway-medium text-xs text-foreground">Queue</Text>
        <Text className="ml-auto text-2xs tabular-nums text-foreground-muted">
          {ordered.length}
        </Text>
      </View>
      <ScrollView style={{ maxHeight: 156 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {ordered.map(({ run, text, createdBy }, index) => (
          <QueueRow
            controls={resolveThreadQueueRowControls({
              busy: busyRunId !== null,
              canPromoteToSteer: workflow.canPromoteToSteer,
              canReorder: workflow.canReorder,
              createdBy,
              index,
              queuedCount: ordered.length,
              text,
            })}
            count={ordered.length}
            drag={drag}
            iconColor={iconColor}
            index={index}
            key={run.id}
            onDismiss={() => void dismiss(run.id)}
            onDrop={moveBetween}
            onMoveBy={moveBy}
            onSteer={() => void steer(run.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
