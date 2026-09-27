import { EnvironmentId, RunId } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  remoteAgentBrowserTabId,
  resolveRemoteAgentBrowserReveal,
} from "./useRemoteAgentBrowserReveal";

const environmentId = EnvironmentId.make("environment-1");
const activity = (hostClientId: string, tabId: string | null) => ({
  runId: RunId.make("run-1"),
  providerSessionId: "session-1",
  tabId,
  hostClientId,
  lastActivityAt: DateTime.makeUnsafe("2026-09-28T00:00:00.000Z"),
});

describe("remoteAgentBrowserTabId", () => {
  it("reports the agent's tab only when it browses in this environment's browser", () => {
    expect(
      remoteAgentBrowserTabId(
        activity("environment-browser:environment-1", "remote-1"),
        environmentId,
      ),
    ).toBe("remote-1");
    expect(remoteAgentBrowserTabId(activity("desktop-client", "tab-1"), environmentId)).toBeNull();
    expect(
      remoteAgentBrowserTabId(
        activity("environment-browser:environment-2", "remote-1"),
        environmentId,
      ),
    ).toBeNull();
    expect(
      remoteAgentBrowserTabId(activity("environment-browser:environment-1", null), environmentId),
    ).toBeNull();
    expect(remoteAgentBrowserTabId(null, environmentId)).toBeNull();
  });
});

describe("resolveRemoteAgentBrowserReveal", () => {
  const base = {
    tabId: "remote-1",
    panelOpen: false,
    panelShowsRemoteBrowser: false,
    remoteSelectedTabId: null,
    miniPlayerTabId: null,
  };

  it("floats the agent's tab in the mini-player while the panel is closed", () => {
    expect(resolveRemoteAgentBrowserReveal(base)).toBe("mini-player");
    expect(resolveRemoteAgentBrowserReveal({ ...base, miniPlayerTabId: "remote-1" })).toBeNull();
  });

  it("switches an open panel to the remote browser", () => {
    expect(resolveRemoteAgentBrowserReveal({ ...base, panelOpen: true })).toBe("panel");
  });

  it("follows the agent inside a panel already showing the remote browser", () => {
    const watching = { ...base, panelOpen: true, panelShowsRemoteBrowser: true };
    expect(resolveRemoteAgentBrowserReveal({ ...watching, remoteSelectedTabId: "remote-0" })).toBe(
      "select",
    );
    expect(
      resolveRemoteAgentBrowserReveal({ ...watching, remoteSelectedTabId: "remote-1" }),
    ).toBeNull();
  });
});
