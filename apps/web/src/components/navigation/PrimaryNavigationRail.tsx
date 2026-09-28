import { OrchestratorAvatar } from "../orchestrator/OrchestratorAvatar";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS, getEventCoordinates } from "@dnd-kit/utilities";
import {
  BotIcon,
  CalendarDaysIcon,
  Clock3Icon,
  ContactRoundIcon,
  FolderKanbanIcon,
  GitPullRequestIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MailIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useRouterState } from "@tanstack/react-router";

import { useCalendarViewer } from "../../cloud/calendarReadModel";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import {
  canOpenPageWindows,
  canTearOutByDrag,
  closeAllPageWindows,
  closePageWindow,
  usePageWindows,
  type PageWindow,
} from "../../panes/pageWindows";
import {
  closeAllSidePanes,
  closePaneById,
  openDestinationInPane,
  openDestinationInWindow,
  readPaneHref,
} from "../../panes/paneActions";
import type { PaneDestination } from "../../panes/paneDestinations";
import {
  describeDragGhost,
  endDragGhost,
  prepareDragGhost,
  setDragGhostOutside,
} from "../../panes/dragGhost";
import { isSplit, PRIMARY_PANE_ID } from "../../panes/paneLayout";
import { getPaneRouter } from "../../panes/paneRouters";
import { usePaneStore } from "../../panes/paneStore";
import {
  beginRailDrag,
  endRailDrag,
  handleRailDragEndedOutsideWindow,
  resolveRailDragTarget,
  updateRailDragTarget,
  useRailDragStore,
  type RailDragGeometry,
  type RailDragTarget,
} from "../../panes/railDrag";
import { useEmailUnreadTotal } from "../../state/email";
import { SidebarProviderUpdatePill } from "../sidebar/SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildRailPageMenu,
  findPanesShowing,
  findWindowsShowing,
  resolveHrefDestination,
  type RailPageMenuAction,
} from "./railPageMenu";

export const PRIMARY_NAVIGATION_COMPACT_WIDTH = "3.5rem";
export const PRIMARY_NAVIGATION_EXPANDED_WIDTH = "13rem";
export const PRIMARY_NAVIGATION_EXPANDED_STORAGE_KEY = "pathway:primary-navigation-expanded";
const PRIMARY_NAVIGATION_FIXED_BOTTOM_ITEM_COUNT = 2;

export const PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS = [
  "threads",
  "projects",
  "issues",
  "pull-requests",
  "calendar",
  "email",
  "contacts",
  "time-tracker",
] as const;

export type MovablePrimaryNavigationDestination =
  (typeof PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS)[number];

export function resolvePrimaryNavigationViewOrder(
  preference: readonly string[],
): readonly MovablePrimaryNavigationDestination[] {
  const movableDestinations = new Set<string>(PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS);
  const seen = new Set<string>();
  const resolved: MovablePrimaryNavigationDestination[] = [];

  for (const destination of preference) {
    if (!movableDestinations.has(destination) || seen.has(destination)) continue;
    seen.add(destination);
    resolved.push(destination as MovablePrimaryNavigationDestination);
  }

  for (const destination of PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS) {
    if (!seen.has(destination)) resolved.push(destination);
  }

  return resolved;
}

export function movePrimaryNavigationDestination(
  order: readonly MovablePrimaryNavigationDestination[],
  destination: MovablePrimaryNavigationDestination,
  direction: "up" | "down",
): readonly MovablePrimaryNavigationDestination[] {
  const fromIndex = order.indexOf(destination);
  if (fromIndex < 0) return order;
  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  if (toIndex < 0 || toIndex >= order.length) return order;
  return arrayMove([...order], fromIndex, toIndex);
}

export function resolvePrimaryNavigationRailWidth(expanded: boolean): string {
  return expanded ? PRIMARY_NAVIGATION_EXPANDED_WIDTH : PRIMARY_NAVIGATION_COMPACT_WIDTH;
}

export type PrimaryNavigationDestination =
  | "dashboard"
  | "threads"
  | "projects"
  | "issues"
  | "pull-requests"
  | "calendar"
  | "email"
  | "contacts"
  | "time-tracker"
  | "orchestrator"
  | "settings";

export type RememberedThreadRoute =
  | { kind: "draft"; draftId: string }
  | { kind: "thread"; environmentId: string; threadId: string };

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function resolveRememberedThreadRoute(
  pathname: string,
  previous: RememberedThreadRoute | null,
): RememberedThreadRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "threads") return previous;
  if (segments.length === 1) return null;

  if (segments.length === 3 && segments[1] === "draft") {
    const draftId = decodePathSegment(segments[2] ?? "");
    return draftId ? { kind: "draft", draftId } : null;
  }

  if (segments.length === 3) {
    const environmentId = decodePathSegment(segments[1] ?? "");
    const threadId = decodePathSegment(segments[2] ?? "");
    return environmentId && threadId ? { kind: "thread", environmentId, threadId } : null;
  }

  return null;
}

