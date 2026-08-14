import { ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveRightPanelSurfaceTitle } from "./RightPanelTabs";

describe("resolveRightPanelSurfaceTitle", () => {
  const childThreadId = ThreadId.make("thread-child");
  const surface = {
    id: `thread:${childThreadId}`,
    kind: "thread",
    resourceId: childThreadId,
  } as const;

  it("uses the live child thread title instead of persisting a stale label", () => {
    expect(
      resolveRightPanelSurfaceTitle(
        surface,
        {},
        new Map<string, string>(),
        new Map<string, string>([[childThreadId, "  Investigate websocket retries  "]]),
      ),
    ).toBe("Investigate websocket retries");
  });

  it("falls back to a stable side-chat label while the child title is unavailable", () => {
    expect(resolveRightPanelSurfaceTitle(surface, {}, new Map<string, string>())).toBe("Side chat");
    expect(
      resolveRightPanelSurfaceTitle(
        surface,
        {},
        new Map<string, string>(),
        new Map<string, string>([[childThreadId, "  "]]),
      ),
    ).toBe("Side chat");
  });
});
