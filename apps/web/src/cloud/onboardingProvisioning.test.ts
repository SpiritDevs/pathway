import { describe, expect, it, vi } from "vite-plus/test";

import {
  completeOnboardingAfterWorkspaceProvision,
  hasUsableOnboardingWorkspace,
  onboardingProvisioningErrorMessage,
  onboardingWorkspaceProvisioningArgs,
  provisionOnboardingWorkspace,
} from "./onboardingProvisioning";

describe("onboardingWorkspaceProvisioningArgs", () => {
  it("provisions individual accounts as personal workspaces", () => {
    expect(onboardingWorkspaceProvisioningArgs("individual", "Ignored Company")).toEqual({
      workspaceKind: "personal",
    });
  });

  it("provisions company accounts as named organization workspaces", () => {
    expect(onboardingWorkspaceProvisioningArgs("company", "  Spirit Devs  ")).toEqual({
      workspaceKind: "organization",
      workspaceName: "Spirit Devs",
    });
  });

  it("lets the backend choose the fallback name for an unnamed organization", () => {
    expect(onboardingWorkspaceProvisioningArgs("company", "   ")).toEqual({
      workspaceKind: "organization",
    });
  });
});

describe("onboardingProvisioningErrorMessage", () => {
  it("explains a client/backend rollout mismatch", () => {
    expect(
      onboardingProvisioningErrorMessage(
        new Error("ArgumentValidationError: Object contains extra field workspaceKind"),
      ),
    ).toBe("Pathway Cloud is still updating. Wait a moment, then try again.");
  });

  it("distinguishes a network failure from an unknown failure", () => {
    expect(onboardingProvisioningErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "We could not reach Pathway Cloud. Check your connection and try again.",
    );
    expect(onboardingProvisioningErrorMessage(new Error("unexpected"))).toBe(
      "We could not create your workspace. Try again.",
    );
  });
});

describe("hasUsableOnboardingWorkspace", () => {
  it("distinguishes an existing workspace from a completed account with none", async () => {
    const setAuth = vi.fn();
    const query = vi
      .fn<() => Promise<ReadonlyArray<unknown>>>()
      .mockResolvedValueOnce([{ workspaceKind: "personal" }])
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

  it("does not interpret an authentication failure as a missing workspace", async () => {
    const query = vi.fn();
    await expect(
      hasUsableOnboardingWorkspace({
        convexUrl: "https://example.convex.cloud",
        fetchToken: async () => null,
        client: { setAuth: vi.fn(), query },
      }),
    ).rejects.toThrow("validate a workspace");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("provisionOnboardingWorkspace", () => {
  it("authenticates one HTTP client and sends the selected workspace details", async () => {
    const setAuth = vi.fn();
    const mutation = vi.fn(async () => ({ id: "workspace-1" }));

    await provisionOnboardingWorkspace({
      convexUrl: "https://example.convex.cloud",
      fetchToken: async () => "convex-token",
      args: { workspaceKind: "organization", workspaceName: "Spirit Devs" },
      client: { setAuth, mutation },
    });

    expect(setAuth).toHaveBeenCalledWith("convex-token");
    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      workspaceKind: "organization",
      workspaceName: "Spirit Devs",
    });
  });

  it("does not contact Convex without a signed-in token", async () => {
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
  it("provisions, persists completion, then leaves onboarding", async () => {
    const calls: Array<string> = [];

    await completeOnboardingAfterWorkspaceProvision({
      provisionWorkspace: async () => {
        calls.push("provision");
      },
      persistCompletedProfile: async () => {
        calls.push("persist");
      },
      navigateHome: async () => {
        calls.push("navigate");
      },
    });

    expect(calls).toEqual(["provision", "persist", "navigate"]);
  });

  it("keeps onboarding incomplete when workspace provisioning fails", async () => {
    const persistCompletedProfile = vi.fn();
    const navigateHome = vi.fn();

    await expect(
      completeOnboardingAfterWorkspaceProvision({
        provisionWorkspace: async () => {
          throw new Error("Convex unavailable");
        },
        persistCompletedProfile,
        navigateHome,
      }),
    ).rejects.toThrow("Convex unavailable");

    expect(persistCompletedProfile).not.toHaveBeenCalled();
    expect(navigateHome).not.toHaveBeenCalled();
  });
});
