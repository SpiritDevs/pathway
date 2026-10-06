/**
 * Environment-issued, account-scoped connect grants for reading or messaging a thread elsewhere,
 * or starting one in a project elsewhere.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.ts";
import { hashConnectGrantToken } from "./connectGrants.ts";

const RELAY_ISSUER = "https://relay.example.test";
const CONNECT_GRANT_REFUSED = { status: "refused", code: "connect-grant-refused" } as const;
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/connectGrants.ts": () => import("../convex/connectGrants.ts"),
};

const CALLER = "env-caller";
const TARGET = "env-target";
const THREAD = "thread-elsewhere";
const PROJECT = "project-elsewhere";
const NOW = 1_700_000_000_000;

function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;

function asRelay(t: Harness) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: "pathway-relay",
    tokenIdentifier: `${RELAY_ISSUER}|pathway-relay`,
    tokenKind: "relay-control-plane",
  });
}

async function issueGrant(t: Harness, access: "read" | "send") {
  return await asEnvironment(t).action(api.connectGrants.issueThreadAccess, {
    threadId: THREAD,
    access,
  });
}

function asEnvironment(t: Harness, thumbprint = "thumb-caller") {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: CALLER,
    tokenIdentifier: `${RELAY_ISSUER}|${CALLER}`,
    cnf: { jkt: thumbprint },
  });
}

async function seed(
  t: Harness,
  targetPermissions: string[],
  options: {
    readonly linkedTo?: "owner" | "manager" | null;
    /** The target's `peerThreadGrants` capability; `"absent"` models a pre-capability server. */
    readonly targetReadGrants?: unknown;
  } = {},
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "owner",
      email: "owner@example.test",
      displayName: "Owner",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const company = async (key: string, permissions: string[]) => {
      const companyId = await ctx.db.insert("companies", {
        id: `0198fa00-0000-7000-8000-00000000000${key}`,
        name: `Company ${key}`,
        issueKeyPrefix: `C${key}`,
        nextIssueNumber: 1,
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        authorizationEpoch: 1,
        syncVersion: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: `0198fa00-0000-7000-8000-00000000010${key}`,
        companyId,
        userId,
        state: "active",
        displayNameSnapshot: "Owner",
        emailSnapshot: "owner@example.test",
        invitedByMembershipId: null,
        joinedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const roleId = await ctx.db.insert("roles", {
        id: `0198fa00-0000-7000-8000-00000000020${key}`,
        companyId,
        name: "Member",
        description: "",
        permissions,
        seeded: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("roleAssignments", {
        id: `0198fa00-0000-7000-8000-00000000030${key}`,
        companyId,
        membershipId,
        roleId,
        scope: "company",
        teamId: null,
        createdAt: NOW,
      });
      return { companyId, membershipId };
    };
    const register = async (
      key: string,
      companyId: Id<"companies">,
      environmentId: string,
      registeredByMembershipId: Id<"memberships">,
    ) =>
      await ctx.db.insert("environmentRegistrations", {
        id: `0198fa00-0000-7000-8000-00000000040${key}`,
        companyId,
        environmentId,
        publicKeyThumbprint: environmentId === CALLER ? "thumb-caller" : "thumb-target",
        descriptor: {
          environmentId,
          label: environmentId,
          capabilities:
            environmentId === TARGET && options.targetReadGrants !== "absent"
              ? { repositoryIdentity: true, peerThreadGrants: options.targetReadGrants ?? true }
              : { repositoryIdentity: true },
        },
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: NOW,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId,
        createdAt: NOW,
        updatedAt: NOW,
      });

    const linkedTo = options.linkedTo === undefined ? "owner" : options.linkedTo;
    if (linkedTo !== null)
      await ctx.db.insert("relayEnvironmentLinks", {
        userId: linkedTo,
        environmentId: CALLER,
        environmentLabel: CALLER,
        environmentPublicKey: "link-key-caller",
        endpointHttpBaseUrl: "https://caller.example.test",
        endpointWsBaseUrl: "wss://caller.example.test",
        endpointProviderKind: "pathway_relay",
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: false,
        createdByDeviceId: null,
        revokedAt: null,
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
      });
    await ctx.db.insert("users", {
      clerkSubject: "manager",
      email: "manager@example.test",
      displayName: "Manager",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const home = await company("1", ["environments.read"]);
    const other = await company("2", targetPermissions);
    await register("1", home.companyId, CALLER, home.membershipId);
    const targetRegistration = await register("2", other.companyId, TARGET, other.membershipId);
    await ctx.db.insert("agentThreads", {
      id: `${TARGET}:${THREAD}`,
      companyId: other.companyId,
      environmentId: TARGET,
      cloudProjectId: null,
      localProjectId: null,
      threadId: THREAD,
      shell: {},
      updatedAt: NOW,
    });
    const cloudProjectId = await ctx.db.insert("cloudProjects", {
      id: "0198fa00-0000-7000-8000-000000000501",
      companyId: other.companyId,
      name: "pathway",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    });
    const bindingId = await ctx.db.insert("environmentBindings", {
      id: "0198fa00-0000-7000-8000-000000000601",
      companyId: other.companyId,
      cloudProjectId,
      environmentId: TARGET,
      localProjectId: PROJECT,
      localWorkspaceRoot: "/Users/owner/pathway",
      status: "active",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return {
      targetMembershipId: other.membershipId,
      targetRegistrationId: targetRegistration,
      cloudProjectId,
      bindingId,
    };
  });
}

describe("thread access grants", () => {
  it("resolves the linked Clerk subject to the internal membership user id", async () => {
    const t = harness();
    const { targetMembershipId } = await seed(t, ["environments.read"]);
    const membership = await t.run((ctx) => ctx.db.get(targetMembershipId));
    const userId = await asEnvironment(t).query(api.connectGrants.accountUser, {});
    expect(userId).toBe(membership?.userId);
    expect(userId).not.toBe("owner");
    expect(await t.run((ctx) => ctx.db.query("connectGrants").collect())).toEqual([]);
  });

  it("refuses account resolution without the registered proof key or current owner link", async () => {
    const t = harness();
    await seed(t, ["environments.read"]);
    await expect(
      asEnvironment(t, "thumb-stolen").query(api.connectGrants.accountUser, {}),
    ).rejects.toThrow(/exactly one Pathway account/u);
    await t.run(async (ctx) => {
      const link = await ctx.db.query("relayEnvironmentLinks").first();
      await ctx.db.patch(link!._id, { revokedAt: "2026-10-07T00:00:00.000Z" });
    });
    await expect(asEnvironment(t).query(api.connectGrants.accountUser, {})).rejects.toThrow(
      /exactly one Pathway account/u,
    );
  });

  it("resolves the account that linked the environment rather than its registration creator", async () => {
    const t = harness();
    await seed(t, ["environments.read"], { linkedTo: "manager" });
    const user = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", "manager"))
        .unique(),
    );
    expect(await asEnvironment(t).query(api.connectGrants.accountUser, {})).toBe(user?._id);
  });

  it("grants the caller's account a single read of a thread in another company", async () => {
    const t = harness();
    const { targetMembershipId } = await seed(t, ["environments.read"]);

    const grant = await asEnvironment(t).action(api.connectGrants.issueThreadAccess, {
      threadId: THREAD,
      access: "read",
    });
    expect(grant?.environmentId).toBe(TARGET);

    const tokenHash = await hashConnectGrantToken(grant!.token);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("connectGrants")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(stored).toMatchObject({
      environmentId: TARGET,
      grantedMembershipId: targetMembershipId,
      permission: "environments.read",
      consumedAt: null,
    });
  });

  it("grants sends only where the account may control remote agents", async () => {
    const readOnly = harness();
    await seed(readOnly, ["environments.read"]);
    await expect(
      asEnvironment(readOnly).action(api.connectGrants.issueThreadAccess, {
        threadId: THREAD,
        access: "send",
      }),
    ).resolves.toBeNull();

    const t = harness();
    await seed(t, ["remoteAgents.control"]);
    const grant = await asEnvironment(t).action(api.connectGrants.issueThreadAccess, {
      threadId: THREAD,
      access: "send",
    });
    const tokenHash = await hashConnectGrantToken(grant!.token);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("connectGrants")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique(),
    );
    expect(stored?.permission).toBe("remoteAgents.control");
  });

  it("finds nothing for unknown threads or companies where the account cannot read environments", async () => {
    const t = harness();
    await seed(t, ["issues.read"]);
    const environment = asEnvironment(t);
    await expect(
      environment.action(api.connectGrants.issueThreadAccess, { threadId: THREAD, access: "read" }),
    ).resolves.toBeNull();
    await expect(
      environment.action(api.connectGrants.issueThreadAccess, {
        threadId: "thread-missing",
        access: "read",
      }),
    ).resolves.toBeNull();
  });

  it("refuses tokens that are not bound to the caller's registered key", async () => {
    const t = harness();
    await seed(t, ["environments.read"]);
    await expect(
      asEnvironment(t, "thumb-stolen").action(api.connectGrants.issueThreadAccess, {
        threadId: THREAD,
        access: "read",
      }),
    ).rejects.toThrow(/exactly one Pathway account/u);
  });

  it("acts as the account that linked the environment, not whoever registered it", async () => {
    const t = harness();
    // The manager has no membership in the target company, so a grant proves the link owner won.
    await seed(t, ["environments.read"], { linkedTo: "manager" });
    await expect(
      asEnvironment(t).action(api.connectGrants.issueThreadAccess, {
        threadId: THREAD,
        access: "read",
      }),
    ).resolves.toBeNull();
  });

  it("refuses environments that no account has linked", async () => {
    const t = harness();
    await seed(t, ["environments.read"], { linkedTo: null });
    await expect(
      asEnvironment(t).action(api.connectGrants.issueThreadAccess, {
        threadId: THREAD,
        access: "read",
      }),
    ).rejects.toThrow(/exactly one Pathway account/u);
  });

  it("refuses member identities", async () => {
    const t = harness();
    await seed(t, ["environments.read"]);
    await expect(
      t
        .withIdentity({ issuer: "https://clerk.example.test", subject: "owner" })
        .action(api.connectGrants.issueThreadAccess, { threadId: THREAD, access: "read" }),
    ).rejects.toThrow(/Only an environment/u);
  });

  describe("mixed-version targets", () => {
    for (const [label, targetReadGrants] of [
      ["absent", "absent"],
      ["false", false],
      ["not a boolean", "yes"],
    ] as const) {
      it(`fails closed for reads and sends when the target's support is ${label}`, async () => {
        const t = harness();
        await seed(t, ["environments.read", "remoteAgents.control"], { targetReadGrants });
        for (const access of ["read", "send"] as const)
          await expect(issueGrant(t, access)).rejects.toThrow(/cannot limit remote thread access/u);
        const stored = await t.run(async (ctx) => ctx.db.query("connectGrants").collect());
        expect(stored).toEqual([]);
      });
    }

    it("refuses to redeem thread grants after their target stops honouring the mint scopes", async () => {
      const t = harness();
      const { targetRegistrationId } = await seed(t, ["environments.read", "remoteAgents.control"]);
      const read = await issueGrant(t, "read");
      const send = await issueGrant(t, "send");
      await t.run(async (ctx) => {
        const registration = await ctx.db.get(targetRegistrationId);
        await ctx.db.patch(targetRegistrationId, {
          descriptor: { ...registration!.descriptor, capabilities: { repositoryIdentity: true } },
        });
      });
      for (const grant of [read, send])
        await expect(
          asRelay(t).mutation(api.connectGrants.validate, {
            tokenHash: await hashConnectGrantToken(grant!.token),
            signsThreadAccessMintScopes: true,
          }),
        ).resolves.toEqual(CONNECT_GRANT_REFUSED);
    });

    it("redeems thread grants only through a relay that signs the thread-access mint scopes", async () => {
      const t = harness();
      await seed(t, ["environments.read", "remoteAgents.control"]);
      for (const [access, permission] of [
        ["read", "environments.read"],
        ["send", "remoteAgents.control"],
      ] as const) {
        const grant = await issueGrant(t, access);
        const tokenHash = await hashConnectGrantToken(grant!.token);
        // A relay predating the thread-access mint scopes would present it as an ordinary connect,
        // which an older target would turn into a full peer session.
        await expect(
          asRelay(t).mutation(api.connectGrants.validate, { tokenHash }),
        ).resolves.toEqual(CONNECT_GRANT_REFUSED);
        await expect(
          asRelay(t).mutation(api.connectGrants.validate, {
            tokenHash,
            signsThreadAccessMintScopes: true,
          }),
        ).resolves.toMatchObject({ status: "accepted", permission, threadAccess: access });
      }
    });
  });

  describe("project launches", () => {
    const LAUNCH = ["remoteAgents.dispatch", "remoteAgents.control"];
    const launch = (t: Harness, localProjectId = PROJECT) =>
      asEnvironment(t).action(api.connectGrants.issueProjectLaunch, {
        environmentId: TARGET,
        localProjectId,
      });

    it("lists the other environments and projects the account may start threads in", async () => {
      const t = harness();
      await seed(t, LAUNCH);
      await expect(asEnvironment(t).query(api.connectGrants.launchTargets, {})).resolves.toEqual([
        {
          environmentId: TARGET,
          label: TARGET,
          lastSeenAt: NOW,
          updateRequired: false,
          projects: [
            { localProjectId: PROJECT, name: "pathway", workspaceRoot: "/Users/owner/pathway" },
          ],
        },
      ]);
    });

    it("grants a send-scoped launch that the relay redeems as the account's member", async () => {
      const t = harness();
      const { targetMembershipId } = await seed(t, LAUNCH);
      const grant = await launch(t);
      await expect(
        asRelay(t).mutation(api.connectGrants.validate, {
          tokenHash: await hashConnectGrantToken(grant!.token),
          signsThreadAccessMintScopes: true,
        }),
      ).resolves.toMatchObject({
        status: "accepted",
        environmentId: TARGET,
        permission: "remoteAgents.control",
        threadAccess: "send",
      });
      const stored = await t.run(async (ctx) => ctx.db.query("connectGrants").unique());
      expect(stored?.grantedMembershipId).toBe(targetMembershipId);
    });

    it("needs both dispatch and control", async () => {
      for (const permissions of [["remoteAgents.dispatch"], ["remoteAgents.control"]]) {
        const t = harness();
        await seed(t, permissions);
        await expect(launch(t)).resolves.toBeNull();
        await expect(asEnvironment(t).query(api.connectGrants.launchTargets, {})).resolves.toEqual(
          [],
        );
      }
    });

    it("skips unknown, archived, and inactive project checkouts", async () => {
      const t = harness();
      const { cloudProjectId, bindingId } = await seed(t, LAUNCH);
      await expect(launch(t, "project-missing")).resolves.toBeNull();
      await t.run((ctx) => ctx.db.patch(cloudProjectId, { archivedAt: NOW }));
      await expect(launch(t)).resolves.toBeNull();
      await t.run(async (ctx) => {
        await ctx.db.patch(cloudProjectId, { archivedAt: null });
        await ctx.db.patch(bindingId, { status: "stale" });
      });
      await expect(launch(t)).resolves.toBeNull();
      expect(await t.run((ctx) => ctx.db.query("connectGrants").collect())).toEqual([]);
    });

    it("asks for an update on targets that cannot narrow the grant", async () => {
      const t = harness();
      await seed(t, LAUNCH, { targetReadGrants: "absent" });
      await expect(asEnvironment(t).query(api.connectGrants.launchTargets, {})).resolves.toEqual([
        expect.objectContaining({ environmentId: TARGET, updateRequired: true }),
      ]);
      await expect(launch(t)).rejects.toThrow(/cannot limit remote access/u);
    });
  });
});
