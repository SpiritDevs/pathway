import { describe, expect, it } from "vite-plus/test";

import {
  resolveBrowserTakeoverPill,
  resolveCollapsedComposerAction,
} from "./threadComposerPresentation";

describe("collapsed composer action", () => {
  it("keeps Send available for a typed message while the active run can stop", () => {
    expect(resolveCollapsedComposerAction({ canStopThread: true, hasContent: true })).toBe("send");
  });

  it("shows Stop only when an interruptible run owns an empty composer", () => {
    expect(resolveCollapsedComposerAction({ canStopThread: true, hasContent: false })).toBe("stop");
    expect(resolveCollapsedComposerAction({ canStopThread: false, hasContent: false })).toBe(
      "send",
    );
  });
});

describe("browser takeover pill", () => {
  it("stays hidden when no takeover owns the thread", () => {
    expect(resolveBrowserTakeoverPill({ status: null, failure: null })).toBeNull();
    expect(resolveBrowserTakeoverPill({ status: "completed", failure: null })).toBeNull();
    expect(resolveBrowserTakeoverPill({ status: "cancelled", failure: null })).toBeNull();
  });

  it("spins while the takeover is still moving and holds still once it lands", () => {
    expect(resolveBrowserTakeoverPill({ status: "requested", failure: null })?.kind).toBe(
      "working",
    );
    expect(resolveBrowserTakeoverPill({ status: "pausing", failure: null })?.kind).toBe("working");
    expect(resolveBrowserTakeoverPill({ status: "proceeding", failure: null })?.kind).toBe(
      "working",
    );
    const active = resolveBrowserTakeoverPill({ status: "active", failure: null });
    expect(active?.kind).toBe("attention");
    expect(active?.label).toContain("Agent paused");
  });

  it("names the failure, and still says something when the server omits one", () => {
    expect(resolveBrowserTakeoverPill({ status: "failed", failure: "host_disconnected" })).toEqual({
      kind: "attention",
      label: "The desktop hosting the browser disconnected.",
    });
    expect(resolveBrowserTakeoverPill({ status: "failed", failure: null })?.label).toBe(
      "The browser takeover failed.",
    );
  });
});
