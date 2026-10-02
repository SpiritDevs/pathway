import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { openRemoteBrowser, useRemoteBrowserStore } from "./remoteBrowserStore";

// The remote browser is switched off in the app; these tests keep covering it.
vi.mock("~/browser/browserPlacement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserPlacement")>()),
  remoteBrowserEnabled: true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useRemoteBrowserStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
});

describe("remoteBrowserStore", () => {
  it("opens the panel on a requested tab", () => {
    openRemoteBrowser(ref, { tabId: "remote-1" });

    expect(useRemoteBrowserStore.getState().byThreadKey[scopedThreadKey(ref)]?.selectedTabId).toBe(
      "remote-1",
    );
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("remote-browser");
  });

  it("hands a pending URL to exactly one consumer", () => {
    openRemoteBrowser(ref, { url: "http://localhost:3000/" });

    expect(useRemoteBrowserStore.getState().takePendingUrl(ref)).toBe("http://localhost:3000/");
    expect(useRemoteBrowserStore.getState().takePendingUrl(ref)).toBeNull();
  });
});
