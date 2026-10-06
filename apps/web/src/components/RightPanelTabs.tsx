import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  ContextMenuItem,
  PreviewSessionSnapshot,
  PullRequestState,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { getTerminalLabel } from "@spiritdevs/shared/terminalLabels";
import {
  Smartphone,
  Bot,
  CircleDot,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  Laptop,
  MessagesSquare,
  Monitor,
  Plus,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { BrowserPlacement } from "~/browser/browserPlacement";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { RemoteBrowserStream } from "~/browser/RemoteBrowserStream";
import type { RemoteBrowserPage } from "~/browser/remoteBrowserStore";
import { isElectron } from "~/env";
import {
  isRemoteBrowserSurface,
  type RightPanelKind,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import { useIsSplitWindow } from "~/panes/usePaneFocus";
import { useWorkspaceTopBarPanelTabsHost } from "./navigation/WorkspaceTopBar";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { NewTabToolsProvider, type PanelSurfaceAction } from "./preview/newTabTools";
import { PreviewFavicon } from "./preview/PreviewFavicon";
import { previewBridge } from "./preview/previewBridge";

/** A fixed first tab for the page a maximized panel covers. While active, no surface shows. */
export interface RightPanelLeadingTab {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly active: boolean;
  readonly onActivate: () => void;
}

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  leadingTab?: RightPanelLeadingTab | undefined;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  /** Live thread titles keyed by thread id; thread identities remain the only persisted data. */
  threadTitlesById?: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  /** Dragging tabs reorders them; without this they stay put. */
  onMoveSurface?: ((surface: RightPanelSurface, toIndex: number) => void) | undefined;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddDevice?: (() => void) | undefined;
  /** Opens a browser tab; without a placement it opens the thread's default browser. */
  onAddBrowser: (placement?: BrowserPlacement) => void;
  /** Where the thread's browser tabs run, for their icons and hover cards. */
  browser?: BrowserTabContext | undefined;
  /** Reopens a local tab's page in the thread environment's browser. */
  onOpenInRemoteBrowser?: (surface: RightPanelSurface) => void;
  onAddTerminal: () => void;
  /** Opens the terminal drawer below the chat instead of a panel tab. */
  onOpenBottomTerminal?: (() => void) | undefined;
  /** Shortcut labels for the tools whose shortcut opens that same tool. */
  toolShortcuts?: Partial<Record<"terminal-drawer" | RightPanelKind, string | null>> | undefined;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  /** Present where the environment's screen can be shown; absent hides the entry. */
  onAddComputer?: () => void;
  onAddSideChat: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  sideChatAvailable: boolean;
  /** Limits the surface picker for view-specific panels such as Issues. */
  allowedSurfaceKinds?: ReadonlySet<RightPanelKind>;
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>>;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

export interface BrowserTabContext {
  readonly threadRef: ScopedThreadRef;
  /** Part of a local tab's desktop runtime id. */
  readonly serverEpoch: string | null;
  readonly environmentLabel: string;
  /** What to call the machine local tabs browse from, such as "This Mac". */
  readonly localLabel: string;
  /** The page the remote browser last showed. */
  readonly remotePage: RemoteBrowserPage | null;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

const RightPanelTabBarActionsContext = createContext<HTMLElement | null>(null);

/** Mounts controls owned by the active surface into the right-panel tab bar. */
export function RightPanelTabBarActions({ children }: { children: ReactNode }) {
  const host = useContext(RightPanelTabBarActionsContext);
  return host ? createPortal(children, host) : null;
}

/**
 * How far into the top bar's tab host the panel's left edge sits, so the lifted tab
 * strip starts right above the panel.
 */
function useTopBarTabStripOffset(
  host: HTMLElement | null,
  anchorRef: { current: HTMLElement | null },
): number {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!host || !anchor) return;
    const panel = anchor.closest<HTMLElement>("[data-preview-panel-mode]") ?? anchor;
    // While the panel opens its contents keep their full width, so this is where it settles.
    const measure = () =>
      setOffset(
        Math.max(0, panel.getBoundingClientRect().left - host.getBoundingClientRect().left),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef, host]);

  return offset;
}

const SURFACE_DISABLED_REASONS = {
  browser: "The browser is only available in the Pathway desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  agents: "Agents are only available from a thread.",
  sideChat: "Side chats need a connected thread with at least one completed response.",
} as const;

type TabContextMenuAction =
  | "copy-path"
  | "open-remote"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/** Every surface the panel can open, filtered to the ones this view allows. */
function buildSurfaceActions(props: RightPanelTabsProps): PanelSurfaceAction[] {
  const actions: PanelSurfaceAction[] = [
    ...(props.onAddDevice
      ? [
          {
            kind: "device",
            label: "Device",
            description: "Open a simulator or emulator.",
            icon: Smartphone,
            available: true,
            disabledReason: "",
            onClick: props.onAddDevice,
            badgeCount: 0,
          },
        ]
      : []),
    {
      kind: "preview",
      label: "Browser",
      description: "Open a local app or URL.",
      icon: Globe2,
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: () => props.onAddBrowser(),
      badgeCount: 0,
    },
    {
      kind: "terminal",
      label: "Terminal",
      description: "Start a shell in this workspace.",
      icon: TerminalSquare,
      available: props.terminalAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.terminal,
      onClick: props.onAddTerminal,
      badgeCount: 0,
      ...(props.onOpenBottomTerminal
        ? {
            alternatives: [
              { label: "Open in panel", shortcut: null, onClick: props.onAddTerminal },
              {
                label: "Open at bottom",
                shortcut: props.toolShortcuts?.["terminal-drawer"] ?? null,
                onClick: props.onOpenBottomTerminal,
              },
            ],
          }
        : {}),
    },
    {
      kind: "files",
      label: "Files",
      description: "Browse and read workspace files.",
      icon: Files,
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      kind: "diff",
      label: "Diff",
      description: "Review changes in this thread.",
      icon: FileDiff,
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      kind: "pull-request",
      label: "Pull request",
      description: "Open the pull request for this thread's branch.",
      icon: GitPullRequest,
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
      badgeCount: 0,
    },
    {
      kind: "agents",
      label: "Agents",
      description: "Watch subagents and workflows run.",
      icon: Bot,
      available: props.agentsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.agents,
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
    ...(props.onAddComputer
      ? [
          {
            kind: "computer",
            label: "Computer",
            description: "Watch the environment's screen and take control.",
            icon: Monitor,
            available: true,
            disabledReason: "",
            onClick: props.onAddComputer,
            badgeCount: 0,
          },
        ]
      : []),
    {
      kind: "thread",
      label: "Side chat",
      description: "Ask with this conversation's context.",
      icon: MessagesSquare,
      available: props.sideChatAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.sideChat,
      onClick: props.onAddSideChat,
      badgeCount: 0,
    },
  ];
  return actions.filter(
    (action) => props.allowedSurfaceKinds?.has(action.kind as RightPanelKind) ?? true,
  );
}

function RightPanelEmptyState(props: { actions: ReadonlyArray<PanelSurfaceAction> }) {
  const { actions } = props;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-foreground">Open a surface</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            const content = (
              <>
                <span className="relative mb-3 inline-flex">
                  <Icon className="size-5" />
                  {action.badgeCount > 0 ? (
                    <span
                      aria-hidden
                      className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
                    >
                      {action.badgeCount}
                    </span>
                  ) : null}
                </span>
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
              </>
            );
            if (action.available) {
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onClick}
                  className="cursor-pointer flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left transition hover:border-border hover:bg-accent/60 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  {content}
                </button>
              );
            }
            const disabledCard = (
              <button
                type="button"
                className="flex min-h-28 w-full cursor-not-allowed flex-col items-start rounded-lg border border-border/80 bg-card p-4 text-left opacity-40 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5"
                aria-disabled="true"
              >
                {content}
              </button>
            );
            return (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={disabledCard}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function resolveRightPanelSurfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
  threadTitlesById?: ReadonlyMap<string, string>,
  remotePage?: RemoteBrowserPage | null,
): string {
  switch (surface.kind) {
    case "device":
      return surface.target?.name ?? "Devices";
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "agents":
      return "Agents";
    case "computer":
      return "Computer";
    case "issue":
      return `${surface.issueKey} ${surface.title}`.trim();
    case "thread":
      return threadTitlesById?.get(surface.resourceId)?.trim() || "Side chat";
    case "preview": {
      if (isRemoteBrowserSurface(surface)) {
        return remotePage ? pageTitle(remotePage, "Remote browser") : "Remote browser";
      }
      if (surface.resourceId === null) return "New tab";
      const snapshot = sessions[surface.resourceId];
      return !snapshot || snapshot.navStatus._tag === "Idle"
        ? "Browser"
        : pageTitle(snapshot.navStatus, "Browser");
    }
  }
}

