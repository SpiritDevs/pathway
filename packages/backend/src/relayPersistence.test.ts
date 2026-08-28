import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import schema from "../convex/schema.ts";
import { api } from "./convexApi.ts";

const RELAY_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/relayPersistence.ts": () => import("../convex/relayPersistence.ts"),
};

function testRelay() {
  const t = convexTest(schema, modules);
  return {
    t,
    relay: t.withIdentity({
      issuer: RELAY_ISSUER,
      subject: "pathway-relay",
      tokenIdentifier: `${RELAY_ISSUER}|pathway-relay`,
      tokenKind: "relay-control-plane",
    }),
  };
}

const reserve = (environmentId: string, now = "2026-08-14T00:00:00.000Z") => ({
  userId: "user-1",
  environmentId,
  hostname: `${environmentId}.example.test`,
  tunnelName: `tunnel-${environmentId}`,
  now,
});

const replaceLink = (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly deviceId: string | null;
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly now: string;
}) => ({
  userId: input.userId,
  environmentId: input.environmentId,
  environmentLabel: "Studio",
  environmentPublicKey: input.environmentPublicKey,
  endpointHttpBaseUrl: "https://environment.example.test",
  endpointWsBaseUrl: "wss://environment.example.test",
  endpointProviderKind: "pathway_relay" as const,
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  managedTunnelsEnabled: true,
  createdByDeviceId: input.deviceId,
  credentialId: input.credentialId,
  credentialHash: input.credentialHash,
  now: input.now,
});

const activityState = (threadId: string, phase: "completed" | "failed" | "running") => ({
  environmentId: "environment-1",
  threadId,
  projectTitle: "Project",
  threadTitle: threadId,
  phase,
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "2026-08-14T00:00:00.000Z",
  deepLink: `pathway://threads/${threadId}`,
});

const deliveryAttempt = (id: string) => ({
  id,
  createdAt: "2026-08-14T00:00:00.000Z",
  userId: null,
  environmentId: null,
  threadId: null,
  deviceId: null,
  kind: "push_notification",
  sourceJobId: null,
  tokenSuffix: null,
  apnsStatus: null,
  apnsReason: null,
  apnsId: null,
  transportError: null,
});

