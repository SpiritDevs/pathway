/**
 * Matches AGENT_CURSOR_MOVE_MS in apps/desktop/src/preview/Manager.ts: the
 * desktop emits the "move" pointer event, waits this long, then emits "click"
 * and dispatches the real input — so the glide must land within this window.
 */
export const AGENT_CURSOR_GLIDE_MS = 160;

export function agentBrowserCursorOpacity(active: boolean): number {
  return active ? 1 : 0.35;
}

export interface AgentBrowserCursorPoint {
  readonly x: number;
  readonly y: number;
}

/** Guest-viewport CSS coordinates → rendered surface pixels. */
export function agentBrowserCursorGlidePosition(
  event: AgentBrowserCursorPoint,
  zoomFactor: number,
  scale: number,
): AgentBrowserCursorPoint {
  return {
    x: event.x * zoomFactor * scale,
    y: event.y * zoomFactor * scale,
  };
}