function pageTitle(page: { readonly url: string; readonly title: string }, fallback: string) {
  if (page.title.trim().length > 0) return page.title;
  try {
    return new URL(page.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** A blue globe marks the remote browser; the page's favicon sits on its corner. */
function RemoteBrowserIcon({ url }: { url: string | null }) {
  return (
    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
      <Globe2 className="size-3.5 text-blue-500 dark:text-blue-400" />
      <PreviewFavicon
        url={url}
        fallback={null}
        className="absolute -right-1 -bottom-1 size-2.5 rounded-[3px] bg-background ring-1 ring-background"
      />
    </span>
  );
}

/**
 * Hover card for a browser tab: the page's title and host, where it runs, and a
 * glimpse of the page. Remote tabs stream watch-only; local tabs show a still.
 */
function BrowserTabPreview({
  surface,
  context,
  sessions,
  title,
}: {
  surface: RightPanelSurface & { kind: "preview" };
  context: BrowserTabContext;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  title: string;
}) {
  const remote = isRemoteBrowserSurface(surface);
  const navStatus = surface.resourceId ? sessions[surface.resourceId]?.navStatus : undefined;
  const url = remote
    ? (context.remotePage?.url ?? null)
    : navStatus && navStatus._tag !== "Idle"
      ? navStatus.url
      : null;
  return (
    <div className="flex w-80 flex-col gap-2 py-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{url ? displayHost(url) : null}</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px]">
            {remote ? (
              <Globe2 className="size-3 text-blue-500 dark:text-blue-400" />
            ) : (
              <Laptop className="size-3" />
            )}
            {remote ? `Remote · ${context.environmentLabel}` : `Local · ${context.localLabel}`}
          </span>
        </div>
      </div>
      {remote ? (
        context.remotePage ? (
          <PreviewFrame>
            <div className="absolute inset-0 flex items-center justify-center">
              <RemoteBrowserStream
                threadRef={context.threadRef}
                tabId={context.remotePage.tabId}
                compact
              />
            </div>
          </PreviewFrame>
        ) : null
      ) : surface.resourceId ? (
        <LocalTabThumbnail
          runtimeTabId={previewRuntimeTabId(
            context.threadRef,
            context.serverEpoch,
            surface.resourceId,
          )}
        />
      ) : null}
    </div>
  );
}

// Last good still per local tab, so a repeat hover paints at once while a fresh one loads.
const localTabThumbnails = new Map<string, string>();
const LOCAL_TAB_THUMBNAIL_LIMIT = 12;

function PreviewFrame({ children }: { children?: ReactNode }) {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-md bg-muted">
      {children}
    </div>
  );
}

/**
 * A still of a local tab, captured when its hover card opens. The frame only
 * shows while a still exists or is on its way; a failed capture leaves no box.
 */
function LocalTabThumbnail({ runtimeTabId }: { runtimeTabId: string }) {
  const capture = previewBridge?.captureThumbnail;
  const [src, setSrc] = useState(() => localTabThumbnails.get(runtimeTabId) ?? null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!capture) return;
    let cancelled = false;
    capture(runtimeTabId)
      .then(
        (next) => {
          if (next === null) return;
          localTabThumbnails.delete(runtimeTabId);
          localTabThumbnails.set(runtimeTabId, next);
          // Oldest first: keep only the most recently hovered tabs.
          for (const key of localTabThumbnails.keys()) {
            if (localTabThumbnails.size <= LOCAL_TAB_THUMBNAIL_LIMIT) break;
            localTabThumbnails.delete(key);
          }
          if (!cancelled) setSrc(next);
        },
        () => undefined,
      )
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [capture, runtimeTabId]);
  if (!src && (!capture || settled)) return null;
  return (
    <PreviewFrame>
      {src ? (
        <img src={src} alt="" className="absolute inset-0 size-full object-cover object-top" />
      ) : null}
    </PreviewFrame>
  );
}

function displayHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  remotePage,
  theme,
  pullRequestStatuses,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  remotePage: RemoteBrowserPage | null;
  theme: "light" | "dark";
  pullRequestStatuses: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  switch (surface.kind) {
    case "preview": {
      if (isRemoteBrowserSurface(surface))
        return <RemoteBrowserIcon url={remotePage?.url ?? null} />;
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      return <PreviewFavicon url={url} />;
    }
    case "device":
      return <Smartphone className="size-3 shrink-0" />;
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request": {
      const status = pullRequestStatuses?.[surface.id] ?? null;
      const toneClassName =
        status?.state === "merged"
          ? "text-violet-600 dark:text-violet-300/90"
          : status?.state === "closed"
            ? "text-red-600 dark:text-red-300/90"
            : status?.isDraft
              ? "text-zinc-500 dark:text-zinc-400/80"
              : status?.state === "open"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-muted-foreground";
      return <GitPullRequest className={cn("size-3 shrink-0", toneClassName)} />;
    }
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "computer":
      return <Monitor className="size-3 shrink-0" />;
    case "issue":
      return <CircleDot className="size-3 shrink-0" />;
    case "thread":
      return <MessagesSquare className="size-3 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const [tabBarActionsHost, setTabBarActionsHost] = useState<HTMLDivElement | null>(null);
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const surfaceContentRef = useRef<HTMLDivElement>(null);
  const splitWindow = useIsSplitWindow();
  // Inline beside a single pane, the tabs sit in the top bar's empty stretch above the panel.
  const topBarTabsHost = useWorkspaceTopBarPanelTabsHost(props.mode === "inline" && !splitWindow);
  const topBarTabStripOffset = useTopBarTabStripOffset(topBarTabsHost, surfaceContentRef);
  const inTopBar = topBarTabsHost !== null;
  const surfaceActions = buildSurfaceActions(props);
  const newTabAction = surfaceActions.find((action) => action.kind === "preview");
  // A blank browser tab offers the other surfaces; the store puts the one picked in its place.
  const newTabTools = surfaceActions
    .filter((action) => action.kind !== "preview" && action.available)
    .map((action) => ({
      ...action,
      shortcut: props.toolShortcuts?.[action.kind as RightPanelKind] ?? null,
    }));

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      if (
        props.onOpenInRemoteBrowser &&
        surface.kind === "preview" &&
        surface.resourceId !== null
      ) {
        items.push({ id: "open-remote", label: "Open in remote browser" });
      }
      items.push(
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "open-remote":
          props.onOpenInRemoteBrowser?.(surface);
          break;
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  const tabDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const handleTabDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const surface = props.surfaces.find((entry) => entry.id === active.id);
      const toIndex = props.surfaces.findIndex((entry) => entry.id === over?.id);
      if (surface && toIndex >= 0) props.onMoveSurface?.(surface, toIndex);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, props.leadingTab?.active]);

  const tabBar = (
    <div
      className={cn(
        inTopBar
          ? "flex h-full min-w-0 flex-1 items-center gap-1 pr-2"
          : cn(
              "workspace-topbar min-w-0 gap-1 pl-2",
              props.mode !== "inline" &&
                props.mode !== "sheet" &&
                "[--workspace-topbar-height:--spacing(11)]",
              props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
              ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
            ),
      )}
      style={inTopBar ? { marginLeft: topBarTabStripOffset } : undefined}
      data-right-panel-tabbar
    >
      {inTopBar && props.leadingTab && !props.leadingTab.active ? <CoveredSidebarToggle /> : null}
      {inTopBar ? <div aria-hidden className="mr-1 h-5 w-px shrink-0 bg-sidebar-border" /> : null}
      <ScrollArea
        ref={tabListRef}
        scrollFade
        hideScrollbars
        className="min-w-0 flex-1 rounded-none [-webkit-app-region:no-drag]"
        data-right-panel-tab-list
      >
        <div
          className="flex h-full w-full items-center gap-1"
          // Without a scrollbar, a mouse wheel scrolls the strip sideways.
          onWheel={(event) => {
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            event.currentTarget.parentElement?.scrollBy({ left: event.deltaY });
          }}
        >
          {props.leadingTab ? <LeadingTab tab={props.leadingTab} inTopBar={inTopBar} /> : null}
          <DndContext
            sensors={tabDragSensors}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={handleTabDragEnd}
          >
            <SortableContext
              items={props.surfaces.map((surface) => surface.id)}
              strategy={horizontalListSortingStrategy}
              disabled={!props.onMoveSurface}
            >
              {props.surfaces.map((surface) => {
                const active = surface.id === props.activeSurfaceId && !props.leadingTab?.active;
                const pending = props.pendingSurfaceIds.has(surface.id);
                const remotePage = props.browser?.remotePage ?? null;
                const title = resolveRightPanelSurfaceTitle(
                  surface,
                  props.previewSessions,
                  props.terminalLabelsById,
                  props.threadTitlesById,
                  remotePage,
                );
                return (
                  <SortableTab
                    key={surface.id}
                    id={surface.id}
                    data-active-tab={active}
                    onMouseDown={handleTabMouseDown}
                    onAuxClick={(event) => handleTabAuxClick(event, surface)}
                    onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                    // Tabs share the strip down to a minimum, then the strip scrolls.
                    className={cn(
                      "group/tab flex h-7 w-56 min-w-24 shrink items-center rounded-lg text-xs",
                      active
                        ? "bg-background text-foreground shadow-xs ring-1 ring-border/70 dark:ring-white/8"
                        : cn(
                            "text-muted-foreground hover:text-foreground",
                            inTopBar ? "hover:bg-sidebar-foreground/6" : "hover:bg-accent/60",
                          ),
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className="cursor-pointer flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-2.5"
                            onClick={() => props.onActivate(surface)}
                          >
                            <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                              <SurfaceIcon
                                surface={surface}
                                sessions={props.previewSessions}
                                remotePage={remotePage}
                                theme={resolvedTheme}
                                pullRequestStatuses={props.pullRequestStatuses}
                              />
                              {pending ? (
                                <span
                                  className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                                  aria-hidden
                                />
                              ) : null}
                            </span>
                            <span className="truncate">{title}</span>
                          </button>
                        }
                      />
                      {props.browser &&
                      surface.kind === "preview" &&
                      (surface.resourceId !== null || isRemoteBrowserSurface(surface)) ? (
                        <TooltipPopup className="rounded-xl" side="bottom" align="start">
                          <BrowserTabPreview
                            surface={surface}
                            context={props.browser}
                            sessions={props.previewSessions}
                            title={title}
                          />
                        </TooltipPopup>
                      ) : (
                        <TooltipPopup>{title}</TooltipPopup>
                      )}
                    </Tooltip>
                    <button
                      type="button"
                      aria-label={`Close ${title}`}
                      onClick={() => props.onCloseSurface(surface)}
                      className={cn(
                        "cursor-pointer mr-1.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                        !active &&
                          "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  </SortableTab>
                );
              })}
            </SortableContext>
          </DndContext>
          {props.surfaces.length > 0 && newTabAction ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "cursor-pointer relative inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                      inTopBar ? "hover:bg-sidebar-foreground/6" : "hover:bg-accent",
                    )}
                    aria-label="New tab"
                    disabled={!newTabAction.available}
                    onClick={newTabAction.onClick}
                  />
                }
              >
                <Plus className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>
                {newTabAction.available ? "New tab" : newTabAction.disabledReason}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </ScrollArea>
      <div
        ref={setTabBarActionsHost}
        className="flex shrink-0 items-center [-webkit-app-region:no-drag]"
      />
      {props.layoutControls ? (
        <div className="flex h-full shrink-0 items-center">{props.layoutControls}</div>
      ) : null}
    </div>
  );

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
    >
      {topBarTabsHost ? createPortal(tabBar, topBarTabsHost) : tabBar}
      <div
        ref={surfaceContentRef}
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
      >
        {props.leadingTab?.active ? null : props.activeSurfaceId === null ? (
          <RightPanelEmptyState actions={surfaceActions} />
        ) : (
          <RightPanelTabBarActionsContext.Provider value={tabBarActionsHost}>
            <NewTabToolsProvider value={newTabTools}>{props.children}</NewTabToolsProvider>
          </RightPanelTabBarActionsContext.Provider>
        )}
      </div>
    </PreviewPanelShell>
  );
}

