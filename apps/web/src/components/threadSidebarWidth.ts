export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
  );
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}

export interface CrampedSidebarState {
  readonly open: boolean;
  /** The sidebar was collapsed to make room, so it reopens once there is room again. */
  readonly autoCollapsed: boolean;
  readonly cramped: boolean;
}

/**
 * Steps the thread sidebar aside when its frame leaves the main content too little room,
 * and brings it back when the room returns. It only acts as the frame crosses the line,
 * so a user who reopens or closes the sidebar meanwhile keeps their choice.
 */
export function resolveCrampedSidebarState(
  previous: CrampedSidebarState,
  frameWidth: number,
  sidebarWidth: number,
): CrampedSidebarState {
  const cramped = frameWidth - sidebarWidth < THREAD_MAIN_CONTENT_MIN_WIDTH;
  if (cramped === previous.cramped) return previous;
  if (cramped) {
    return previous.open ? { open: false, autoCollapsed: true, cramped } : { ...previous, cramped };
  }
  return previous.autoCollapsed
    ? { open: true, autoCollapsed: false, cramped }
    : { ...previous, cramped };
}
