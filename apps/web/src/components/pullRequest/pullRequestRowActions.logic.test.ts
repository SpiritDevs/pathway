import { describe, expect, it, vi } from "vite-plus/test";

import { pullRequestRowMenuPosition } from "./pullRequestRowActions.logic";

describe("pull request row menu position", () => {
  it("anchors keyboard invocation below the focused row", () => {
    expect(
      pullRequestRowMenuPosition({
        clientX: 0,
        clientY: 0,
        currentTarget: { getBoundingClientRect: () => ({ left: 420, bottom: 280 }) },
      }),
    ).toEqual({ x: 420, y: 280 });
  });

  it.each([
    [480, 230],
    [0, 230],
    [480, 0],
  ])("keeps pointer coordinates %i, %i", (clientX, clientY) => {
    const getBoundingClientRect = vi.fn();
    expect(
      pullRequestRowMenuPosition({ clientX, clientY, currentTarget: { getBoundingClientRect } }),
    ).toEqual({ x: clientX, y: clientY });
    expect(getBoundingClientRect).not.toHaveBeenCalled();
  });
});