export function resolvePrimaryNavigationDestination(
  pathname: string,
): PrimaryNavigationDestination {
  if (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return "dashboard";
  }
  if (pathname === "/pull-requests" || pathname.startsWith("/pull-requests/")) {
    return "pull-requests";
  }
  if (pathname === "/projects" || pathname.startsWith("/projects/")) {
    return "projects";
  }
  if (pathname === "/issues" || pathname.startsWith("/issues/")) {
    return "issues";
  }
  if (pathname === "/calendar" || pathname.startsWith("/calendar/")) {
    return "calendar";
  }
  if (pathname === "/email" || pathname.startsWith("/email/")) {
    return "email";
  }
  if (pathname === "/contacts" || pathname.startsWith("/contacts/")) {
    return "contacts";
  }
  if (pathname === "/time-tracker" || pathname.startsWith("/time-tracker/")) {
    return "time-tracker";
  }
  if (pathname === "/orchestrator" || pathname.startsWith("/orchestrator/")) {
    return "orchestrator";
  }
  if (
    pathname === "/usage" ||
    pathname.startsWith("/usage/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  ) {
    return "settings";
  }
  return "threads";
}

type NavigationRailButtonProps = {
  active?: boolean;
  expanded: boolean;
  icon: LucideIcon;
  avatar?: React.ReactNode;
  label: string;
  reorderable?: boolean;
  /** Unread work behind this destination; zero renders nothing. */
  badgeCount?: number;
  /** Also showing in a pane other than the focused one. */
  openInPane?: boolean;
  /** Also showing in a page window. */
  openInWindow?: boolean;
  onClick?: ComponentProps<typeof Button>["onClick"];
  onContextMenu?: ComponentProps<typeof Button>["onContextMenu"];
};

type MobileNavigationItem = {
  avatar?: React.ReactNode;
  destination: PrimaryNavigationDestination;
  icon: LucideIcon;
  label: string;
  badgeCount?: number;
  onNavigate: () => void;
};

type MobileNavigationExpansionMode = "closed" | "hover" | "engaged";

/** Three digits never fit a rail button, and past ninety-nine the exact number stops mattering. */
export function formatNavigationBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Pane and window pips, drawn under the icon when compact and after the label when expanded. */
function OpenPlacementMarks({
  expanded,
  openInPane,
  openInWindow,
}: {
  expanded: boolean;
  openInPane: boolean;
  openInWindow: boolean;
}) {
  if (!openInPane && !openInWindow) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none flex items-center gap-0.5",
        expanded ? "shrink-0" : "absolute bottom-0.5 left-1/2 -translate-x-1/2",
      )}
    >
      {openInPane ? <span className="size-1.5 rounded-full bg-primary" /> : null}
      {openInWindow ? <span className="size-1.5 rounded-full border border-primary" /> : null}
    </span>
  );
}

function describeOpenPlacements(openInPane: boolean, openInWindow: boolean): string {
  if (openInPane && openInWindow) return " · Open in a panel and a window";
  if (openInPane) return " · Open in a panel";
  if (openInWindow) return " · Open in a window";
  return "";
}

