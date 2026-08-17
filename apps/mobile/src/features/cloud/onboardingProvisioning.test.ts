import { describe, expect, it, vi } from "vite-plus/test";

import {
  completeOnboardingAfterWorkspaceProvision,
  hasUsableOnboardingWorkspace,
  onboardingProvisioningErrorMessage,
  onboardingWorkspaceProvisioningArgs,
  provisionOnboardingWorkspace,
} from "./onboardingProvisioning";

describe("onboardingWorkspaceProvisioningArgs", () => {
  it("maps individual onboarding to a personal workspace", () => {
    expect(onboardingWorkspaceProvisioningArgs("individual", "Ignored")).toEqual({
      workspaceKind: "personal",
    });
  });

  it("maps company onboarding to a trimmed organization name", () => {
    expect(onboardingWorkspaceProvisioningArgs("company", "  Spirit Devs  ")).toEqual({
      workspaceKind: "organization",
      workspaceName: "Spirit Devs",
    });
  });
});

describe("onboardingProvisioningErrorMessage", () => {
  it("provides actionable rollout and connection messages", () => {
    expect(
      onboardingProvisioningErrorMessage(
        new Error("ArgumentValidationError: Object contains extra field workspaceKind"),
      ),
    ).toBe("Pathway Cloud is still updating. Wait a moment, then try again.");
    expect(onboardingProvisioningErrorMessage(new TypeError("Network request failed"))).toBe(
      "We could not reach Pathway Cloud. Check your connection and try again.",
    );
  });
});

describe("hasUsableOnboardingWorkspace", () => {
  it("returns false only after Convex confirms the workspace catalog is empty", async () => {
    const setAuth = vi.fn();
    const query = vi
      .fn<() => Promise<ReadonlyArray<unknown>>>()
      .mockResolvedValueOnce([{ workspaceKind: "organization" }])
      .mockResolvedValueOnce([]);
    const client = { setAuth, query };

    await expect(
      hasUsableOnboardingWorkspace({
        convexUrl: "https://example.convex.cloud",
        fetchToken: async () => "convex-token",
        client,
      }),
    ).resolves.toBe(true);
    await expect(
      hasUsableOnboardingWorkspace({
        convexUrl: "https://example.convex.cloud",
        fetchToken: async () => "convex-token",
        client,
      }),
    ).resolves.toBe(false);

    expect(setAuth).toHaveBeenCalledWith("convex-token");
    expect(query).toHaveBeenCalledWith(expect.anything(), {});
  });
});

describe("provisionOnboardingWorkspace", () => {
  it("authenticates and sends the selected workspace to Convex", async () => {
    const setAuth = vi.fn();
    const mutation = vi.fn(async () => null);
    await provisionOnboardingWorkspace({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "convex-token",
      args: { workspaceKind: "personal" },
      client: { setAuth, mutation },
    });

    expect(setAuth).toHaveBeenCalledWith("convex-token");
    expect(mutation).toHaveBeenCalledWith(expect.anything(), { workspaceKind: "personal" });
  });

  it("does not call Convex when Clerk cannot mint a token", async () => {
    const mutation = vi.fn();
    await expect(
      provisionOnboardingWorkspace({
        convexUrl: "https://example.convex.cloud",
        fetchToken: async () => null,
        args: { workspaceKind: "personal" },
        client: { setAuth: vi.fn(), mutation },
      }),
    ).rejects.toThrow("signed-in Convex session");
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe("completeOnboardingAfterWorkspaceProvision", () => {
  it("writes the completion marker only after provisioning succeeds", async () => {
    const calls: Array<string> = [];
    await completeOnboardingAfterWorkspaceProvision({
      provisionWorkspace: async () => {
        calls.push("provision");
      },
      persistCompletedProfile: async () => {
        calls.push("persist");
      },
    });
    expect(calls).toEqual(["provision", "persist"]);
  });

  it("preserves resumable onboarding when provisioning fails", async () => {
    const persistCompletedProfile = vi.fn();
    await expect(
      completeOnboardingAfterWorkspaceProvision({
        provisionWorkspace: async () => {
          throw new Error("offline");
        },
        persistCompletedProfile,
      }),
    ).rejects.toThrow("offline");
    expect(persistCompletedProfile).not.toHaveBeenCalled();
  });
});
