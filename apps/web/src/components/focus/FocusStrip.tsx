import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ALL_FOCUS_ID,
  sortFocuses,
  visibleFocuses,
  type ActiveFocusId,
} from "@spiritdevs/client-runtime/state/focuses";
import type {
  Focus,
  FocusAssignment,
  FocusId,
  FocusNotification,
} from "@spiritdevs/contracts/focus";
import { BellIcon, Layers3Icon, PlusIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { FocusMutations } from "../../cloud/focusReadModel";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { FocusEditor, type FocusProjectOption } from "./FocusEditor";
import { FocusIcon } from "./FocusIcon";
import { FocusNotificationTray } from "./FocusNotificationTray";
import { focusOrderKeyForMove } from "./FocusStrip.logic";

export interface FocusNotificationBadgeProps {
  readonly unreadCount: number;
  readonly onOpen?: () => void;
}

export const FocusNotificationBadge = memo(function FocusNotificationBadge(
  props: FocusNotificationBadgeProps,
) {
  const label =
    props.unreadCount === 0
      ? "No unread notifications"
      : `${props.unreadCount} unread notification${props.unreadCount === 1 ? "" : "s"}`;
  const content = (
    <>
      <BellIcon aria-hidden className="size-3.5" />
      {props.unreadCount > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-0.5 text-center text-[8px] font-semibold leading-3.5 text-primary-foreground tabular-nums">
          {props.unreadCount > 99 ? "99+" : props.unreadCount}
        </span>
      ) : (
        <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-muted-foreground/35" />
      )}
    </>
  );
  const className =
    "relative flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";
  return props.onOpen ? (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={props.onOpen}
      className={className}
    >
      {content}
    </button>
  ) : (
    <span role="status" aria-label={label} title={label} className={className}>
      {content}
    </span>
  );
});

function FocusTabVisual(props: {
  readonly active: boolean;
  readonly accentColor?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      data-focus-magnify
      className="relative flex size-4 origin-center items-center justify-center transform-gpu transition-transform duration-150 ease-out [transform:scale(var(--focus-scale,0.68))] motion-reduce:transform-none motion-reduce:transition-none"
      style={{ color: props.accentColor }}
    >
      {props.children}
      {props.active ? (
        <span
          aria-hidden
          className="absolute -bottom-1 size-1 rounded-full bg-current"
          style={{ color: props.accentColor }}
        />
      ) : null}
    </span>
  );
}

const SortableFocusTab = memo(function SortableFocusTab(props: {
  readonly focus: Focus;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.focus.id,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      aria-selected={props.active}
      aria-label={props.focus.name}
      title={props.focus.name}
      onClick={props.onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onEdit();
      }}
      className={cn(
        "flex h-7 w-6 shrink-0 cursor-pointer touch-none items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        props.active && "bg-sidebar-row-active",
        isDragging && "z-10 opacity-80",
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...listeners}
    >
      <FocusTabVisual active={props.active} accentColor={props.focus.accentColor}>
        <FocusIcon iconName={props.focus.iconName} className="size-4" />
      </FocusTabVisual>
    </button>
  );
});