describe("relayPersistence", () => {
  it("rejects ordinary identities and accepts only the relay control plane", async () => {
    const { t, relay } = testRelay();

    await expect(t.query(api.relayPersistence.health, {})).rejects.toThrow(
      "reserved for the relay control plane",
    );
    await expect(
      t
        .withIdentity({ issuer: RELAY_ISSUER, subject: "environment-1" })
        .query(api.relayPersistence.health, {}),
    ).rejects.toThrow("reserved for the relay control plane");
    await expect(relay.query(api.relayPersistence.health, {})).resolves.toBe(true);
  });

  it("counts in-flight allocations and enforces capacity in the reservation mutation", async () => {
    const { t, relay } = testRelay();
    await t.run((ctx) =>
      ctx.db.insert("relayManagedTunnelLimits", {
        userId: "user-1",
        maxTunnels: 1,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );

    const first = await relay.mutation(
      api.relayPersistence.reserveManagedEndpointAllocation,
      reserve("environment-1"),
    );
    expect(first.status).toBe("reserved");

    const duplicate = await relay.mutation(
      api.relayPersistence.reserveManagedEndpointAllocation,
      reserve("environment-1", "2026-08-14T00:01:00.000Z"),
    );
    expect(duplicate.status).toBe("reserved");

    const overLimit = await relay.mutation(
      api.relayPersistence.reserveManagedEndpointAllocation,
      reserve("environment-2"),
    );
    expect(overLimit).toEqual({ status: "limit_exceeded", maxTunnels: 1, activeTunnels: 1 });
  });

  it("keeps only the newest credential active without scanning revoked history", async () => {
    const { t, relay } = testRelay();
    await relay.mutation(api.relayPersistence.upsertEnvironmentLink, {
      userId: "user-1",
      environmentId: "environment-1",
      environmentLabel: "Studio",
      environmentPublicKey: "public-key-1",
      endpointHttpBaseUrl: "https://environment.example.test",
      endpointWsBaseUrl: "wss://environment.example.test",
      endpointProviderKind: "manual",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
      createdByDeviceId: null,
      now: "2026-08-14T00:00:00.000Z",
    });
    await relay.mutation(api.relayPersistence.insertEnvironmentCredential, {
      credentialId: "credential-1",
      environmentId: "environment-1",
      environmentPublicKey: "public-key-1",
      credentialHash: "hash-1",
      now: "2026-08-14T00:00:00.000Z",
    });
    await relay.mutation(api.relayPersistence.insertEnvironmentCredential, {
      credentialId: "credential-2",
      environmentId: "environment-1",
      environmentPublicKey: "public-key-1",
      credentialHash: "hash-2",
      now: "2026-08-14T00:01:00.000Z",
    });

    await expect(
      relay.query(api.relayPersistence.authenticateEnvironmentCredential, {
        credentialHash: "hash-1",
      }),
    ).resolves.toBeNull();
    await expect(
      relay.query(api.relayPersistence.authenticateEnvironmentCredential, {
        credentialHash: "hash-2",
      }),
    ).resolves.toMatchObject({ credentialId: "credential-2" });
    await expect(
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query("relayEnvironmentCredentials")
          .withIndex("by_environment_key_and_revoked", (q) =>
            q
              .eq("environmentId", "environment-1")
              .eq("environmentPublicKey", "public-key-1")
              .eq("revokedAt", null),
          )
          .collect();
        return rows.length;
      }),
    ).resolves.toBe(1);
  });

  it("moves a proven environment key to its new account and environment id", async () => {
    const { relay } = testRelay();
    await relay.mutation(
      api.relayPersistence.replaceEnvironmentLinkAndCredential,
      replaceLink({
        userId: "user-old",
        environmentId: "environment-old",
        environmentPublicKey: "stable-public-key",
        deviceId: null,
        credentialId: "credential-old",
        credentialHash: "hash-old",
        now: "2026-08-14T00:00:00.000Z",
      }),
    );
    await relay.mutation(
      api.relayPersistence.replaceEnvironmentLinkAndCredential,
      replaceLink({
        userId: "user-new",
        environmentId: "environment-new",
        environmentPublicKey: "stable-public-key",
        deviceId: "environment-new",
        credentialId: "credential-new",
        credentialHash: "hash-new",
        now: "2026-08-14T00:01:00.000Z",
      }),
    );

    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-old" }),
    ).resolves.toEqual([]);
    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-new" }),
    ).resolves.toMatchObject([{ environmentId: "environment-new" }]);
    await expect(
      relay.query(api.relayPersistence.authenticateEnvironmentCredential, {
        credentialHash: "hash-old",
      }),
    ).resolves.toBeNull();
  });

  it("replaces stale links for the same account and desktop host after userdata is rebuilt", async () => {
    const { relay } = testRelay();
    await relay.mutation(
      api.relayPersistence.replaceEnvironmentLinkAndCredential,
      replaceLink({
        userId: "user-1",
        environmentId: "environment-old",
        environmentPublicKey: "public-key-old",
        deviceId: "desktop-host-1",
        credentialId: "credential-old",
        credentialHash: "hash-old",
        now: "2026-08-14T00:00:00.000Z",
      }),
    );
    await relay.mutation(
      api.relayPersistence.replaceEnvironmentLinkAndCredential,
      replaceLink({
        userId: "user-1",
        environmentId: "environment-new",
        environmentPublicKey: "public-key-new",
        deviceId: "desktop-host-1",
        credentialId: "credential-new",
        credentialHash: "hash-new",
        now: "2026-08-14T00:01:00.000Z",
      }),
    );

    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-1" }),
    ).resolves.toMatchObject([{ environmentId: "environment-new" }]);
    await expect(
      relay.query(api.relayPersistence.authenticateEnvironmentCredential, {
        credentialHash: "hash-old",
      }),
    ).resolves.toBeNull();
  });

  it("lets an account rename any linked environment without a reconnect overwriting it", async () => {
    const { t, relay } = testRelay();
    const link = {
      userId: "user-1",
      environmentId: "environment-1",
      environmentLabel: "macOS-C02DN08X0KPF",
      environmentPublicKey: "public-key-1",
      endpointHttpBaseUrl: "https://environment.example.test",
      endpointWsBaseUrl: "wss://environment.example.test",
      endpointProviderKind: "pathway_relay" as const,
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
      createdByDeviceId: null,
      now: "2026-08-14T00:00:00.000Z",
    };
    await relay.mutation(api.relayPersistence.upsertEnvironmentLink, link);
    const user = t.withIdentity({
      issuer: "https://clerk.example.test",
      subject: "user-1",
      tokenIdentifier: "https://clerk.example.test|user-1",
    });

    await user.mutation(api.relayPersistence.renameEnvironmentLink, {
      environmentId: "environment-1",
      displayName: "Build laptop",
    });
    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-1" }),
    ).resolves.toMatchObject([{ label: "Build laptop" }]);

    await relay.mutation(api.relayPersistence.upsertEnvironmentLink, {
      ...link,
      environmentLabel: "Refreshed host name",
      now: "2026-08-14T00:01:00.000Z",
    });
    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-1" }),
    ).resolves.toMatchObject([{ label: "Build laptop" }]);

    await user.mutation(api.relayPersistence.renameEnvironmentLink, {
      environmentId: "environment-1",
      displayName: null,
    });
    await expect(
      relay.query(api.relayPersistence.listEnvironmentLinksForUser, { userId: "user-1" }),
    ).resolves.toMatchObject([{ label: "Refreshed host name" }]);
  });

  it("does not let one account rename another account's environment", async () => {
    const { t, relay } = testRelay();
    await relay.mutation(api.relayPersistence.upsertEnvironmentLink, {
      userId: "user-1",
      environmentId: "environment-1",
      environmentLabel: "Studio",
      environmentPublicKey: "public-key-1",
      endpointHttpBaseUrl: "https://environment.example.test",
      endpointWsBaseUrl: "wss://environment.example.test",
      endpointProviderKind: "manual",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
      createdByDeviceId: null,
      now: "2026-08-14T00:00:00.000Z",
    });

    await expect(
      t
        .withIdentity({
          issuer: "https://clerk.example.test",
          subject: "user-2",
          tokenIdentifier: "https://clerk.example.test|user-2",
        })
        .mutation(api.relayPersistence.renameEnvironmentLink, {
          environmentId: "environment-1",
          displayName: "Not mine",
        }),
    ).rejects.toThrow("not linked to your account");
  });

  it("removes only the unlinked account's Focus assignments for that environment", async () => {
    const { t, relay } = testRelay();
    await relay.mutation(api.relayPersistence.upsertEnvironmentLink, {
      userId: "user-1",
      environmentId: "environment-1",
      environmentLabel: "Studio",
      environmentPublicKey: "public-key-1",
      endpointHttpBaseUrl: "https://environment.example.test",
      endpointWsBaseUrl: "wss://environment.example.test",
      endpointProviderKind: "manual",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
      createdByDeviceId: null,
      now: "2026-08-14T00:00:00.000Z",
    });
    await t.run(async (ctx) => {
      const userOneId = await ctx.db.insert("users", {
        clerkSubject: "user-1",
        email: "user-1@example.test",
        displayName: "User One",
        imageUrl: null,
        createdAt: 1,
        updatedAt: 1,
      });
      const userTwoId = await ctx.db.insert("users", {
        clerkSubject: "user-2",
        email: "user-2@example.test",
        displayName: "User Two",
        imageUrl: null,
        createdAt: 1,
        updatedAt: 1,
      });
      const userOneFocusId = await ctx.db.insert("focuses", {
        id: "0198c0de-ffff-7fff-8fff-000000000001",
        userId: userOneId,
        name: "User One Focus",
        iconName: "Briefcase",
        accentColor: "#3366ff",
        orderKey: "a",
        createdAt: 1,
        updatedAt: 1,
      });
      const userTwoFocusId = await ctx.db.insert("focuses", {
        id: "0198c0de-ffff-7fff-8fff-000000000002",
        userId: userTwoId,
        name: "User Two Focus",
        iconName: "House",
        accentColor: "#ff6633",
        orderKey: "a",
        createdAt: 1,
        updatedAt: 1,
      });
      for (const [userId, focusId, projectKey] of [
        [userOneId, userOneFocusId, "environment-1:project-a"],
        [userOneId, userOneFocusId, "environment-1:project-b"],
        [userOneId, userOneFocusId, "environment-10:project-c"],
        [userOneId, userOneFocusId, "environment-2:project-d"],
        [userTwoId, userTwoFocusId, "environment-1:project-a"],
      ] as const) {
        await ctx.db.insert("focusAssignments", {
          userId,
          focusId,
          projectKey,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });

    await relay.mutation(api.relayPersistence.revokeEnvironmentLinkWithCredentials, {
      userId: "user-1",
      environmentId: "environment-1",
      now: "2026-08-14T00:01:00.000Z",
    });

    const assignments = await t.run(async (ctx) =>
      (await ctx.db.query("focusAssignments").collect())
        .map((assignment) => assignment.projectKey)
        .sort(),
    );
    expect(assignments).toEqual([
      "environment-10:project-c",
      "environment-1:project-a",
      "environment-2:project-d",
    ]);
  });

  it("prunes terminal rows even when older nonterminal rows fill the general time index", async () => {
    const { t, relay } = testRelay();
    await t.run(async (ctx) => {
      for (const state of [
        activityState("running-1", "running"),
        activityState("running-2", "running"),
        activityState("completed-1", "completed"),
      ]) {
        await ctx.db.insert("relayAgentActivityRows", {
          environmentId: state.environmentId,
          environmentPublicKey: "public-key-1",
          threadId: state.threadId,
          state,
          phase: state.phase,
          updatedAt: state.updatedAt,
          createdAt: state.updatedAt,
        });
      }
    });

    await expect(
      relay.mutation(api.relayPersistence.pruneTerminalAgentActivityRows, {
        updatedBefore: "2026-08-14T00:01:00.000Z",
        limit: 1,
      }),
    ).resolves.toBe(1);
    await expect(
      t.run(async (ctx) => (await ctx.db.query("relayAgentActivityRows").collect()).length),
    ).resolves.toBe(2);
  });

  it("preserves delivery-attempt id uniqueness", async () => {
    const { relay } = testRelay();
    await relay.mutation(api.relayPersistence.recordDeliveryAttempt, deliveryAttempt("attempt-1"));
    await expect(
      relay.mutation(api.relayPersistence.recordDeliveryAttempt, deliveryAttempt("attempt-1")),
    ).rejects.toThrow("Delivery attempt id already exists");
  });
});