function NavigationRailButton({
  active = false,
  expanded,
  icon: Icon,
  avatar,
  label,
  reorderable = false,
  badgeCount = 0,
  openInPane = false,
  openInWindow = false,
  onClick,
  onContextMenu,
}: NavigationRailButtonProps) {
  const badgeLabel = badgeCount > 0 ? formatNavigationBadgeCount(badgeCount) : null;

  return (
    <div className="relative flex w-full justify-center">
      {active ? (
        // Offsets the nav's px-2 so the marker sits flush against the content frame's edge.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1.5 -right-2 w-[3px] rounded-l-full bg-primary"
        />
      ) : null}
      <Tooltip disabled={expanded}>
        <TooltipTrigger
          render={
            <Button
              aria-current={active ? "page" : undefined}
              aria-label={badgeLabel === null ? label : `${label}, ${badgeCount} unread`}
              className={cn(
                "relative h-9! overflow-hidden [-webkit-app-region:no-drag] [--control-icon-color:var(--sidebar-muted-foreground)]",
                "hover:[--control-icon-color:var(--sidebar-foreground)]",
                expanded ? "w-full justify-start gap-2 px-2.5" : "w-9 gap-0 px-0",
                active &&
                  "bg-sidebar-accent text-sidebar-accent-foreground [--control-icon-color:var(--sidebar-accent-foreground)]",
              )}
              onClick={onClick}
              onContextMenu={onContextMenu}
              size="icon-lg"
              style={{ width: expanded ? "100%" : "2.25rem" }}
              variant="ghost"
            >
              {avatar ?? <Icon className="size-5" />}
              {expanded ? (
                <span className="min-w-0 flex-1 truncate text-left text-sm">{label}</span>
              ) : null}
              <OpenPlacementMarks
                expanded={expanded}
                openInPane={openInPane}
                openInWindow={openInWindow}
              />
              {badgeLabel === null ? null : expanded ? (
                <span className="shrink-0 rounded-full bg-sidebar-accent px-1.5 text-[11px] leading-4 font-medium text-sidebar-accent-foreground tabular-nums">
                  {badgeLabel}
                </span>
              ) : (
                // Inside the button's bounds: the rail clips its overflow, so a corner pill has to
                // sit within it rather than straddle the edge.
                <span className="absolute top-0.5 right-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-[0.875rem] font-semibold text-primary-foreground tabular-nums">
                  {badgeLabel}
                </span>
              )}
            </Button>
          }
        />
        <TooltipPopup side="right" sideOffset={8}>
          {badgeLabel === null ? label : `${label} · ${badgeLabel} unread`}
          {describeOpenPlacements(openInPane, openInWindow)}
          {reorderable ? " · Drag to reorder" : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

type RailPageButtonProps = {
  active: boolean;
  expanded: boolean;
  openInPane: boolean;
  openInWindow: boolean;
  onClick: ComponentProps<typeof Button>["onClick"];
  onContextMenu: ComponentProps<typeof Button>["onContextMenu"];
};

function SortableNavigationRailButton({
  active,
  expanded,
  item,
  openInPane,
  openInWindow,
  onClick,
  onContextMenu,
}: RailPageButtonProps & {
  item: MobileNavigationItem & { destination: MovablePrimaryNavigationDestination };
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.destination,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={cn("w-full touch-none", isDragging && "z-10 opacity-70")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <NavigationRailButton
        active={active}
        badgeCount={item.badgeCount ?? 0}
        expanded={expanded}
        icon={item.icon}
        label={item.label}
        onClick={onClick}
        onContextMenu={onContextMenu}
        openInPane={openInPane}
        openInWindow={openInWindow}
        reorderable
      />
    </div>
  );
}

/** A fixed rail page that can still be dragged out to open beside the others. It never moves in the rail. */
function DraggableNavigationRailButton({
  item,
  ...props
}: RailPageButtonProps & { item: MobileNavigationItem & { destination: PaneDestination } }) {
  const { listeners, setNodeRef } = useDraggable({ id: item.destination });
  return (
    <div ref={setNodeRef} {...listeners} className="w-full touch-none">
      <NavigationRailButton
        {...props}
        badgeCount={item.badgeCount ?? 0}
        icon={item.icon}
        label={item.label}
      />
    </div>
  );
}

/**
 * Follows the pointer once a drag leaves the rail, where the rail's own overflow
 * would clip the button. Past the window's edge the desktop shell draws a copy of
 * it instead, so this one steps aside there.
 */
function RailDragChip({
  icon: Icon,
  label,
  ref,
  outside,
}: {
  icon: LucideIcon;
  label: string;
  ref: Ref<HTMLDivElement>;
  outside: boolean;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none inline-flex items-center gap-2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-lg",
        outside && "opacity-0",
      )}
    >
      <Icon className="size-4" />
      {label}
    </div>
  );
}

type DragPointerSource = { readonly activatorEvent: Event | null };

function resolveDragTarget(
  geometry: RailDragGeometry | null,
  activatorEvent: Event | null,
  delta: { readonly x: number; readonly y: number },
): RailDragTarget {
  const origin = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!geometry || !origin) return { kind: "rail" };
  return resolveRailDragTarget({ x: origin.x + delta.x, y: origin.y + delta.y }, geometry);
}

function readDragScreenPoint(
  { activatorEvent }: DragPointerSource,
  delta: { readonly x: number; readonly y: number },
) {
  if (!(activatorEvent instanceof MouseEvent)) return null;
  return { x: activatorEvent.screenX + delta.x, y: activatorEvent.screenY + delta.y };
}

function measureRailDragGeometry(rail: HTMLElement | null): RailDragGeometry | null {
  const row = document.querySelector("[data-pane-row]")?.getBoundingClientRect();
  if (!rail || !row) return null;
  return {
    railRight: rail.getBoundingClientRect().right,
    row: { left: row.left, top: row.top, width: row.width, height: row.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

const PRIMARY_PANE_TOKEN = "@primary";

/**
 * Pages showing somewhere other than the focused pane: in another pane of the
 * split, or in a page window. The focused pane's page already has the active marker.
 */
function useOpenPlacements(pageWindows: readonly PageWindow[]) {
  // The app router, not the focused pane's: the primary pane may be one of the others.
  const primaryRouter = getPaneRouter(PRIMARY_PANE_ID);
  const primaryDestination = useRouterState({
    ...(primaryRouter ? { router: primaryRouter } : {}),
    select: (state) => resolvePrimaryNavigationDestination(state.location.pathname),
  });
  const otherPanesKey = usePaneStore((state) => {
    const { panes, focusedPaneId } = state.layout;
    if (panes.length < 2) return "";
    return panes
      .filter((entry) => entry.id !== focusedPaneId)
      .map((entry) =>
        entry.id === PRIMARY_PANE_ID ? PRIMARY_PANE_TOKEN : resolveHrefDestination(entry.href),
      )
      .join(",");
  });
  const inPane = useMemo(
    () =>
      new Set(
        otherPanesKey
          .split(",")
          .filter(Boolean)
          .map((token) => (token === PRIMARY_PANE_TOKEN ? primaryDestination : token)),
      ),
    [otherPanesKey, primaryDestination],
  );
  const inWindow = useMemo(
    () => new Set<string>(pageWindows.map((entry) => resolveHrefDestination(entry.href))),
    [pageWindows],
  );
  return { inPane, inWindow };
}

function isMovableDestination(
  destination: PaneDestination,
): destination is MovablePrimaryNavigationDestination {
  return (PRIMARY_NAVIGATION_MOVABLE_DESTINATIONS as readonly string[]).includes(destination);
}

export function MobileNavigationToolbar({
  activeDestination,
  items,
}: {
  activeDestination: PrimaryNavigationDestination;
  items: readonly MobileNavigationItem[];
}) {
  const [expansionMode, setExpansionMode] = useState<MobileNavigationExpansionMode>("closed");
  const expanded = expansionMode !== "closed";
  const toolbarRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const collapse = useCallback((restoreFocus = false) => {
    setExpansionMode("closed");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const toolbar = toolbarRef.current;
    const activeItem = toolbar?.querySelector<HTMLElement>('[aria-current="page"]');
    const firstItem = toolbar?.querySelector<HTMLElement>("[data-mobile-navigation-item]");
    const focusFrame =
      expansionMode === "engaged"
        ? window.requestAnimationFrame(() => (activeItem ?? firstItem)?.focus())
        : undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      collapse();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      collapse(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [collapse, expanded, expansionMode]);

  return (
    <div
      className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+0.25rem)] left-1/2 z-70 flex -translate-x-1/2 justify-center md:hidden"
      data-mobile-primary-navigation=""
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open primary navigation"
        aria-expanded={expanded}
        aria-controls="mobile-primary-navigation-toolbar"
        className={cn(
          "group pointer-events-auto flex h-11 w-16 cursor-pointer appearance-none items-start justify-center border-0 bg-transparent pt-2 outline-none transition-[opacity,transform] duration-100 ease-out motion-reduce:transition-none",
          expanded ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100",
        )}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
          event.preventDefault();
          setExpansionMode("engaged");
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          setExpansionMode("engaged");
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          setExpansionMode((mode) => (mode === "closed" ? "hover" : mode));
        }}
        tabIndex={expanded ? -1 : 0}
      >
        <span
          aria-hidden="true"
          className="h-5 w-14 rounded-full border border-border/55 bg-background/35 shadow-sm/5 backdrop-blur-xl backdrop-saturate-150 transition-[background-color,box-shadow] duration-150 ease-out group-hover:bg-background/95 group-focus-visible:bg-background/95 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 dark:bg-background/30 dark:group-hover:bg-background/95 motion-reduce:transition-none"
        />
      </button>

      <nav
        ref={toolbarRef}
        id="mobile-primary-navigation-toolbar"
        aria-label="Primary navigation"
        aria-hidden={!expanded}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse" || expansionMode !== "hover") return;
          collapse();
        }}
        className={cn(
          "pointer-events-auto absolute top-0 left-1/2 flex h-14 w-max max-w-[calc(100vw-1rem)] origin-top -translate-x-1/2 items-center rounded-[1.75rem] border border-border/70 bg-background/48 p-1.5 shadow-lg/8 backdrop-blur-2xl backdrop-saturate-150",
          "transition-[visibility,opacity,transform,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-background/95 pointer-coarse:bg-background/88 dark:bg-background/42 dark:hover:bg-background/95 dark:pointer-coarse:bg-background/88 motion-reduce:delay-0 motion-reduce:transition-none",
          expanded
            ? "visible translate-y-0 scale-x-100 scale-y-100 opacity-100 delay-0"
            : "invisible pointer-events-none translate-y-2 scale-x-[0.14] scale-y-[0.36] opacity-0 delay-150",
        )}
      >
        <div className="flex min-w-0 max-w-full items-center justify-[safe_center] gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map(
            ({ destination, icon: Icon, avatar, label, badgeCount = 0, onNavigate }, index) => (
              <div key={destination} className="contents">
                {items.length > PRIMARY_NAVIGATION_FIXED_BOTTOM_ITEM_COUNT &&
                index === items.length - PRIMARY_NAVIGATION_FIXED_BOTTOM_ITEM_COUNT ? (
                  <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-border/80" />
                ) : null}
                <Button
                  type="button"
                  aria-current={activeDestination === destination ? "page" : undefined}
                  aria-label={badgeCount > 0 ? `${label}, ${badgeCount} unread` : label}
                  title={label}
                  data-mobile-navigation-item=""
                  className={cn(
                    "relative size-11! shrink-0 rounded-full [-webkit-app-region:no-drag] [--control-icon-color:var(--muted-foreground)] hover:[--control-icon-color:var(--foreground)]",
                    activeDestination === destination &&
                      "bg-accent text-accent-foreground [--control-icon-color:var(--accent-foreground)]",
                  )}
                  onClick={() => {
                    collapse();
                    onNavigate();
                  }}
                  size="icon-lg"
                  tabIndex={expanded ? 0 : -1}
                  variant="ghost"
                >
                  {avatar ?? <Icon className="size-5" />}
                  {badgeCount > 0 ? (
                    <span className="absolute top-1.5 right-1.5 min-w-3.5 rounded-full bg-primary px-1 text-[9px] leading-[0.875rem] font-semibold text-primary-foreground tabular-nums">
                      {formatNavigationBadgeCount(badgeCount)}
                    </span>
                  ) : null}
                </Button>
              </div>
            ),
          )}
        </div>
      </nav>
    </div>
  );
}

