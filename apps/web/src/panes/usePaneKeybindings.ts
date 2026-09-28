/**
 * Pane keybindings and the desktop View menu's pane items, for the main window.
 * Inert in a torn-out window, which never splits.
 */
import { useAtomValue } from "@effect/atom-react";
import { PANE_KEYBINDING_COMMANDS, type PaneKeybindingCommand } from "@spiritdevs/contracts";
import { useEffect } from "react";

import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { closeAllSidePanes, closeFocusedPane, splitFocusedPane } from "./paneActions";
import { isSplit } from "./paneLayout";
import { usePaneStore } from "./paneStore";
import { isChildWindow } from "./windowMode";

/** Desktop menu actions the main window's renderer handles. */
const PANE_MENU_ACTIONS: Readonly<Record<string, () => void>> = {
  "pane-split": splitFocusedPane,
  "pane-close": closeFocusedPane,
  "pane-close-all": closeAllSidePanes,
};

/** Runs a pane command, returning whether it applied to the current layout. */
function runPaneCommand(command: PaneKeybindingCommand): boolean {
  const { layout, focusAdjacentPane } = usePaneStore.getState();
  switch (command) {
    case "pane.split":
      splitFocusedPane();
      return true;
    case "pane.focusLeft":
    case "pane.focusRight":
      if (!isSplit(layout)) return false;
      focusAdjacentPane(command === "pane.focusLeft" ? "left" : "right");
      return true;
    case "pane.close":
      if (!isSplit(layout)) return false;
      closeFocusedPane();
      return true;
  }
}

function isPaneCommand(command: string | null): command is PaneKeybindingCommand {
  return (PANE_KEYBINDING_COMMANDS as ReadonlyArray<string | null>).includes(command);
}

export function usePaneKeybindings(): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  useEffect(() => {
    if (isChildWindow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings);
      if (!isPaneCommand(command)) return;
      // Holding the key steps focus along the row, but opens or closes only one pane.
      const repeatable = command === "pane.focusLeft" || command === "pane.focusRight";
      if (event.repeat && !repeatable) {
        event.preventDefault();
        return;
      }
      if (!runPaneCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (isChildWindow || typeof onMenuAction !== "function") return;
    return onMenuAction((action) => PANE_MENU_ACTIONS[action]?.());
  }, []);
}
