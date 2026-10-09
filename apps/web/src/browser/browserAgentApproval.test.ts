import {
  DEFAULT_BROWSER_AGENT_PERMISSIONS,
  setBrowserAgentSitePolicy,
} from "@spiritdevs/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const settingsState = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@spiritdevs/contracts");
  return {
    getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
    persistClientSettingsPatch: async (patch: Record<string, unknown>) => {
      settingsState.patches.push(patch);
    },
  };
});

import {
  answerBrowserAgentApproval,
  browserAgentSiteDecision,
  readBrowserAgentApprovals,
  requestBrowserAgentApproval,
  resetBrowserAgentApprovalsForTests,
} from "./browserAgentApproval";

vi.stubGlobal("window", globalThis);

afterEach(() => {
  resetBrowserAgentApprovalsForTests();
  settingsState.patches = [];
});

describe("browserAgentSiteDecision", () => {
  const permissions = setBrowserAgentSitePolicy(
    DEFAULT_BROWSER_AGENT_PERMISSIONS,
    "https://bank.example",
    { browse: "approval" },
  );

  it("maps a site's browse access to a decision", () => {
    expect(
      browserAgentSiteDecision({ browserAgentPermissions: permissions }, "https://bank.example/a"),
    ).toBe("ask");
    expect(
      browserAgentSiteDecision({ browserAgentPermissions: permissions }, "https://other.example"),
    ).toBe("allow");
  });

  it("never gates pages that are not websites", () => {
    const blocked = {
      ...permissions,
      defaults: { ...permissions.defaults, browse: "block" as const },
    };
    expect(browserAgentSiteDecision({ browserAgentPermissions: blocked }, "about:blank")).toBe(
      "allow",
    );
  });
});

describe("requestBrowserAgentApproval", () => {
  const request = { kind: "site", origin: "https://bank.example" } as const;

  it("shares one prompt between waiters and remembers a session approval", async () => {
    const first = requestBrowserAgentApproval(request, 60_000);
    const second = requestBrowserAgentApproval(request, 60_000);
    const [pending] = readBrowserAgentApprovals();
    expect(readBrowserAgentApprovals()).toHaveLength(1);

    await answerBrowserAgentApproval(pending!.key, "session");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(requestBrowserAgentApproval(request, 60_000)).resolves.toBe(true);
    expect(settingsState.patches).toEqual([]);
  });

  it("denies without saving anything", async () => {
    const answer = requestBrowserAgentApproval(request, 60_000);
    await answerBrowserAgentApproval(readBrowserAgentApprovals()[0]!.key, "deny");
    await expect(answer).resolves.toBe(false);
    expect(readBrowserAgentApprovals()).toEqual([]);
    expect(settingsState.patches).toEqual([]);
  });

  it("saves Always allow to the site's agent permissions", async () => {
    const answer = requestBrowserAgentApproval(request, 60_000);
    await answerBrowserAgentApproval(readBrowserAgentApprovals()[0]!.key, "always");
    await expect(answer).resolves.toBe(true);
    expect(settingsState.patches).toEqual([
      {
        browserAgentPermissions: {
          ...DEFAULT_BROWSER_AGENT_PERMISSIONS,
          sites: [{ pattern: "https://bank.example", browse: "allow" }],
        },
      },
    ]);
  });

  it("saves Always allow for history access", async () => {
    const answer = requestBrowserAgentApproval({ kind: "history" }, 60_000);
    await answerBrowserAgentApproval("history", "always");
    await expect(answer).resolves.toBe(true);
    expect(settingsState.patches).toEqual([{ browserHistoryAccess: "allow" }]);
  });
});
