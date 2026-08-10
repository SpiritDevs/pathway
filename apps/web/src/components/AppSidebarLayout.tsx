import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { useIsMobile } from "../hooks/useMediaQuery";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../hooks/useSettings";
import LegacyThreadSidebar from "./LegacySidebar";
import ThreadSidebar from "./Sidebar";
import { CalendarSidebar } from "./calendar/CalendarSidebar";
import { EmailSidebar } from "./email/EmailSidebar";
import { IssuesSidebar } from "./issues/IssuesSidebar";
import { OrchestratorSidebar } from "./orchestrator/OrchestratorSidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { ContextualSidebarHeader } from "./sidebar/ContextualSidebarHeader";
import { SourceControlSidebar } from "./sourceControl/SourceControlSidebar";
import {
  PRIMARY_NAVIGATION_EXPANDED_STORAGE_KEY,
  PrimaryNavigationRail,
  resolvePrimaryNavigationRailWidth,
} from "./navigation/PrimaryNavigationRail";
import { WorkspaceTopBar } from "./navigation/WorkspaceTopBar";
import {
  resolveSecondarySidebarKind,
  shouldRenderSecondarySidebar as shouldRenderSecondarySidebarForViewport,
} from "./secondarySidebar";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import {
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

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

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
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    useArtworkContrast && environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
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
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center transition-[left] duration-200 ease-linear motion-reduce:transition-none md:left-[calc(var(--primary-navigation-rail-width)+var(--workspace-controls-left))] md:top-11"
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
                isSidebarVisible &&
                  stageBackdropVariant &&
                  "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
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

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isMobile = useIsMobile();
  const [isPrimaryNavigationExpanded, setPrimaryNavigationExpanded] = useLocalStorage(
    PRIMARY_NAVIGATION_EXPANDED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const secondarySidebarKind = resolveSecondarySidebarKind(pathname);
  // Mobile web keeps the existing drawer as its only global navigation. On
  // desktop, the icon rail owns global navigation and this panel is contextual.
  const shouldRenderSecondarySidebar = shouldRenderSecondarySidebarForViewport(
    isMobile,
    secondarySidebarKind,
  );
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--primary-navigation-rail-width": resolvePrimaryNavigationRailWidth(
      isPrimaryNavigationExpanded,
    ),
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

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
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={sidebarProviderStyle}>
      <ProjectProjectionRetention />
      <PrimaryNavigationRail
        expanded={isPrimaryNavigationExpanded}
        onExpandedChange={setPrimaryNavigationExpanded}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar surface-grain">
        <WorkspaceTopBar />
        <div
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background md:mr-2 md:mb-2 md:rounded-xl md:border md:border-sidebar-border md:shadow-sm/5"
          data-app-content-frame=""
        >
          {shouldRenderSecondarySidebar ? (
            <Sidebar
              side="left"
              collapsible="offcanvas"
              data-app-sidebar=""
              className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:absolute! md:inset-y-0 md:left-0! md:h-full! md:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]!"
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
              ) : secondarySidebarKind === "issues" ? (
                <IssuesSidebar />
              ) : secondarySidebarKind === "source-control" ? (
                <SourceControlSidebar />
              ) : legacySidebarEnabled ? (
                <LegacyThreadSidebar />
              ) : (
                <ThreadSidebar />
              )}
              <SidebarRail />
            </Sidebar>
          ) : null}
          {children}
        </div>
      </div>
      {shouldRenderSecondarySidebar ? <SidebarControl useArtworkContrast /> : null}
    </SidebarProvider>
  );
}