export function FocusStrip(props: {
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<FocusAssignment>;
  readonly visibleProjectKeys: ReadonlySet<string>;
  readonly activeFocusId: ActiveFocusId;
  readonly onActiveFocusChange: (focusId: ActiveFocusId) => void;
  readonly editorProjects: ReadonlyArray<FocusProjectOption>;
  readonly unreadCount: number;
  readonly notifications: ReadonlyArray<FocusNotification>;
  readonly threadTitlesByKey: ReadonlyMap<string, string>;
  readonly projectNamesByKey: ReadonlyMap<string, string>;
  readonly onNotificationSelect: (notification: FocusNotification) => void;
  readonly mutations: FocusMutations | null;
}) {
  const [editorFocusId, setEditorFocusId] = useState<FocusId | null | undefined>(undefined);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const orderedFocuses = useMemo(() => sortFocuses(props.focuses), [props.focuses]);
  const shownFocuses = useMemo(
    () =>
      visibleFocuses({
        focuses: props.focuses,
        assignments: props.assignments,
        visibleProjectKeys: props.visibleProjectKeys,
      }),
    [props.focuses, props.assignments, props.visibleProjectKeys],
  );
  const editingFocus =
    editorFocusId == null
      ? null
      : (orderedFocuses.find((focus) => focus.id === editorFocusId) ?? null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const reducedMotionQueryRef = useRef<MediaQueryList | null>(null);

  const resetMagnification = useCallback((element: HTMLDivElement) => {
    for (const item of element.querySelectorAll<HTMLElement>("[data-focus-magnify]")) {
      item.style.removeProperty("--focus-scale");
    }
  }, []);
  const magnify = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      reducedMotionQueryRef.current ??= window.matchMedia("(prefers-reduced-motion: reduce)");
      if (reducedMotionQueryRef.current.matches) {
        resetMagnification(element);
        return;
      }
      const items = [...element.querySelectorAll<HTMLElement>("[data-focus-magnify]")];
      const scales = items.map((item) => {
        const rect = item.getBoundingClientRect();
        const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
        return 0.68 + 0.62 * Math.exp(-(distance * distance) / 700);
      });
      for (const [index, item] of items.entries()) {
        item.style.setProperty("--focus-scale", scales[index]!.toFixed(3));
      }
    },
    [resetMagnification],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.over === null || event.active.id === event.over.id || props.mutations === null)
        return;
      const moved = orderedFocuses.find((focus) => focus.id === event.active.id);
      const over = orderedFocuses.find((focus) => focus.id === event.over?.id);
      if (moved === undefined || over === undefined) return;
      const orderKey = focusOrderKeyForMove(orderedFocuses, moved.id, over.id);
      if (orderKey === null) return;
      void props.mutations.reorder({ focusId: moved.id, orderKey }).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reorder Focuses",
          description: error instanceof Error ? error.message : "The new order was not saved.",
        });
      });
    },
    [orderedFocuses, props.mutations],
  );
  const openNotifications = useCallback(() => {
    setEditorFocusId(undefined);
    setNotificationsOpen(true);
    void props.mutations?.markAllNotificationsRead().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not mark notifications read",
        description: error instanceof Error ? error.message : "The notifications stayed unread.",
      });
    });
  }, [props.mutations]);
  const selectNotification = useCallback(
    (notification: FocusNotification) => {
      props.onNotificationSelect(notification);
      setNotificationsOpen(false);
    },
    [props.onNotificationSelect],
  );

  return (
    <Popover
      open={editorFocusId !== undefined || notificationsOpen}
      onOpenChange={(open) => {
        if (!open) {
          setEditorFocusId(undefined);
          setNotificationsOpen(false);
        }
      }}
    >
      <div
        ref={setStripElement}
        className="relative flex h-9 shrink-0 items-center border-t border-sidebar-border/60 px-2"
        onPointerMove={magnify}
        onPointerLeave={(event) => resetMagnification(event.currentTarget)}
      >
        <div
          role="tablist"
          aria-label="Focuses"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            role="tab"
            aria-selected={props.activeFocusId === ALL_FOCUS_ID}
            aria-label="All Focus"
            title="All"
            onClick={() => props.onActiveFocusChange(ALL_FOCUS_ID)}
            className={cn(
              "flex h-7 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              props.activeFocusId === ALL_FOCUS_ID &&
                "bg-sidebar-row-active text-sidebar-foreground",
            )}
          >
            <FocusTabVisual active={props.activeFocusId === ALL_FOCUS_ID}>
              <Layers3Icon className="size-4" />
            </FocusTabVisual>
          </button>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={shownFocuses.map((focus) => focus.id)}
              strategy={horizontalListSortingStrategy}
            >
              {shownFocuses.map((focus) => (
                <SortableFocusTab
                  key={focus.id}
                  focus={focus}
                  active={props.activeFocusId === focus.id}
                  onSelect={() => props.onActiveFocusChange(focus.id)}
                  onEdit={() => {
                    setNotificationsOpen(false);
                    setEditorFocusId(focus.id);
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
          <FocusNotificationBadge unreadCount={props.unreadCount} onOpen={openNotifications} />
          <button
            type="button"
            aria-label="Create Focus"
            title="Create Focus"
            onClick={() => {
              setNotificationsOpen(false);
              setEditorFocusId(null);
            }}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {notificationsOpen ? (
        <PopoverPopup
          anchor={stripElement}
          side="top"
          align="end"
          sideOffset={6}
          className="max-w-[calc(100vw-1rem)]"
          viewportClassName="p-0"
        >
          <FocusNotificationTray
            notifications={props.notifications}
            unreadCount={props.unreadCount}
            focuses={orderedFocuses}
            assignments={props.assignments}
            threadTitlesByKey={props.threadTitlesByKey}
            projectNamesByKey={props.projectNamesByKey}
            onSelect={selectNotification}
          />
        </PopoverPopup>
      ) : editorFocusId !== undefined ? (
        <PopoverPopup
          anchor={stripElement}
          side="top"
          align="start"
          sideOffset={6}
          className="max-w-[calc(100vw-1rem)]"
          viewportClassName="p-3"
        >
          <FocusEditor
            key={editingFocus?.id ?? "create"}
            focus={editingFocus}
            focuses={orderedFocuses}
            assignments={props.assignments}
            projects={props.editorProjects}
            mutations={props.mutations}
            onClose={() => setEditorFocusId(undefined)}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
