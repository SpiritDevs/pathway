import { ProviderUpdateCheckCoordinator } from "./ProviderUpdateCheckCoordinator";
import { ThreadQueueRuntime } from "../cloud/threadQueue";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { RouterContextProvider, useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { useIsMobile } from "../hooks/useMediaQuery";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { whenIdle } from "../lib/whenIdle";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode } from "../hooks/useSettings";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { ContextualSidebarHeader } from "./sidebar/ContextualSidebarHeader";
import {
  PRIMARY_NAVIGATION_RAIL_WIDTH,
  PrimaryNavigationRail,
} from "./navigation/PrimaryNavigationRail";
import { WorkspaceTopBar } from "./navigation/WorkspaceTopBar";
import {
  resolveSecondarySidebarKind,
  shouldRenderSecondarySidebar as shouldRenderSecondarySidebarForViewport,
} from "./secondarySidebar";
import {
  resolveSidebarStageFocusRingOffsetClass,
  useSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import { PaneRow } from "../panes/PaneRow";
import { isPaneFocused, useFocusedPaneRouter, usePaneId } from "../panes/usePaneFocus";
import { isChildWindow } from "../panes/windowMode";
import {
  type CrampedSidebarState,
  resolveCrampedSidebarState,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The thread sidebar is the chat route's and stays in the entry chunk. Every
// other surface's sidebar, and the orchestrator overlay, load on demand and are
// warmed once the app is idle so a first visit does not flash an empty panel.
const secondarySidebarLoaders = {
  calendar: () => import("./calendar/CalendarSidebar"),
  email: () => import("./email/EmailSidebar"),
  issues: () => import("./issues/IssuesSidebar"),
  orchestrator: () => import("./orchestrator/OrchestratorSidebar"),
  orchestratorOverlay: () => import("./orchestrator/OrchestratorConversation"),
  projects: () => import("./projects/ProjectsSidebar"),
  settings: () => import("./settings/SettingsSidebarNav"),
  sourceControl: () => import("./sourceControl/SourceControlSidebar"),
};
const CalendarSidebar = lazy(() =>
  secondarySidebarLoaders.calendar().then((module) => ({ default: module.CalendarSidebar })),
);
const EmailSidebar = lazy(() =>
  secondarySidebarLoaders.email().then((module) => ({ default: module.EmailSidebar })),
);
const IssuesSidebar = lazy(() =>
  secondarySidebarLoaders.issues().then((module) => ({ default: module.IssuesSidebar })),
);
const OrchestratorSidebar = lazy(() =>
  secondarySidebarLoaders
    .orchestrator()
    .then((module) => ({ default: module.OrchestratorSidebar })),
);
const OrchestratorOverlay = lazy(() =>
  secondarySidebarLoaders
    .orchestratorOverlay()
    .then((module) => ({ default: module.OrchestratorOverlay })),
);
const ProjectsSidebar = lazy(() =>
  secondarySidebarLoaders.projects().then((module) => ({ default: module.ProjectsSidebar })),
);
const SettingsSidebarNav = lazy(() =>
  secondarySidebarLoaders.settings().then((module) => ({ default: module.SettingsSidebarNav })),
);
const SourceControlSidebar = lazy(() =>
  secondarySidebarLoaders
    .sourceControl()
    .then((module) => ({ default: module.SourceControlSidebar })),
);

function useWarmSecondarySidebars() {
  useEffect(
    () =>
      whenIdle(() => {
        for (const load of Object.values(secondarySidebarLoaders)) void load();
      }),
    [],
  );
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl({ useArtworkContrast }: { useArtworkContrast: boolean }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, hoverRevealed } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    useArtworkContrast && environmentIdentificationMode === "artwork",
  );
  const isSidebarArtworkVisible = isSidebarVisible || hoverRevealed;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  const paneId = usePaneId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPaneFocused(paneId)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, paneId, toggleSidebar]);

  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric. From md up it sits inside
    // its frame, whose border supplies that pixel.
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[calc(var(--workspace-controls-top)+2.75rem)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center md:absolute md:top-0 md:ml-0"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className={cn(
                "pointer-events-auto",
                !useArtworkContrast &&
                  "[&_svg]:stroke-black! [&_svg]:hover:stroke-black! dark:[&_svg]:stroke-white/90! dark:[&_svg]:hover:stroke-white!",
                isSidebarArtworkVisible &&
                  stageBackdropVariant &&
                  "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
                isSidebarArtworkVisible &&
                  stageBackdropVariant &&
                  resolveSidebarStageFocusRingOffsetClass(stageBackdropVariant),
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

/**
 * The app shell. The rail and top bar sit outside the panes and render inside
 * the focused pane's router context, so rail clicks and back and forward follow
 * whichever pane has focus. Each pane is a `WorkspaceFrame` with its own
 * sidebar. A torn-out window has no rail and no split.
 */
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const appRouter = useRouter();
  const focusedRouter = useFocusedPaneRouter(appRouter);
  const frame = <WorkspaceFrame>{children}</WorkspaceFrame>;

  return (
    <RouterContextProvider router={focusedRouter}>
      <AppSidebarLayoutContent>
        {isChildWindow ? frame : <PaneRow appRouter={appRouter} primary={frame} />}
      </AppSidebarLayoutContent>
    </RouterContextProvider>
  );
}

