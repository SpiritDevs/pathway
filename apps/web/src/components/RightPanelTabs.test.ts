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

  it("labels issue surfaces with the issue key and title", () => {
    expect(
      resolveRightPanelSurfaceTitle(
        {
          id: "issue:ISS-27",
          kind: "issue",
          issueKey: "ISS-27",
          title: "The issue modal needs more room",
        },
        {},
        new Map<string, string>(),
      ),
    ).toBe("ISS-27 The issue modal needs more room");
  });
});