export const PrimaryNavigationRail = memo(function PrimaryNavigationRail({
  expanded,
  onExpandedChange,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeDestination = resolvePrimaryNavigationDestination(pathname);
  const orchestrators = useOrchestrators();
  // Captured mail is the one destination that accumulates unread work while you are elsewhere.
  const emailUnreadCount = useEmailUnreadTotal();
  const preferredViewOrder = useClientSettings((settings) => settings.primaryNavigationViewOrder);
  const updateClientSettings = useUpdateClientSettings();
  const viewOrder = useMemo(
    () => resolvePrimaryNavigationViewOrder(preferredViewOrder),
    [preferredViewOrder],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const draggedDestinationRef = useRef<PaneDestination | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const dragGeometryRef = useRef<RailDragGeometry | null>(null);
  const pageWindows = usePageWindows();
  const openPlacements = useOpenPlacements(pageWindows);
  const splitDragDestination = useRailDragStore((state) =>
    state.phase === "rail" ? null : state.destination,
  );
  // Only a desktop build draws the chip outside the window, so only there does it hide.
  const splitDragOutside = useRailDragStore(
    (state) => canTearOutByDrag && state.phase === "outside",
  );
  const dragChipRef = useRef<HTMLDivElement>(null);
  const rememberedThreadRouteRef = useRef<RememberedThreadRoute | null>(
    resolveRememberedThreadRoute(pathname, null),
  );

  useEffect(() => {
    rememberedThreadRouteRef.current = resolveRememberedThreadRoute(
      pathname,
      rememberedThreadRouteRef.current,
    );
  }, [pathname]);

  const navigateToDashboard = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);
  const navigateToThreads = useCallback(() => {
    const rememberedRoute = rememberedThreadRouteRef.current;
    if (rememberedRoute?.kind === "thread") {
      void navigate({
        to: "/threads/$environmentId/$threadId",
        params: {
          environmentId: rememberedRoute.environmentId,
          threadId: rememberedRoute.threadId,
        },
      });
      return;
    }
    if (rememberedRoute?.kind === "draft") {
      void navigate({
        to: "/threads/draft/$draftId",
        params: { draftId: rememberedRoute.draftId },
      });
      return;
    }
    void navigate({ to: "/threads" });
  }, [navigate]);
  const navigateToIssues = useCallback(() => {
    void navigate({ to: "/issues" });
  }, [navigate]);
  const navigateToProjects = useCallback(() => {
    void navigate({ to: "/projects" });
  }, [navigate]);
  const navigateToPullRequests = useCallback(() => {
    void navigate({
      to: "/pull-requests",
      search: { involvement: "all", state: "open" },
    });
  }, [navigate]);
  const navigateToCalendar = useCallback(() => {
    void navigate({ to: "/calendar" });
  }, [navigate]);
  const navigateToEmail = useCallback(() => {
    void navigate({
      to: "/email",
      search: {
        inbox: undefined,
        message: undefined,
        environment: undefined,
        tag: undefined,
        tab: undefined,
        analytics: undefined,
      },
    });
  }, [navigate]);
  const navigateToContacts = useCallback(() => {
    void navigate({ to: "/contacts" });
  }, [navigate]);
  const navigateToTimeTracker = useCallback(() => {
    void navigate({ to: "/time-tracker" });
  }, [navigate]);
  const navigateToOrchestrator = useCallback(() => {
    orchestrators.setFloating((value) => !value);
  }, [orchestrators.setFloating]);
  const navigateToSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);
  const navigationItemsByDestination = useMemo(
    () => ({
      dashboard: {
        destination: "dashboard",
        icon: LayoutDashboardIcon,
        label: "Dashboard",
        onNavigate: navigateToDashboard,
      },
      threads: {
        destination: "threads",
        icon: MessagesSquareIcon,
        label: "Threads",
        onNavigate: navigateToThreads,
      },
      projects: {
        destination: "projects",
        icon: FolderKanbanIcon,
        label: "Projects",
        onNavigate: navigateToProjects,
      },
      issues: {
        destination: "issues",
        icon: ListTodoIcon,
        label: "Tasks",
        onNavigate: navigateToIssues,
      },
      "pull-requests": {
        destination: "pull-requests",
        icon: GitPullRequestIcon,
        label: "Source Control",
        onNavigate: navigateToPullRequests,
      },
      calendar: {
        destination: "calendar",
        icon: CalendarDaysIcon,
        label: "Calendar",
        onNavigate: navigateToCalendar,
      },
      email: {
        destination: "email",
        icon: MailIcon,
        label: "Email",
        badgeCount: emailUnreadCount,
        onNavigate: navigateToEmail,
      },
      contacts: {
        destination: "contacts",
        icon: ContactRoundIcon,
        label: "Contacts",
        onNavigate: navigateToContacts,
      },
      "time-tracker": {
        destination: "time-tracker",
        icon: Clock3Icon,
        label: "Time Tracker",
        onNavigate: navigateToTimeTracker,
      },
      orchestrator: {
        destination: "orchestrator",
        icon: BotIcon,
        avatar: (
          <OrchestratorAvatar
            contact={orchestrators.personalAvatar}
            className="size-7"
            idle="frequent"
          />
        ),
        label: "Orchestrator AI",
        badgeCount: orchestrators.unreadCount,
        onNavigate: navigateToOrchestrator,
      },
      settings: {
        destination: "settings",
        icon: SettingsIcon,
        label: "Settings",
        onNavigate: navigateToSettings,
      },
    }),
    [
      emailUnreadCount,
      orchestrators.unreadCount,
      orchestrators.personalAvatar,
      navigateToCalendar,
      navigateToContacts,
      navigateToDashboard,
      navigateToEmail,
      navigateToIssues,
      navigateToOrchestrator,
      navigateToPullRequests,
      navigateToProjects,
      navigateToSettings,
      navigateToThreads,
      navigateToTimeTracker,
    ],
  ) satisfies Record<PrimaryNavigationDestination, MobileNavigationItem>;

  // Permission-gated destinations drop out of the rail entirely rather than greying out: a row you
  // can press but cannot use is worse than one that is not there. `null` — the replica has not said
  // yet — keeps the row, so a reconnect does not flicker it away and back.
  const calendarAccess = useCalendarViewer().canRead;
  const visibleViewOrder = viewOrder.filter(
    (destination) => destination !== "calendar" || calendarAccess !== false,
  );
  const movableNavigationItems = visibleViewOrder.map(
    (destination) => navigationItemsByDestination[destination],
  );
  const fixedBottomNavigationItems = [
    navigationItemsByDestination.orchestrator,
    navigationItemsByDestination.settings,
  ];
  const navigationItems = [
    navigationItemsByDestination.dashboard,
    ...movableNavigationItems,
    ...fixedBottomNavigationItems,
  ];

  const persistViewOrder = useCallback(
    (nextOrder: readonly MovablePrimaryNavigationDestination[]) => {
      updateClientSettings({ primaryNavigationViewOrder: [...nextOrder] });
    },
    [updateClientSettings],
  );

  const clearDraggedDestinationAfterClick = useCallback(() => {
    window.setTimeout(() => {
      draggedDestinationRef.current = null;
    }, 0);
  }, []);

  // Over the rail a drag reorders it, so it stays on the vertical axis and collides
  // with its neighbours. Past the rail's edge it opens the page beside the others,
  // so it follows the pointer freely and nothing in the rail makes room for it.
  const dragModifiers = useMemo<Modifier[]>(
    () => [
      ({ activatorEvent, transform }) =>
        resolveDragTarget(dragGeometryRef.current, activatorEvent, transform).kind === "rail"
          ? { ...transform, x: 0 }
          : transform,
    ],
    [],
  );
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (!isMovableDestination(args.active.id as PaneDestination)) return [];
    const geometry = dragGeometryRef.current;
    const pointer = args.pointerCoordinates;
    if (geometry && pointer && resolveRailDragTarget(pointer, geometry).kind !== "rail") return [];
    return closestCenter(args);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const destination = event.active.id as PaneDestination;
    draggedDestinationRef.current = destination;
    dragGeometryRef.current = measureRailDragGeometry(railRef.current);
    beginRailDrag(destination, dragGeometryRef.current?.row ?? null);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const target = resolveDragTarget(dragGeometryRef.current, event.activatorEvent, event.delta);
    updateRailDragTarget(target);
    const chip = dragChipRef.current;
    const origin = event.activatorEvent ? getEventCoordinates(event.activatorEvent) : null;
    if (!canTearOutByDrag || target.kind === "rail" || !chip || !origin) return;
    const pointer = { x: origin.x + event.delta.x, y: origin.y + event.delta.y };
    prepareDragGhost(() => describeDragGhost(chip, pointer));
    setDragGhostOutside(target.kind === "outside");
  }, []);

  const handleDragCancel = useCallback(() => {
    endDragGhost();
    dragGeometryRef.current = null;
    endRailDrag();
    clearDraggedDestinationAfterClick();
  }, [clearDraggedDestinationAfterClick]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const destination = event.active.id as PaneDestination;
      const target = resolveDragTarget(dragGeometryRef.current, event.activatorEvent, event.delta);
      endDragGhost();
      dragGeometryRef.current = null;
      endRailDrag();
      clearDraggedDestinationAfterClick();

      if (target.kind === "outside") {
        const screenPoint = readDragScreenPoint(event, event.delta);
        if (screenPoint) handleRailDragEndedOutsideWindow(destination, screenPoint);
        return;
      }
      if (target.kind === "pane") {
        if (target.zone === "center") navigationItemsByDestination[destination].onNavigate();
        else openDestinationInPane(destination, target.zone);
        return;
      }
      if (!isMovableDestination(destination)) return;
      const overDestination = event.over?.id as MovablePrimaryNavigationDestination | undefined;
      if (overDestination && destination !== overDestination) {
        const fromIndex = viewOrder.indexOf(destination);
        const toIndex = viewOrder.indexOf(overDestination);
        if (fromIndex >= 0 && toIndex >= 0) {
          persistViewOrder(arrayMove([...viewOrder], fromIndex, toIndex));
        }
      }
    },
    [clearDraggedDestinationAfterClick, navigationItemsByDestination, persistViewOrder, viewOrder],
  );

  const handlePageContextMenu = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, destination: PaneDestination) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;

      const { layout } = usePaneStore.getState();
      const index = isMovableDestination(destination) ? viewOrder.indexOf(destination) : -1;
      const items = buildRailPageMenu({
        canOpenWindows: canOpenPageWindows,
        split: isSplit(layout),
        panes: findPanesShowing(
          destination,
          layout.panes.map((entry) => ({ id: entry.id, href: readPaneHref(entry.id) })),
        ),
        windows: findWindowsShowing(destination, pageWindows),
        anyWindows: pageWindows.length > 0,
        move:
          index < 0 ? null : { canMoveUp: index > 0, canMoveDown: index < viewOrder.length - 1 },
      });
      const action = await api.contextMenu.show<RailPageMenuAction>(items, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!action) return;
      if (action === "open-left" || action === "open-right") {
        openDestinationInPane(destination, action === "open-left" ? "left" : "right");
      } else if (action === "open-window") {
        void openDestinationInWindow(destination);
      } else if (action === "close-all-panes") {
        closeAllSidePanes();
      } else if (action === "close-all-windows") {
        closeAllPageWindows();
      } else if (action.startsWith("close-pane:")) {
        closePaneById(action.slice("close-pane:".length));
      } else if (action.startsWith("close-window:")) {
        closePageWindow(action.slice("close-window:".length));
      } else if (
        (action === "move-up" || action === "move-down") &&
        isMovableDestination(destination)
      ) {
        persistViewOrder(
          movePrimaryNavigationDestination(
            viewOrder,
            destination,
            action === "move-up" ? "up" : "down",
          ),
        );
      }
    },
    [pageWindows, persistViewOrder, viewOrder],
  );

  const splitDragItem =
    splitDragDestination === null ? null : navigationItemsByDestination[splitDragDestination];

  return (
    <>
      <aside
        ref={railRef}
        aria-label="Primary navigation"
        className="relative z-20 hidden h-dvh w-(--primary-navigation-rail-width) shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear motion-reduce:transition-none md:flex"
        data-expanded={expanded}
        data-primary-navigation-rail=""
      >
        <div className="h-11 shrink-0" aria-hidden="true" />
        <nav
          aria-label="Workspace"
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2",
            expanded ? "items-stretch" : "items-center",
          )}
        >
          <DndContext
            collisionDetection={collisionDetection}
            modifiers={dragModifiers}
            sensors={sensors}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
            onDragMove={handleDragMove}
            onDragStart={handleDragStart}
          >
            <DraggableNavigationRailButton
              active={activeDestination === "dashboard"}
              expanded={expanded}
              item={navigationItemsByDestination.dashboard}
              openInPane={openPlacements.inPane.has("dashboard")}
              openInWindow={openPlacements.inWindow.has("dashboard")}
              onClick={(event) => {
                if (draggedDestinationRef.current === "dashboard") {
                  event.preventDefault();
                  return;
                }
                navigateToDashboard();
              }}
              onContextMenu={(event) => void handlePageContextMenu(event, "dashboard")}
            />
            <SortableContext items={[...visibleViewOrder]} strategy={verticalListSortingStrategy}>
              {movableNavigationItems.map((item) => (
                <SortableNavigationRailButton
                  key={item.destination}
                  active={activeDestination === item.destination}
                  expanded={expanded}
                  item={item}
                  openInPane={openPlacements.inPane.has(item.destination)}
                  openInWindow={openPlacements.inWindow.has(item.destination)}
                  onClick={(event) => {
                    if (draggedDestinationRef.current === item.destination) {
                      event.preventDefault();
                      return;
                    }
                    item.onNavigate();
                  }}
                  onContextMenu={(event) => void handlePageContextMenu(event, item.destination)}
                />
              ))}
            </SortableContext>
            {splitDragItem
              ? createPortal(
                  <DragOverlay dropAnimation={null}>
                    <RailDragChip
                      ref={dragChipRef}
                      icon={splitDragItem.icon}
                      label={splitDragItem.label}
                      outside={splitDragOutside}
                    />
                  </DragOverlay>,
                  document.body,
                )
              : null}
          </DndContext>
        </nav>
        <nav
          aria-label="Account and application"
          className={cn(
            "mt-auto flex w-full flex-col gap-1 px-2 pb-3",
            expanded ? "items-stretch" : "items-center",
          )}
        >
          <SidebarProviderUpdatePill expanded={expanded} />
          <SidebarUpdatePill expanded={expanded} />
          {fixedBottomNavigationItems.map(
            ({ destination, icon, label, badgeCount, onNavigate }: MobileNavigationItem) => (
              <NavigationRailButton
                key={destination}
                active={activeDestination === destination}
                badgeCount={badgeCount ?? 0}
                expanded={expanded}
                icon={icon}
                avatar={
                  destination === "orchestrator" ? (
                    <OrchestratorAvatar
                      contact={orchestrators.personalAvatar}
                      className="size-7"
                      idle="frequent"
                    />
                  ) : undefined
                }
                label={label}
                onClick={onNavigate}
              />
            ),
          )}
          <div className="mt-1 flex w-full flex-col items-center border-t border-sidebar-border pt-2">
            <NavigationRailButton
              expanded={expanded}
              icon={expanded ? PanelLeftCloseIcon : PanelLeftIcon}
              label={expanded ? "Collapse navigation" : "Expand navigation"}
              onClick={() => onExpandedChange(!expanded)}
            />
          </div>
        </nav>
      </aside>
      <MobileNavigationToolbar activeDestination={activeDestination} items={navigationItems} />
    </>
  );
});
import { useOrchestrators } from "../orchestrator/OrchestratorContext";
