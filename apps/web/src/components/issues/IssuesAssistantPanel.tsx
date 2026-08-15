/**
 * Issue details, side chats, and browser tabs opened beside the issues list.
 *
 * The list owns its issue/chat tab order. Browser sessions use a synthetic thread identity only
 * as their server-side preview namespace; no agent thread is created for a browser tab.
 *
 * @module components/issues/IssuesAssistantPanel
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "~/previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import type { RightPanelKind, RightPanelSurface } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatView from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { InlineRightPanelPortal } from "../preview/InlineRightPanelPresence";
import { closePreviewSession } from "../preview/closePreviewSession";
import { openPreviewSession } from "../preview/openPreviewSession";
import { PreviewPanel } from "../preview/PreviewPanel";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { Button } from "../ui/button";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { issuesAssistantSurfaces, type IssuesAssistantTab } from "./issuesAssistantPanel.logic";

export type { IssuesAssistantTab } from "./issuesAssistantPanel.logic";

const EMPTY_CONFIGURED_URLS: ReadonlyArray<string> = [];
const EMPTY_PENDING_SURFACES = new Set<string>();
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const ISSUE_SURFACE_KINDS = new Set<RightPanelKind>(["preview", "thread"]);
const ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY = "pathway:issues-assistant-panel-width";

export function IssuesAssistantPanel({
  activeTabId,
  tabs,
  open,
  panelThreadRef,
  sideChatAvailable,
  onActivate,
  onAddSideChat,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  onOpenChange,
  onOpenIssue,
}: {
  activeTabId: string | null;
  tabs: ReadonlyArray<IssuesAssistantTab>;
  open: boolean;
  panelThreadRef: ScopedThreadRef | null;
  sideChatAvailable: boolean;
  onActivate: (tabId: string) => void;
  onAddSideChat: () => Promise<string | null>;
  onClose: (tabId: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onOpenChange: (open: boolean) => void;
  onOpenIssue: (issueKey: string, title?: string) => void;
}) {
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const previewState = useThreadPreviewState(panelThreadRef);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(activeTabId);

  const surfaces = useMemo<ReadonlyArray<RightPanelSurface>>(
    () => [
      ...issuesAssistantSurfaces(tabs),
      ...Object.keys(previewState.sessions).map(
        (tabId): RightPanelSurface => ({
          id: `browser:${tabId}`,
          kind: "preview",
          resourceId: tabId,
        }),
      ),
    ],
    [previewState.sessions, tabs],
  );
  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const threadTitlesById = useMemo(
    () =>
      new Map(
        tabs.flatMap((tab) =>
          tab.kind === "draft" || tab.kind === "thread"
            ? ([[tab.threadId, tab.title]] as const)
            : [],
        ),
      ),
    [tabs],
  );

  useEffect(() => {
    if (activeTabId !== null) setActiveSurfaceId(activeTabId);
  }, [activeTabId]);

  useEffect(() => {
    if (activeSurfaceId === null || surfaces.some((surface) => surface.id === activeSurfaceId)) {
      return;
    }
    setActiveSurfaceId(surfaces[0]?.id ?? null);
  }, [activeSurfaceId, surfaces]);

  const activate = useCallback(
    (surface: RightPanelSurface) => {
      setActiveSurfaceId(surface.id);
      if (surface.kind === "preview" && surface.resourceId !== null && panelThreadRef !== null) {
        setActivePreviewTab(panelThreadRef, surface.resourceId);
      } else {
        onActivate(surface.id);
      }
    },
    [onActivate, panelThreadRef],
  );

  const closeBrowserSurfaces = useCallback(
    (closing: ReadonlyArray<RightPanelSurface>) => {
      if (panelThreadRef === null) return;
      for (const surface of closing) {
        if (surface.kind !== "preview" || surface.resourceId === null) continue;
        void closePreviewSession({
          closePreview,
          snapshot: previewState.sessions[surface.resourceId] ?? null,
          tabId: surface.resourceId,
          threadRef: panelThreadRef,
        });
      }
    },
    [closePreview, panelThreadRef, previewState.sessions],
  );

  const closeSurface = useCallback(
    (surface: RightPanelSurface) => {
      const index = surfaces.findIndex((candidate) => candidate.id === surface.id);
      if (surface.kind === "preview") closeBrowserSurfaces([surface]);
      else onClose(surface.id);
      const remaining = surfaces.filter((candidate) => candidate.id !== surface.id);
      if (activeSurfaceId === surface.id) {
        setActiveSurfaceId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
      }
    },
    [activeSurfaceId, closeBrowserSurfaces, onClose, surfaces],
  );

  const addBrowser = useCallback(() => {
    if (panelThreadRef === null) return;
    void openPreviewSession({ openPreview, threadRef: panelThreadRef }).then((result) => {
      if (result._tag === "Success") setActiveSurfaceId(`browser:${result.value.tabId}`);
    });
  }, [openPreview, panelThreadRef]);

  const addSideChat = useCallback(() => {
    void onAddSideChat().then((tabId) => {
      if (tabId !== null) setActiveSurfaceId(tabId);
    });
  }, [onAddSideChat]);

  const activeSurface = surfaces.find((surface) => surface.id === activeSurfaceId) ?? null;
  const activeTab =
    activeSurface?.kind === "thread" || activeSurface?.kind === "issue"
      ? (tabById.get(activeSurface.id) ?? null)
      : null;
  const content =
    activeSurface?.kind === "preview" && panelThreadRef !== null ? (
      <PreviewPanel
        configuredUrls={EMPTY_CONFIGURED_URLS}
        mode="embedded"
        tabId={activeSurface.resourceId}
        threadRef={panelThreadRef}
        visible
      />
    ) : activeTab?.kind === "draft" ? (
      <DiffWorkerPoolProvider>
        <ChatView
          draftId={activeTab.draftId}
          environmentId={activeTab.environmentId}
          onOpenIssueContext={(context) => onOpenIssue(context.key, context.title)}
          presentation="panel"
          reserveTitleBarControlInset={false}
          routeKind="draft"
          threadId={activeTab.threadId}
        />
      </DiffWorkerPoolProvider>
    ) : activeTab?.kind === "thread" ? (
      <DiffWorkerPoolProvider>
        <ChatView
          environmentId={activeTab.environmentId}
          onOpenIssueContext={(context) => onOpenIssue(context.key, context.title)}
          presentation="panel"
          reserveTitleBarControlInset={false}
          routeKind="server"
          threadId={activeTab.threadId}
        />
      </DiffWorkerPoolProvider>
    ) : activeTab?.kind === "issue" ? (
      <IssueDetailSheet
        issueKey={activeTab.issueKey}
        onClose={() => onClose(activeTab.id)}
        onOpenInIssues={(key) => onOpenIssue(key)}
        onOpenIssueKey={(key) => onOpenIssue(key)}
        presentation="inline"
      />
    ) : null;

  const renderPanel = (mode: "inline" | "sheet") => (
    <RightPanelTabs
      activeSurfaceId={activeSurfaceId}
      agentsAvailable={false}
      allowedSurfaceKinds={ISSUE_SURFACE_KINDS}
      browserAvailable={isPreviewSupportedInRuntime() && panelThreadRef !== null}
      diffAvailable={false}
      filesAvailable={false}
      layoutControls={
        <Button
          aria-label="Close issues sidebar"
          onClick={() => onOpenChange(false)}
          size="icon-xs"
          variant="ghost"
        >
          <PanelRightIcon />
        </Button>
      }
      liveAgentCount={0}
      mode={mode}
      onActivate={activate}
      onAddAgents={() => undefined}
      onAddBrowser={addBrowser}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddPullRequest={() => undefined}
      onAddSideChat={addSideChat}
      onAddTerminal={() => undefined}
      onCloseAllSurfaces={() => {
        closeBrowserSurfaces(surfaces);
        onCloseAll();
        setActiveSurfaceId(null);
      }}
      onCloseOtherSurfaces={(surface) => {
        closeBrowserSurfaces(surfaces.filter((candidate) => candidate.id !== surface.id));
        if (surface.kind === "preview") onCloseAll();
        else onCloseOthers(surface.id);
        activate(surface);
      }}
      onCloseSurface={closeSurface}
      onCloseSurfacesToRight={(surface) => {
        const index = surfaces.findIndex((candidate) => candidate.id === surface.id);
        closeBrowserSurfaces(index < 0 ? [] : surfaces.slice(index + 1));
        onCloseToRight(surface.id);
        activate(surface);
      }}
      onCopyFilePath={() => undefined}
      pendingSurfaceIds={EMPTY_PENDING_SURFACES}
      previewSessions={previewState.sessions}
      pullRequestAvailable={false}
      sideChatAvailable={sideChatAvailable}
      surfaces={surfaces}
      terminalAvailable={false}
      terminalLabelsById={EMPTY_TERMINAL_LABELS}
      threadTitlesById={threadTitlesById}
      widthStorageKey={ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY}
    >
      {content}
    </RightPanelTabs>
  );

  return (
    <>
      {!useSheet ? (
        <InlineRightPanelPortal open={open}>
          {open ? renderPanel("inline") : null}
        </InlineRightPanelPortal>
      ) : null}
      {useSheet && open ? (
        <RightPanelSheet
          onClose={() => onOpenChange(false)}
          open
          widthStorageKey={ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY}
        >
          {renderPanel("sheet")}
        </RightPanelSheet>
      ) : null}
    </>
  );
}
