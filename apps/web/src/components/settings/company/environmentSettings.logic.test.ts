import type { EnvironmentRegistrationEntity, TeamEntity } from "@spiritdevs/client-runtime/sync";
import { RelayConnectionTarget } from "@spiritdevs/client-runtime/connection";
import { ThreadId, type EnvironmentId } from "@spiritdevs/contracts";
import { TeamId } from "@spiritdevs/contracts/company";
import {
  EnvironmentCommandId,
  EnvironmentRegistrationId,
} from "@spiritdevs/contracts/cloudProject";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentCommandRecord } from "../../../cloud/environmentControl";
import {
  deriveEnvironmentRows,
  deriveRecentEnvironmentCommands,
  environmentCommandSummary,
  environmentRegistrationsFromReplicaValues,
} from "./environmentSettings.logic";

const OWN_ID = "environment-own" as EnvironmentId;
const REMOTE_ID = "environment-remote" as EnvironmentId;
const TEAM_ID = TeamId.make("team-platform");

function registration(
  environmentId: EnvironmentId,
  overrides: Partial<EnvironmentRegistrationEntity> = {},
): EnvironmentRegistrationEntity {
  return {
    entityKind: "environmentRegistration",
    id: EnvironmentRegistrationId.make(`registration-${environmentId}`),
    environmentId,
    publicKeyThumbprint: "thumbprint",
    descriptor: {
      environmentId,
      label: environmentId === OWN_ID ? "This Mac" : "Build server",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.2.3",
      capabilities: { repositoryIdentity: false },
    },
    relayLinkState: "linked",
    managedEndpointAvailable: true,
    lastSeenAt: environmentId === OWN_ID ? 100 : 200,
    serviceRoleIds: [],
    teamIds: environmentId === REMOTE_ID ? [TEAM_ID] : [],
    state: "active",
    registeredByMembershipId: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function command(
  id: string,
  createdAt: number,
  overrides: Partial<EnvironmentCommandRecord> = {},
): EnvironmentCommandRecord {
  return {
    id: EnvironmentCommandId.make(id),
    targetEnvironmentId: REMOTE_ID,
    cloudProjectId: null,
    bindingId: null,
    kind: "interrupt",
    args: { kind: "interrupt", threadId: "thread-1" },
    issuedByMembershipId: "membership-1",
    onBehalfOfActor: { kind: "member", membershipId: "membership-1" },
    state: "pending",
    claimedByEnvironmentId: null,
    claimGeneration: 0,
    claimExpiresAt: null,
    expiresAt: 1_000,
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as EnvironmentCommandRecord;
}

describe("environment settings derivation", () => {
  it("extracts registrations and joins catalog, own-device, and team metadata", () => {
    const own = registration(OWN_ID);
    const remote = registration(REMOTE_ID);
    const catalog = new Map([
      [
        REMOTE_ID,
        {
          source: "companyRegistry" as const,
          target: new RelayConnectionTarget({ environmentId: REMOTE_ID, label: "Build server" }),
          profile: Option.none(),
          freshness: { lastSeenAt: 200 },
        },
      ],
    ]);
    const teams = [
      {
        entityKind: "team",
        id: TEAM_ID,
        name: "Platform",
        description: "",
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
      } as TeamEntity,
    ];

    expect(environmentRegistrationsFromReplicaValues([{}, remote, own])).toEqual([remote, own]);
    expect(
      deriveEnvironmentRows({
        registrations: [remote, own],
        catalogEntries: catalog,
        teams,
        ownEnvironmentId: OWN_ID,
      }),
    ).toEqual([
      expect.objectContaining({ environmentId: OWN_ID, isOwnEnvironment: true }),
      expect.objectContaining({
        environmentId: REMOTE_ID,
        isInCatalog: true,
        catalogSource: "companyRegistry",
        teamNames: ["Platform"],
      }),
    ]);
  });

  it("filters and orders recent commands newest first", () => {
    const otherId = "environment-other" as EnvironmentId;
    expect(
      deriveRecentEnvironmentCommands(
        [
          command("old", 1),
          command("new", 3),
          command("other", 4, { targetEnvironmentId: otherId }),
        ],
        REMOTE_ID,
        1,
      ).map((entry) => entry.id),
    ).toEqual([EnvironmentCommandId.make("new")]);
  });

  it("summarizes pending, failed, and successful command outcomes", () => {
    expect(environmentCommandSummary(command("pending", 1))).toBe(
      "Waiting for the environment to claim it",
    );
    expect(
      environmentCommandSummary(command("failed", 2, { state: "failed", error: "No thread" })),
    ).toBe("No thread");
    expect(
      environmentCommandSummary(
        command("success", 3, {
          state: "succeeded",
          result: {
            kind: "statusQuery",
            threadId: ThreadId.make("thread-1"),
            sessionStatus: "idle",
            activeTurnId: null,
          },
        }),
      ),
    ).toBe("Thread is idle");
  });
});