function AppSidebarLayoutContent({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useWarmSecondarySidebars();
  // Seeds server-side visited tracking from this browser's localStorage the
  useThreadVisitedMigration();
  const pathname = useLocation({ select: (location) => location.pathname });
  const shellStyle = {
    "--primary-navigation-rail-width": isChildWindow ? "0px" : PRIMARY_NAVIGATION_RAIL_WIDTH,
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <div className="flex h-dvh min-h-0 w-full bg-workspace-frame" style={shellStyle}>
      <ThreadQueueRuntime />
      <ProviderUpdateCheckCoordinator />
      <ProjectProjectionRetention />
      {isChildWindow ? null : <PrimaryNavigationRail />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-workspace-frame dark:surface-grain">
        <WorkspaceTopBar />
        <div
          className={cn(
            "mt-11 flex min-h-0 min-w-0 flex-1 flex-col gap-2 md:mt-0 md:mr-2 md:mb-2",
            // The rail is the frame's left gutter; a torn-out window has none, so it
            // gets the same gap as the right and bottom edges.
            isChildWindow && "md:ml-2",
          )}
          data-app-workspace-row=""
        >
          <div className="flex min-h-0 min-w-0 flex-1 gap-2" data-app-workspace-main-row="">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-app-primary-column="">
              {children}
              <div className="contents" data-terminal-card-host="" />
            </div>
            <div className="contents" data-inline-right-panel-host="" />
          </div>
          <div className="contents" data-terminal-full-width-host="" />
        </div>
      </div>
      <Suspense fallback={null}>
        <OrchestratorOverlay />
      </Suspense>
    </div>
  );
}

/**
 * The sidebar's open state, collapsing it while a narrow frame (a wide right panel, a
 * small window) would leave the main content cramped and reopening it once there is room.
 */
function useCrampedSidebarOpen(sidebarWidth: number) {
  const [state, setState] = useState<CrampedSidebarState>({
    open: true,
    autoCollapsed: false,
    cramped: false,
  });
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!frame) return;
    const observer = new ResizeObserver(() =>
      setState((previous) => resolveCrampedSidebarState(previous, frame.clientWidth, sidebarWidth)),
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame, sidebarWidth]);

  const onOpenChange = useCallback(
    (open: boolean) => setState((previous) => ({ ...previous, open, autoCollapsed: false })),
    [],
  );

  return { open: state.open, cramped: state.cramped, onOpenChange, frameRef: setFrame };
}

/** Like the mobile sheet, a floating sidebar gets out of the way once the pane navigates. */
function CloseSidebarOverlayOnNavigation({ pathname }: { pathname: string }) {
  const { closeOverlay } = useSidebar();
  useEffect(() => closeOverlay(), [closeOverlay, pathname]);
  return null;
}

/**
 * One pane's card: the page with its contextual sidebar, which follows the
 * router the frame renders under. Split, every pane has its own frame, so each
 * sidebar collapses on its own. A side pane's root route renders one around its
 * page.
 */
export function WorkspaceFrame({ children }: { children: ReactNode }) {
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  const pathname = useLocation({ select: (location) => location.pathname });
  const isMobile = useIsMobile();
  const secondarySidebarKind = resolveSecondarySidebarKind(pathname);
  // Mobile web keeps the existing drawer as its only global navigation. On
  // desktop, the icon rail owns global navigation and this panel is contextual.
  const shouldRenderSecondarySidebar = shouldRenderSecondarySidebarForViewport(
    isMobile,
    secondarySidebarKind,
  );
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const { open, cramped, onOpenChange, frameRef } = useCrampedSidebarOpen(sidebarWidth);

  return (
    <SidebarProvider
      className="relative min-h-0! min-w-0 flex-1 overflow-hidden rounded-t-xl bg-background shadow-[0_-4px_12px_rgb(0_0_0/0.06)] md:rounded-xl md:border md:border-sidebar-border md:shadow-none dark:shadow-[0_-4px_12px_rgb(0_0_0/0.24)] dark:md:shadow-none"
      data-app-content-frame=""
      ref={frameRef}
      open={open}
      onOpenChange={onOpenChange}
      // Cramped, the toggle shows the sidebar floating rather than taking room back.
      overlay={cramped}
      hoverReveal
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      {shouldRenderSecondarySidebar ? (
        <Sidebar
          side="left"
          collapsible="offcanvas"
          data-app-sidebar=""
          className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:absolute! md:inset-y-0 md:left-0! md:h-full!"
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: THREAD_SIDEBAR_MIN_WIDTH,
            shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
              nextWidth <= currentWidth ||
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
        >
          <Suspense fallback={null}>
            {secondarySidebarKind === "settings" ? (
              <>
                <ContextualSidebarHeader title="Settings" />
                <SettingsSidebarNav pathname={pathname} />
              </>
            ) : secondarySidebarKind === "email" ? (
              <EmailSidebar />
            ) : secondarySidebarKind === "calendar" ? (
              <CalendarSidebar />
            ) : secondarySidebarKind === "orchestrator" ? (
              <OrchestratorSidebar />
            ) : secondarySidebarKind === "projects" ? (
              <ProjectsSidebar />
            ) : secondarySidebarKind === "issues" ? (
              <IssuesSidebar />
            ) : secondarySidebarKind === "source-control" ? (
              <SourceControlSidebar />
            ) : (
              <ThreadSidebar />
            )}
          </Suspense>
          <SidebarRail />
        </Sidebar>
      ) : null}
      <CloseSidebarOverlayOnNavigation pathname={pathname} />
      {children}
      {shouldRenderSecondarySidebar ? <SidebarControl useArtworkContrast /> : null}
    </SidebarProvider>
  );
}
