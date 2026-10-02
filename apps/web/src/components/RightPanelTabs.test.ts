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

  it("names browser tabs by their page, without a where-it-runs prefix", () => {
    const sessions = {
      "tab-1": {
        threadId: ThreadId.make("thread-1"),
        tabId: "tab-1",
        navStatus: { _tag: "Success" as const, url: "http://localhost:3000/", title: "Dashboard" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const remoteSurface = {
      id: "remote-browser" as const,
      kind: "preview" as const,
      resourceId: null,
    };

    expect(
      resolveRightPanelSurfaceTitle(
        { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
        sessions,
        new Map<string, string>(),
      ),
    ).toBe("Dashboard");
    expect(resolveRightPanelSurfaceTitle(remoteSurface, sessions, new Map<string, string>())).toBe(
      "Remote browser",
    );
    expect(
      resolveRightPanelSurfaceTitle(remoteSurface, sessions, new Map<string, string>(), undefined, {
        tabId: "remote-1",
        url: "https://example.com/docs",
        title: "",
      }),
    ).toBe("example.com");
  });
});
