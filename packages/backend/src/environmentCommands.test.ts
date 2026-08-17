// @effect-diagnostics globalDate:off -- Fixtures and lease transitions use Convex epoch milliseconds.
/** End-to-end remote command authorization, leasing, feed, expiry, and bootstrap coverage. */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.example.test";
const CLERK_ISSUER = "https://clerk.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/environmentCommands.ts": () => import("../convex/environmentCommands.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const COMPANY_ID = "01990000-0000-7000-8000-000000000001";
const MANAGER_MEMBERSHIP_ID = "01990000-0000-7000-8000-000000000101";
const DISPATCHER_MEMBERSHIP_ID = "01990000-0000-7000-8000-000000000102";
const MANAGER_ROLE_ID = "01990000-0000-7000-8000-000000000201";
const DISPATCHER_ROLE_ID = "01990000-0000-7000-8000-000000000202";
const ENVIRONMENT_ONE = "command-environment-one";
const ENVIRONMENT_TWO = "command-environment-two";
const REVOKED_ENVIRONMENT = "command-environment-revoked";
const REGISTRATION_ONE_ID = "01990000-0000-7000-8000-000000000301";
const REGISTRATION_TWO_ID = "01990000-0000-7000-8000-000000000302";
const REGISTRATION_REVOKED_ID = "01990000-0000-7000-8000-000000000303";
const THUMBPRINT_ONE = "command-thumbprint-one";
const THUMBPRINT_TWO = "command-thumbprint-two";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asMember(t: Harness, subject: "manager" | "dispatcher") {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email: `${subject}@example.test`,
  });
}

function asEnvironment(t: Harness, environmentId = ENVIRONMENT_ONE) {
  const thumbprint = environmentId === ENVIRONMENT_ONE ? THUMBPRINT_ONE : THUMBPRINT_TWO;
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: environmentId,
    tokenIdentifier: `${RELAY_ISSUER}|${environmentId}`,
    cnf: { jkt: thumbprint },
  });
}

interface Seeded {
  readonly companyDocId: Id<"companies">;
}

