import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  ThreadId,
  PreviewTabId,
  type PreviewSessionSnapshot,
} from "@spiritdevs/contracts";
import { openUrlInPreview } from "./openFileInPreview";

const calls = vi.hoisted(() => ({ apply: vi.fn(), remember: vi.fn(), openBrowser: vi.fn() }));
vi.mock("../previewStateStore", () => ({
  applyPreviewServerSnapshot: calls.apply,
  rememberPreviewUrl: calls.remember,
  isPreviewSupportedInRuntime: () => true,
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: calls.openBrowser }) },
}));

describe("visualization browser targeting", () => {
  it("opens and selects the browser in the source thread's environment", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("remote-owner"),
      threadId: ThreadId.make("inherited-source"),
    };
    const url = "https://remote-owner.example/api/assets/signed/preview.html";
    const snapshot = {
      threadId: threadRef.threadId,
      tabId: PreviewTabId.make("visualization-tab"),
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-09-12T02:22:38.632Z",
    } satisfies PreviewSessionSnapshot;
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));
    expect((await openUrlInPreview({ threadRef, url, openPreview }))._tag).toBe("Success");
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "remote-owner",
      input: { threadId: "inherited-source", url },
    });
    expect(calls.apply).toHaveBeenCalledWith(threadRef, snapshot);
    expect(calls.openBrowser).toHaveBeenCalledWith(threadRef, "visualization-tab");
  });

  it("does not open a panel when the environment rejects the request", async () => {
    calls.openBrowser.mockClear();
    const result = await openUrlInPreview({
      threadRef: {
        environmentId: EnvironmentId.make("offline"),
        threadId: ThreadId.make("source"),
      },
      url: "https://offline.example/api/assets/signed/preview.html",
      openPreview: async () => AsyncResult.failure(Cause.fail(new Error("Disconnected"))),
    });
    expect(result._tag).toBe("Failure");
    expect(calls.openBrowser).not.toHaveBeenCalled();
  });
});
