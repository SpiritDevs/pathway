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
  completeRemoteRelayAvailability,
  deleteConfirmationSecondsRemaining,
  derivePathwayConnectStatus,
  deriveEnvironmentRows,
  deriveRecentEnvironmentCommands,
  environmentCommandSummary,
  environmentRegistrationsFromReplicaValues,
  partitionCompanyEnvironmentRowsByConnection,
  remoteCommandDeliveryCopy,
  resolveDeleteConfirmationClick,
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
  it("derives Pathway Connect status from live state for this device", () => {
    const row = deriveEnvironmentRows({
      registrations: [registration(OWN_ID)],
      catalogEntries: new Map(),
      teams: [],
      ownEnvironmentId: OWN_ID,
    })[0]!;

    expect(
      derivePathwayConnectStatus({
        row,
        ownCloudLinkPhase: "connected",
        ownManagedEndpointAvailable: true,
        ownCloudLinkError: null,
      }),
    ).toBe("active");
    expect(
      derivePathwayConnectStatus({
        row,
        ownCloudLinkPhase: "waiting",
        ownManagedEndpointAvailable: false,
        ownCloudLinkError: null,
      }),
    ).toBe("connecting");
    expect(
      derivePathwayConnectStatus({
        row,
        ownCloudLinkPhase: "exhausted",
        ownManagedEndpointAvailable: false,
        ownCloudLinkError: "Relay unavailable",
      }),
    ).toBe("failed");
  });

  it("derives Pathway Connect status for remote registrations", () => {
    const derive = (overrides: Partial<EnvironmentRegistrationEntity>) => {
      const row = deriveEnvironmentRows({
        registrations: [registration(REMOTE_ID, overrides)],
        catalogEntries: new Map(),
        teams: [],
        ownEnvironmentId: OWN_ID,
      })[0]!;
      return derivePathwayConnectStatus({
        row,
        ownCloudLinkPhase: "idle",
        ownManagedEndpointAvailable: null,
        ownCloudLinkError: null,
        remoteRelayAvailability: "online",
      });
    };

    expect(derive({ managedEndpointAvailable: true })).toBe("active");
    expect(derive({ managedEndpointAvailable: false })).toBe("connecting");
    expect(derive({ relayLinkState: "unlinked" })).toBe("failed");
    expect(derive({ state: "revoked" })).toBe("failed");
  });

  it("uses live relay health instead of configured tunnel state for remote presence", () => {
    const row = deriveEnvironmentRows({
      registrations: [registration(REMOTE_ID)],
      catalogEntries: new Map(),
      teams: [],
      ownEnvironmentId: OWN_ID,
    })[0]!;
    const derive = (remoteRelayAvailability: "online" | "offline" | "checking" | "error") =>
      derivePathwayConnectStatus({
        row,
        ownCloudLinkPhase: "idle",
        ownManagedEndpointAvailable: null,
        ownCloudLinkError: null,
        remoteRelayAvailability,
      });

    expect(derive("online")).toBe("active");
    expect(derive("offline")).toBe("failed");
    expect(derive("error")).toBe("failed");
    expect(derive("checking")).toBe("connecting");
  });

  it("does not treat an omitted remote relay result as active", () => {
    const rows = deriveEnvironmentRows({
      registrations: [registration(OWN_ID), registration(REMOTE_ID)],
      catalogEntries: new Map(),
      teams: [],
      ownEnvironmentId: OWN_ID,
    });

    expect(
      completeRemoteRelayAvailability({ rows, reported: new Map(), refreshing: true }).get(
        REMOTE_ID,
      ),
    ).toBe("checking");
    expect(
      completeRemoteRelayAvailability({ rows, reported: new Map(), refreshing: false }).get(
        REMOTE_ID,
      ),
    ).toBe("offline");
    expect(
      completeRemoteRelayAvailability({
        rows,
        reported: new Map([[REMOTE_ID, "online"]]),
        refreshing: false,
      }).get(REMOTE_ID),
    ).toBe("online");
  });

  it("groups company environments by the Pathway Connect state shown on their rows", () => {
    const offlineId = "environment-offline" as EnvironmentId;
    const rows = deriveEnvironmentRows({
      registrations: [
        registration(REMOTE_ID, { managedEndpointAvailable: true }),
        registration(offlineId, { managedEndpointAvailable: false }),
      ],
      catalogEntries: new Map(),
      teams: [],
      ownEnvironmentId: OWN_ID,
    });

    const partitioned = partitionCompanyEnvironmentRowsByConnection({
      rows,
      ownCloudLinkPhase: "idle",
      ownManagedEndpointAvailable: null,
      ownCloudLinkError: null,
      remoteRelayAvailability: new Map([
        [REMOTE_ID, "online"],
        [offlineId, "offline"],
      ]),
    });

    expect(partitioned.connected.map((row) => row.environmentId)).toEqual([REMOTE_ID]);
    expect(partitioned.disconnected.map((row) => row.environmentId)).toEqual([offlineId]);
  });

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

  it("distinguishes immediate command delivery from an offline queue", () => {
    expect(remoteCommandDeliveryCopy("active", "Studio")).toEqual({
      description:
        "Studio is online. Commands are available to claim immediately and expire after 24 hours.",
      queueing: false,
    });
    expect(remoteCommandDeliveryCopy("failed", "Studio")).toEqual({
      description:
        "Studio is offline. Commands will queue until it reconnects and expire after 24 hours.",
      queueing: true,
    });
    expect(remoteCommandDeliveryCopy("connecting", "Studio")).toEqual({
      description:
        "Studio is being checked. Commands will queue until it is online and expire after 24 hours.",
      queueing: true,
    });
  });

  it("requires a second delete click within the five-second confirmation window", () => {
    const firstClick = resolveDeleteConfirmationClick(null, 10_000, 5_000);
    expect(firstClick).toEqual({ confirmed: false, armedUntil: 15_000 });
    expect(deleteConfirmationSecondsRemaining(firstClick.armedUntil, 10_001)).toBe(5);
    expect(deleteConfirmationSecondsRemaining(firstClick.armedUntil, 14_001)).toBe(1);

    expect(resolveDeleteConfirmationClick(firstClick.armedUntil, 14_999, 5_000)).toEqual({
      confirmed: true,
      armedUntil: null,
    });
    expect(resolveDeleteConfirmationClick(firstClick.armedUntil, 15_000, 5_000)).toEqual({
      confirmed: false,
      armedUntil: 20_000,
    });
  });
});