/**
 * A maximized panel covers the collapsed sidebar's own toggle, so the tab strip carries one
 * while the panel shows.
 */
function CoveredSidebarToggle() {
  const { state } = useSidebar();
  if (state !== "collapsed") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className="mr-1 shrink-0 rounded-lg text-muted-foreground hover:bg-sidebar-foreground/6 hover:text-foreground"
            aria-label="Toggle main sidebar"
          />
        }
      />
      <TooltipPopup side="bottom">Toggle main sidebar</TooltipPopup>
    </Tooltip>
  );
}

function LeadingTab({ tab, inTopBar }: { tab: RightPanelLeadingTab; inTopBar: boolean }) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      data-active-tab={tab.active}
      onClick={tab.onActivate}
      className={cn(
        "cursor-pointer flex h-7 w-56 min-w-24 shrink items-center gap-2 rounded-lg px-2.5 text-xs",
        tab.active
          ? "bg-background text-foreground shadow-xs ring-1 ring-border/70 dark:ring-white/8"
          : cn(
              "text-muted-foreground hover:text-foreground",
              inTopBar ? "hover:bg-sidebar-foreground/6" : "hover:bg-accent/60",
            ),
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{tab.title}</span>
    </button>
  );
}

function SortableTab({ id, className, style, ...props }: ComponentProps<"div"> & { id: string }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      {...props}
      {...listeners}
      className={cn(className, "touch-none", isDragging && "relative z-10")}
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
    />
  );
}
