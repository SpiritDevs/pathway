// Mirror the agent cursor colors to the desktop main process, which persists
// them and pushes them to the running driver. A plain browser has no bridge, so
// every path here is a no-op there.

import {
  resolveAgentCursorColors,
  type ClientSettings,
  type DesktopAgentCursorStyle,
} from "@spiritdevs/contracts";
import { useEffect } from "react";

import { useClientSettings } from "../../hooks/useSettings";

/**
 * Send one cursor-style value to the desktop main process. A rejected send is
 * swallowed: main already holds the last durable value, and a background
 * mirror failing must not surface as an error.
 */
export function pushAgentCursorStyleToDesktop(style: DesktopAgentCursorStyle | null): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge?.computer;
  if (!bridge?.setCursorStyle) return;
  void bridge.setCursorStyle(style).catch(() => undefined);
}

const selectAgentCursorMode = (settings: ClientSettings) => settings.agentCursorColorMode;
const selectAgentCursorFill = (settings: ClientSettings) => settings.agentCursorFillColor;
const selectAgentCursorRim = (settings: ClientSettings) => settings.agentCursorRimColor;

/**
 * Mirror the current agent cursor colors on mount and on every change. The
 * mount push also refreshes a value that predates the desktop preference file.
 * Stock pushes null, which removes any stored override.
 */
export function useAgentCursorDesktopSync(): void {
  const mode = useClientSettings(selectAgentCursorMode);
  const fill = useClientSettings(selectAgentCursorFill);
  const rim = useClientSettings(selectAgentCursorRim);
  useEffect(() => {
    pushAgentCursorStyleToDesktop(
      resolveAgentCursorColors({
        agentCursorColorMode: mode,
        agentCursorFillColor: fill,
        agentCursorRimColor: rim,
      }),
    );
  }, [mode, fill, rim]);
}

/** App-root mount point, beside the other appearance syncs. Renders nothing. */
export function AgentCursorDesktopSync(): null {
  useAgentCursorDesktopSync();
  return null;
}
