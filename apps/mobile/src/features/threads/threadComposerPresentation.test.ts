import { describe, expect, it } from "vite-plus/test";

import { resolveCollapsedComposerAction } from "./threadComposerPresentation";

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
