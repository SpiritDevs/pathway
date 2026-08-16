import type { EnvironmentRegistrationEntity } from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { EnvironmentRegistrationId } from "@spiritdevs/contracts/cloudProject";
import { describe, expect, it } from "vite-plus/test";

import { shouldReleaseDisconnectedCloudProject } from "./projectRemoval.logic";

const ENVIRONMENT_ID = "environment-old" as EnvironmentId;

function registration(state: "active" | "revoked"): EnvironmentRegistrationEntity {
  return {
    entityKind: "environmentRegistration",
    id: EnvironmentRegistrationId.make("registration-old"),
    environmentId: ENVIRONMENT_ID,
    publicKeyThumbprint: "thumbprint",
    descriptor: {
      environmentId: ENVIRONMENT_ID,
      label: "Old Mac",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    },
    relayLinkState: state === "active" ? "linked" : "revoked",
    managedEndpointAvailable: state === "active",
    lastSeenAt: 1,
    serviceRoleIds: [],
    teamIds: [],
    state,
    registeredByMembershipId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("disconnected cloud project removal", () => {
  it("releases a stale binding after its environment registration is gone", () => {
    expect(
      shouldReleaseDisconnectedCloudProject({
        errorMessage: "Old Mac is not connected.",
        environmentId: ENVIRONMENT_ID,
        registrations: [],
      }),
    ).toBe(true);
  });

  it("does not detach a project from an environment that is only temporarily offline", () => {
    expect(
      shouldReleaseDisconnectedCloudProject({
        errorMessage: "Old Mac is not connected.",
        environmentId: ENVIRONMENT_ID,
        registrations: [registration("active")],
      }),
    ).toBe(false);
  });

  it("does not hide a real project deletion error behind the cloud fallback", () => {
    expect(
      shouldReleaseDisconnectedCloudProject({
        errorMessage: "Project has active threads.",
        environmentId: ENVIRONMENT_ID,
        registrations: [registration("revoked")],
      }),
    ).toBe(false);
  });
});
