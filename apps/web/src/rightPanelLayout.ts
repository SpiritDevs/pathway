export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const THREAD_PANEL_INLINE_MIN_WIDTH = 1_104;
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-screen! min-w-0! max-w-none! rounded-t-xl border border-sidebar-border p-0 shadow-sm/5 before:rounded-[calc(var(--radius-xl)-1px)] duration-[240ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-ending-style:translate-x-full data-ending-style:duration-150 data-starting-style:translate-x-full md:w-[var(--right-panel-sheet-width)]! md:max-w-[var(--right-panel-sheet-max-width)]! md:rounded-xl md:data-ending-style:translate-x-8 md:data-starting-style:translate-x-8 md:before:rounded-[calc(var(--radius-xl)-1px)] motion-reduce:transition-none motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-ending-style:opacity-100 motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-starting-style:opacity-100";
export const RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME = "pt-11 md:p-2 md:pt-11";

export function shouldPresentRightPanelAsSheet(input: {
  viewportRequiresSheet: boolean;
  poppedOut: boolean;
}): boolean {
  return input.viewportRequiresSheet || input.poppedOut;
}

export function shouldMountRightPanelSheet(input: {
  usesSheet: boolean;
  hasContent: boolean;
}): boolean {
  return input.usesSheet && input.hasContent;
}

export type ThreadPanelPresentation = "inline" | "popover";

export function resolveThreadPanelPresentation(
  workspaceWidth: number | null,
  occupiedRightPanelWidth: number,
  rightPanelOverlaysChat: boolean,
): ThreadPanelPresentation {
  if (workspaceWidth === null) return "inline";

  const chatPaneWidth = rightPanelOverlaysChat ? 0 : workspaceWidth - occupiedRightPanelWidth;
  return chatPaneWidth < THREAD_PANEL_INLINE_MIN_WIDTH ? "popover" : "inline";
}
