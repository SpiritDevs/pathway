import { describe, expect, it } from "vite-plus/test";

import {
  type CrampedSidebarState,
  resolveCrampedSidebarState,
  resolveInitialThreadSidebarWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360, 1200)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a smaller window", () => {
    const viewportWidth = 1000;

    expect(resolveInitialThreadSidebarWidth(900, viewportWidth)).toBe(
      viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });

  it("keeps the sidebar minimum when the whole layout is narrower than its minimums", () => {
    expect(resolveInitialThreadSidebarWidth(900, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });
});

describe("cramped thread sidebar", () => {
  const sidebarWidth = THREAD_SIDEBAR_DEFAULT_WIDTH;
  const roomy = sidebarWidth + THREAD_MAIN_CONTENT_MIN_WIDTH;
  const cramped = roomy - 1;
  const initial: CrampedSidebarState = { open: true, autoCollapsed: false, cramped: false };
  const resize = (state: CrampedSidebarState, ...widths: number[]) =>
    widths.reduce(
      (current, width) => resolveCrampedSidebarState(current, width, sidebarWidth),
      state,
    );

  it("collapses when the main content gets cramped and reopens when the room returns", () => {
    const collapsed = resize(initial, roomy, cramped);
    expect(collapsed).toEqual({ open: false, autoCollapsed: true, cramped: true });
    expect(resize(collapsed, cramped - 100, roomy)).toEqual(initial);
  });

  it("keeps a sidebar the user reopened while cramped", () => {
    const reopened = { ...resize(initial, cramped), open: true, autoCollapsed: false };
    expect(resize(reopened, cramped - 50, cramped - 10)).toEqual(reopened);
  });

  it("does not reopen a sidebar the user had closed", () => {
    const closed = { ...initial, open: false };
    expect(resize(closed, cramped, roomy)).toEqual({ ...closed, cramped: false });
  });
});
