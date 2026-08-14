/**
 * Matches AGENT_CURSOR_MOVE_MS in apps/desktop/src/preview/Manager.ts: the
 * desktop emits the "move" pointer event, waits this long, then emits "click"
 * and dispatches the real input — so the glide must land within this window.
 */
export const AGENT_CURSOR_GLIDE_MS = 160;

export function agentBrowserCursorOpacity(active: boolean): number {
  return active ? 1 : 0.35;
}

export interface AgentBrowserCursorContent {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export interface AgentBrowserCursorPoint {
  readonly x: number;
  readonly y: number;
}

/** Guest-viewport CSS coordinates → slot-local pixels. */
export function agentBrowserCursorGlidePosition(
  event: AgentBrowserCursorPoint,
  zoomFactor: number,
  content: AgentBrowserCursorContent | null,
): AgentBrowserCursorPoint {
  const scale = content?.scale ?? 1;
  return {
    x: event.x * zoomFactor * scale,
    y: event.y * zoomFactor * scale,
  };
}

/**
 * Viewport offset inside the slot (letterboxing, device toolbar, wrapper
 * scroll). Applied without animation so the cursor tracks panel scroll and
 * resize instantly while only agent movement glides.
 */
export function agentBrowserCursorSurfaceOffset(
  content: AgentBrowserCursorContent | null,
): AgentBrowserCursorPoint {
  return {
    x: (content?.x ?? 0) - (content?.scrollLeft ?? 0),
    y: (content?.y ?? 0) - (content?.scrollTop ?? 0),
  };
}
