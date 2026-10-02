import type {
  ContextMenuItem,
  PreviewSessionSnapshot,
  PullRequestState,
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
  MessagesSquare,
  Monitor,
  Plus,
  TerminalSquare,
} from "lucide-react";
import {
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
import { isElectron } from "~/env";
import {
  isRemoteBrowserSurface,
  type RightPanelKind,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { useTheme } from "~/hooks/useTheme";
import { useIsSplitWindow } from "~/panes/usePaneFocus";
import { useWorkspaceTopBarPanelTabsHost } from "./navigation/WorkspaceTopBar";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { NewTabToolsProvider, type PanelSurfaceAction } from "./preview/newTabTools";
import { PreviewFavicon } from "./preview/PreviewFavicon";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
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
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddDevice?: (() => void) | undefined;
  /** Opens a browser tab; without a placement it opens the thread's default browser. */
  onAddBrowser: (placement?: BrowserPlacement) => void;
  /** Tab labels saying where each browser runs. `local` is null when there is no ambiguity. */
  browserLabels?: { readonly remote: string; readonly local: string | null };
  /** Reopens a local tab's page in the thread environment's browser. */
  onOpenInRemoteBrowser?: (surface: RightPanelSurface) => void;
  onAddTerminal: () => void;
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
  browserLabels?: RightPanelTabsProps["browserLabels"],
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
      if (isRemoteBrowserSurface(surface)) return browserLabels?.remote ?? "Remote browser";
      if (surface.resourceId === null) return "New tab";
      const title = localBrowserTitle(surface.resourceId ? sessions[surface.resourceId] : null);
      return browserLabels?.local ? `${browserLabels.local} · ${title}` : title;
    }
  }
}

function localBrowserTitle(snapshot: PreviewSessionSnapshot | null | undefined): string {
  if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
  if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
  try {
    return new URL(snapshot.navStatus.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function SurfaceIcon({
  surface,
  sessions,
  theme,
  pullRequestStatuses,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  theme: "light" | "dark";
  pullRequestStatuses: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  switch (surface.kind) {
    case "preview": {
      if (isRemoteBrowserSurface(surface)) return <Globe2 className="size-3 shrink-0" />;
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
  const activeSurface = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  // A blank browser tab offers the other surfaces; picking one takes the tab's place.
  const newTabTools = surfaceActions
    .filter((action) => action.kind !== "preview" && action.available)
    .map((action) => ({
      ...action,
      onClick: () => {
        action.onClick();
        if (activeSurface?.kind === "preview") props.onCloseSurface(activeSurface);
      },
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

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

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
      {inTopBar ? <div aria-hidden className="mr-1 h-5 w-px shrink-0 bg-sidebar-border" /> : null}
      <ScrollArea
        ref={tabListRef}
        scrollFade
        className="min-w-0 flex-1 rounded-none [-webkit-app-region:no-drag]"
        data-right-panel-tab-list
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {props.surfaces.map((surface) => {
            const active = surface.id === props.activeSurfaceId;
            const pending = props.pendingSurfaceIds.has(surface.id);
            const title = resolveRightPanelSurfaceTitle(
              surface,
              props.previewSessions,
              props.terminalLabelsById,
              props.threadTitlesById,
              props.browserLabels,
            );
            return (
              <div
                key={surface.id}
                data-active-tab={active}
                onMouseDown={handleTabMouseDown}
                onAuxClick={(event) => handleTabAuxClick(event, surface)}
                onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                className={cn(
                  "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                  // The accent fill vanishes on the top bar's gray, so it uses the rail's.
                  active
                    ? inTopBar
                      ? "bg-sidebar-foreground/10 text-foreground"
                      : "bg-accent text-foreground"
                    : cn(
                        "text-muted-foreground hover:text-foreground",
                        inTopBar ? "hover:bg-sidebar-foreground/6" : "hover:bg-accent/60",
                      ),
                )}
              >
                <PanelTabCloseButton
                  label={`Close ${title}`}
                  onClick={() => props.onCloseSurface(surface)}
                >
                  <SurfaceIcon
                    surface={surface}
                    sessions={props.previewSessions}
                    theme={resolvedTheme}
                    pullRequestStatuses={props.pullRequestStatuses}
                  />
                  {pending ? (
                    <span
                      className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                      aria-hidden
                    />
                  ) : null}
                </PanelTabCloseButton>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        className="cursor-pointer flex min-w-0 items-center"
                        onClick={() => props.onActivate(surface)}
                      >
                        <span className="truncate">{title}</span>
                      </button>
                    }
                  />
                  <TooltipPopup>{title}</TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
          {props.surfaces.length > 0 && newTabAction ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "cursor-pointer relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
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
        {props.activeSurfaceId === null ? (
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
