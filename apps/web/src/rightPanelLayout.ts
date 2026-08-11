export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(33.75rem,calc(100vw-1rem))] min-w-90 max-w-[33.75rem] p-0 sm:w-[var(--right-panel-sheet-width)]! sm:max-w-[var(--right-panel-sheet-max-width)]! sm:rounded-xl sm:border sm:border-sidebar-border sm:shadow-sm/5 sm:before:rounded-[calc(var(--radius-xl)-1px)] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0";
export const RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME = "sm:p-2 sm:pt-11";

export function shouldPresentRightPanelAsSheet(input: {
  viewportRequiresSheet: boolean;
  poppedOut: boolean;
}): boolean {
  return input.viewportRequiresSheet || input.poppedOut;
}
