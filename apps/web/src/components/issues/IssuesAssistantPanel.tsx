/**
 * Draft conversations opened beside the issues list.
 *
 * These use the same tab shell as thread side chats, but the list owns their session ordering:
 * an issues page has no parent thread whose right-panel state could own them.
 *
 * @module components/issues/IssuesAssistantPanel
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { DraftId } from "~/composerDraftStore";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import type { RightPanelSurface } from "~/rightPanelStore";
import ChatView from "../ChatView";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { InlineRightPanelPortal } from "../preview/InlineRightPanelPresence";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";

const EMPTY_PENDING_SURFACES = new Set<string>();
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY = "pathway:issues-assistant-panel-width";

export interface IssuesAssistantDraft {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

export function IssuesAssistantPanel({
  drafts,
  activeDraftId,
  onActivate,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
}: {
  drafts: ReadonlyArray<IssuesAssistantDraft>;
  activeDraftId: DraftId | null;
  onActivate: (draftId: DraftId) => void;
  onClose: (draftId: DraftId) => void;
  onCloseAll: () => void;
  onCloseOthers: (draftId: DraftId) => void;
  onCloseToRight: (draftId: DraftId) => void;
}) {
  const useSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const activeDraft = drafts.find((draft) => draft.draftId === activeDraftId) ?? drafts[0] ?? null;
  const surfaces = useMemo<ReadonlyArray<RightPanelSurface>>(
    () =>
      drafts.map((draft) => ({
        id: `thread:${draft.threadId}`,
        kind: "thread",
        resourceId: draft.threadId,
      })),
    [drafts],
  );
  const draftByThreadId = useMemo(
    () => new Map(drafts.map((draft) => [draft.threadId, draft])),
    [drafts],
  );
  const threadTitlesById = useMemo(
    () => new Map(drafts.map((draft) => [draft.threadId, draft.title])),
    [drafts],
  );

  const draftForSurface = (surface: RightPanelSurface) =>
    surface.kind === "thread" ? (draftByThreadId.get(surface.resourceId) ?? null) : null;
  const renderPanel = (mode: "inline" | "sheet") =>
    activeDraft === null ? null : (
      <RightPanelTabs
        activeSurfaceId={`thread:${activeDraft.threadId}`}
        agentsAvailable={false}
        browserAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        liveAgentCount={0}
        mode={mode}
        onActivate={(surface) => {
          const draft = draftForSurface(surface);
          if (draft !== null) onActivate(draft.draftId);
        }}
        onAddAgents={() => undefined}
        onAddBrowser={() => undefined}
        onAddDiff={() => undefined}
        onAddFiles={() => undefined}
        onAddPullRequest={() => undefined}
        onAddSideChat={() => undefined}
        onAddTerminal={() => undefined}
        onCloseAllSurfaces={onCloseAll}
        onCloseOtherSurfaces={(surface) => {
          const draft = draftForSurface(surface);
          if (draft !== null) onCloseOthers(draft.draftId);
        }}
        onCloseSurface={(surface) => {
          const draft = draftForSurface(surface);
          if (draft !== null) onClose(draft.draftId);
        }}
        onCloseSurfacesToRight={(surface) => {
          const draft = draftForSurface(surface);
          if (draft !== null) onCloseToRight(draft.draftId);
        }}
        onCopyFilePath={() => undefined}
        pendingSurfaceIds={EMPTY_PENDING_SURFACES}
        previewSessions={EMPTY_PREVIEW_SESSIONS}
        pullRequestAvailable={false}
        sideChatAvailable={false}
        surfaces={surfaces}
        terminalAvailable={false}
        terminalLabelsById={EMPTY_TERMINAL_LABELS}
        threadTitlesById={threadTitlesById}
        widthStorageKey={ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY}
      >
        <DiffWorkerPoolProvider>
          <ChatView
            draftId={activeDraft.draftId}
            environmentId={activeDraft.environmentId}
            presentation="panel"
            reserveTitleBarControlInset={false}
            routeKind="draft"
            threadId={activeDraft.threadId}
          />
        </DiffWorkerPoolProvider>
      </RightPanelTabs>
    );

  const open = activeDraft !== null;
  return (
    <>
      {!useSheet ? (
        <InlineRightPanelPortal open={open}>{renderPanel("inline")}</InlineRightPanelPortal>
      ) : null}
      {useSheet && open ? (
        <RightPanelSheet
          onClose={onCloseAll}
          open
          widthStorageKey={ISSUES_ASSISTANT_PANEL_WIDTH_STORAGE_KEY}
        >
          {renderPanel("sheet")}
        </RightPanelSheet>
      ) : null}
    </>
  );
}