async function seed(t: Harness): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Environment Command Co",
      issueKeyPrefix: "CMD",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const addMember = async (
      subject: "manager" | "dispatcher",
      membershipId: string,
      roleId: string,
      permissions: string[],
    ) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipDocId = await ctx.db.insert("memberships", {
        id: membershipId,
        companyId: companyDocId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const roleDocId = await ctx.db.insert("roles", {
        id: roleId,
        companyId: companyDocId,
        name: `${subject} role`,
        description: "",
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${membershipId}-assignment`,
        companyId: companyDocId,
        membershipId: membershipDocId,
        roleId: roleDocId,
        scope: "company",
        teamId: null,
        createdAt: now,
      });
    };

    await addMember("manager", MANAGER_MEMBERSHIP_ID, MANAGER_ROLE_ID, [
      "remoteAgents.dispatch",
      "remoteAgents.control",
      "environments.read",
      "environments.manage",
    ]);
    await addMember("dispatcher", DISPATCHER_MEMBERSHIP_ID, DISPATCHER_ROLE_ID, [
      "remoteAgents.dispatch",
      "environments.read",
    ]);

    const addRegistration = async (
      id: string,
      environmentId: string,
      thumbprint: string,
      state: "active" | "revoked",
    ) => {
      await ctx.db.insert("environmentRegistrations", {
        id,
        companyId: companyDocId,
        environmentId,
        publicKeyThumbprint: thumbprint,
        descriptor: {
          environmentId,
          label: environmentId,
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "1.0.0",
          capabilities: { repositoryIdentity: true },
        },
        relayLinkState: state === "active" ? "linked" : "revoked",
        managedEndpointAvailable: true,
        lastSeenAt: now,
        serviceRoleIds: [],
        teamIds: [],
        state,
        registeredByMembershipId: null,
        createdAt: now,
        updatedAt: now,
      });
    };
    await addRegistration(REGISTRATION_ONE_ID, ENVIRONMENT_ONE, THUMBPRINT_ONE, "active");
    await addRegistration(REGISTRATION_TWO_ID, ENVIRONMENT_TWO, THUMBPRINT_TWO, "active");
    await addRegistration(
      REGISTRATION_REVOKED_ID,
      REVOKED_ENVIRONMENT,
      "command-thumbprint-revoked",
      "revoked",
    );
    return { companyDocId };
  });
}

function sendMessageArgs(message = "Run the command") {
  return { kind: "sendMessage" as const, threadId: "thread-one", message };
}

async function issue(
  t: Harness,
  id: string,
  targetEnvironmentId = ENVIRONMENT_ONE,
  ttlMs = 60_000,
) {
  return await asMember(t, "manager").mutation(api.environmentCommands.issue, {
    companyId: COMPANY_ID,
    id,
    targetEnvironmentId,
    cloudProjectId: null,
    kind: "sendMessage",
    args: sendMessageArgs(),
    ttlMs,
  });
}

async function feedRows(t: Harness) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("syncChanges").collect()).slice().sort((a, b) => a.version - b.version),
  );
}

interface BootstrapPage {
  readonly entities: { entityKind: string; entityId: string; payload: unknown }[];
  readonly cursor: string | null;
  readonly isDone: boolean;
}

describe("environment commands", () => {
  it("issues a pending feed row and enforces command permission, argument kind, and active target", async () => {
    const t = harness();
    await seed(t);
    const commandId = "01990000-0000-7000-8000-000000001001";

    await expect(issue(t, commandId)).resolves.toBeNull();
    await expect(
      asMember(t, "manager").query(api.environmentCommands.list, {
        companyId: COMPANY_ID,
        state: "pending",
      }),
    ).resolves.toMatchObject([
      {
        id: commandId,
        kind: "sendMessage",
        state: "pending",
        targetEnvironmentId: ENVIRONMENT_ONE,
        issuedByMembershipId: MANAGER_MEMBERSHIP_ID,
        onBehalfOfActor: { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID },
        claimGeneration: 0,
        claimExpiresAt: null,
      },
    ]);
    expect(await feedRows(t)).toMatchObject([
      {
        version: 1,
        entityKind: "environmentCommand",
        entityId: commandId,
        changeKind: "upsert",
        payload: {
          id: commandId,
          state: "pending",
          args: sendMessageArgs(),
          claimExpiresAt: null,
        },
      },
    ]);

    await expect(
      asMember(t, "dispatcher").mutation(api.environmentCommands.issue, {
        companyId: COMPANY_ID,
        id: "01990000-0000-7000-8000-000000001002",
        targetEnvironmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        kind: "sendMessage",
        args: sendMessageArgs(),
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("Missing permission remoteAgents.control");
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.issue, {
        companyId: COMPANY_ID,
        id: "01990000-0000-7000-8000-000000001003",
        targetEnvironmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        kind: "interrupt",
        args: sendMessageArgs(),
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("kind must match");
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.issue, {
        companyId: COMPANY_ID,
        id: "01990000-0000-7000-8000-000000001004",
        targetEnvironmentId: REVOKED_ENVIRONMENT,
        cloudProjectId: null,
        kind: "sendMessage",
        args: sendMessageArgs(),
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("not actively registered");
  });

  it("makes an identical command idempotent and refuses a conflicting reuse", async () => {
    const t = harness();
    await seed(t);
    const commandId = "01990000-0000-7000-8000-000000001101";
    await issue(t, commandId);
    await expect(issue(t, commandId)).resolves.toBeNull();
    expect(await feedRows(t)).toHaveLength(1);

    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.issue, {
        companyId: COMPANY_ID,
        id: commandId,
        targetEnvironmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        kind: "sendMessage",
        args: sendMessageArgs("A different command"),
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("different environment command already uses this id");
  });

  it("claims only the caller's target, returns live retries unchanged, and fences a reclaimed lease", async () => {
    const t = harness();
    const seeded = await seed(t);
    const ownId = "01990000-0000-7000-8000-000000001201";
    const otherId = "01990000-0000-7000-8000-000000001202";
    await issue(t, ownId, ENVIRONMENT_ONE);
    await issue(t, otherId, ENVIRONMENT_TWO);

    const first = await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
      claimTtlMs: 600_000,
    });
    expect(first).toMatchObject([{ id: ownId, state: "claimed", claimGeneration: 1 }]);
    const rowsAfterFirst = await feedRows(t);
    expect(rowsAfterFirst).toHaveLength(3);

    const retry = await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
      claimTtlMs: 600_000,
    });
    expect(retry).toMatchObject([{ id: ownId, claimGeneration: 1 }]);
    expect(await feedRows(t)).toHaveLength(3);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("environmentCommands")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", seeded.companyDocId).eq("id", ownId),
        )
        .unique();
      if (row === null) throw new Error("claim the command first");
      await ctx.db.patch(row._id, { claimExpiresAt: Date.now() - 1 });
    });
    const reclaimed = await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
    });
    expect(reclaimed).toMatchObject([{ id: ownId, claimGeneration: 2 }]);
    expect(await feedRows(t)).toHaveLength(4);

    const otherPending = await asMember(t, "manager").query(api.environmentCommands.list, {
      companyId: COMPANY_ID,
      state: "pending",
    });
    expect(otherPending).toMatchObject([{ id: otherId, targetEnvironmentId: ENVIRONMENT_TWO }]);
  });

  it("refuses stale renewals and reports only the live generation to a terminal feed row", async () => {
    const t = harness();
    await seed(t);
    const commandId = "01990000-0000-7000-8000-000000001301";
    await issue(t, commandId);
    const [claimed] = await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
      claimTtlMs: 600_000,
    });
    if (claimed === undefined) throw new Error("expected one claim");

    await expect(
      asEnvironment(t).mutation(api.environmentCommands.renewClaim, {
        companyId: COMPANY_ID,
        commandId,
        claimGeneration: claimed.claimGeneration - 1,
      }),
    ).rejects.toThrow("claim generation is stale");
    await expect(
      asEnvironment(t).mutation(api.environmentCommands.reportStatus, {
        companyId: COMPANY_ID,
        commandId,
        claimGeneration: claimed.claimGeneration - 1,
        state: "succeeded",
        result: { kind: "sendMessage", threadId: "thread-one", turnId: "turn-one" },
        error: null,
      }),
    ).rejects.toThrow("claim generation is stale");

    const feedBeforeRenew = await feedRows(t);
    await expect(
      asEnvironment(t).mutation(api.environmentCommands.renewClaim, {
        companyId: COMPANY_ID,
        commandId,
        claimGeneration: claimed.claimGeneration,
        claimTtlMs: 600_000,
      }),
    ).resolves.toBeNull();
    expect(await feedRows(t)).toHaveLength(feedBeforeRenew.length);

    await expect(
      asEnvironment(t).mutation(api.environmentCommands.reportStatus, {
        companyId: COMPANY_ID,
        commandId,
        claimGeneration: claimed.claimGeneration,
        state: "succeeded",
        result: { kind: "sendMessage", threadId: "thread-one", turnId: "turn-one" },
        error: null,
      }),
    ).resolves.toBeNull();
    const terminal = await asMember(t, "manager").query(api.environmentCommands.list, {
      companyId: COMPANY_ID,
      state: "succeeded",
    });
    expect(terminal).toMatchObject([
      {
        id: commandId,
        claimGeneration: claimed.claimGeneration,
        claimExpiresAt: null,
        result: { kind: "sendMessage", turnId: "turn-one" },
      },
    ]);
    expect((await feedRows(t)).at(-1)).toMatchObject({
      entityKind: "environmentCommand",
      entityId: commandId,
      payload: { state: "succeeded", claimExpiresAt: null },
    });
  });

  it("cancels only pending commands and treats a repeated cancellation as a no-op", async () => {
    const t = harness();
    await seed(t);
    const pendingId = "01990000-0000-7000-8000-000000001401";
    await issue(t, pendingId);
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.cancel, {
        companyId: COMPANY_ID,
        commandId: pendingId,
      }),
    ).resolves.toBeNull();
    const afterCancel = await feedRows(t);
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.cancel, {
        companyId: COMPANY_ID,
        commandId: pendingId,
      }),
    ).resolves.toBeNull();
    expect(await feedRows(t)).toHaveLength(afterCancel.length);

    const claimedId = "01990000-0000-7000-8000-000000001402";
    await issue(t, claimedId);
    await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
      limit: 1,
    });
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.cancel, {
        companyId: COMPANY_ID,
        commandId: claimedId,
      }),
    ).rejects.toThrow("Only a pending command may be canceled");
  });

  it("expires pending and claimed commands and publishes every recorded outcome", async () => {
    const t = harness();
    const seeded = await seed(t);
    const pendingId = "01990000-0000-7000-8000-000000001501";
    const claimedId = "01990000-0000-7000-8000-000000001502";
    await issue(t, pendingId);
    await issue(t, claimedId);
    await asEnvironment(t).mutation(api.environmentCommands.claim, {
      companyId: COMPANY_ID,
      limit: 1,
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("environmentCommands")
        .withIndex("by_company", (q) => q.eq("companyId", seeded.companyDocId))
        .collect();
      for (const row of rows) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    const feedBefore = await feedRows(t);
    await expect(
      asMember(t, "manager").mutation(api.environmentCommands.expireOverdue, {
        companyId: COMPANY_ID,
      }),
    ).resolves.toEqual({ expired: 2 });
    const expired = await asMember(t, "manager").query(api.environmentCommands.list, {
      companyId: COMPANY_ID,
      state: "expired",
    });
    expect(expired.map((row) => row.id).sort()).toEqual([claimedId, pendingId].sort());
    expect((await feedRows(t)).slice(feedBefore.length)).toHaveLength(2);
    expect((await feedRows(t)).slice(feedBefore.length)).toMatchObject([
      { entityKind: "environmentCommand", payload: { state: "expired" } },
      { entityKind: "environmentCommand", payload: { state: "expired" } },
    ]);
  });

  it("includes environment command history at the tail of a bootstrap walk", async () => {
    const t = harness();
    await seed(t);
    const commandId = "01990000-0000-7000-8000-000000001601";
    await issue(t, commandId);

    let cursor: string | null = null;
    const entities: { entityKind: string; entityId: string; payload: unknown }[] = [];
    for (let guard = 0; guard < 100; guard += 1) {
      const page: BootstrapPage = await asMember(t, "manager").query(api.sync.bootstrap, {
        companyId: COMPANY_ID,
        cursor,
        pageSize: 1,
      });
      entities.push(...page.entities);
      if (page.isDone) break;
      cursor = page.cursor;
    }
    expect(entities.at(-1)).toMatchObject({
      entityKind: "environmentCommand",
      entityId: commandId,
      payload: {
        id: commandId,
        state: "pending",
        issuedByMembershipId: MANAGER_MEMBERSHIP_ID,
        onBehalfOfActor: { kind: "member", membershipId: MANAGER_MEMBERSHIP_ID },
      },
    });
  });
});
