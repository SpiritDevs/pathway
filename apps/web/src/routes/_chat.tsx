import { threadQueueDestinationsAtom } from "../cloud/threadQueueState";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { useWorkspaceProjects } from "../components/projects/useWorkspaceProjects";
import { workspaceThreadStartAvailability } from "../components/projects/workspaceProjects.logic";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useComputerEventsServed } from "../hooks/useComputerSupport";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isPaneFocused, usePaneId } from "../panes/usePaneFocus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const workspaceProjects = useWorkspaceProjects();
  const queueDestinations = useAtomValue(threadQueueDestinationsAtom);
  const threadStartAvailability =
    queueDestinations.length > 0
      ? "available"
      : workspaceThreadStartAvailability(workspaceProjects);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const {
    activeDraftThread,
    activeThread,
    defaultConversationRef,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
  } = useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const computerServed = useComputerEventsServed(routeThreadRef?.environmentId ?? null);
  const paneId = usePaneId();
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // Every pane showing a chat route mounts this; only the focused one answers.
      if (event.defaultPrevented || !isPaneFocused(paneId)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          defaultConversationRef,
          handleNewThread,
        }).then((didStart) => {
          if (!didStart && threadStartAvailability !== "unavailable") {
            openCommandPalette({ open: "new-thread-in" });
          }
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          defaultConversationRef,
          handleNewThread,
        }).then((didStart) => {
          if (!didStart && threadStartAvailability !== "unavailable") {
            openCommandPalette({ open: "new-thread-in" });
          }
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        dispatchPreviewAction("toggle-panel");
        return;
      }

      if (command === "threadBrowser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        dispatchPreviewAction("toggle-browser-panel");
        return;
      }

      if (command === "computer.toggle") {
        if (!routeThreadRef || !computerServed) return;
        event.preventDefault();
        event.stopPropagation();
        useRightPanelStore.getState().toggle(routeThreadRef, "computer");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    computerServed,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    paneId,
    previewOpen,
    routeThreadRef,
    selectedThreadKeysSize,
    terminalOpen,
    threadStartAvailability,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "pending" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
