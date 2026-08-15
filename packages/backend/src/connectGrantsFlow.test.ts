// @effect-diagnostics globalDate:off -- Test fixtures and expiry patches use Convex epoch milliseconds.
/** End-to-end issue, live authorization re-check, and single-use connect grant coverage. */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { CONNECT_GRANT_REFUSAL_CODE } from "../convex/connectGrants.ts";
import schema from "../convex/schema.ts";
import { CONNECT_GRANT_TTL_MS, hashConnectGrantToken } from "./connectGrants.ts";

const RELAY_ISSUER = "https://relay.example.test";
const CLERK_ISSUER = "https://clerk.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_CLOUD_SYNC = "enabled";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/connectGrants.ts": () => import("../convex/connectGrants.ts"),
};

const COMPANY_ID = "0198fa00-0000-7000-8000-000000000001";
const READER_MEMBERSHIP_ID = "0198fa00-0000-7000-8000-000000000101";
const BLIND_MEMBERSHIP_ID = "0198fa00-0000-7000-8000-000000000102";
const READER_ROLE_ID = "0198fa00-0000-7000-8000-000000000201";
const BLIND_ROLE_ID = "0198fa00-0000-7000-8000-000000000202";
const REGISTRATION_ID = "0198fa00-0000-7000-8000-000000000301";
const ENVIRONMENT_ID = "connect-target";

const REFUSED = { status: "refused", code: CONNECT_GRANT_REFUSAL_CODE } as const;

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asUser(t: Harness, subject: "reader" | "blind") {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email: `${subject}@example.test`,
  });
}

function asRelay(t: Harness) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: "pathway-relay",
    tokenIdentifier: `${RELAY_ISSUER}|pathway-relay`,
    tokenKind: "relay-control-plane",
  });
}

interface Seeded {
  readonly companyDocId: Id<"companies">;
  readonly registrationDocId: Id<"environmentRegistrations">;
  readonly readerMembershipDocId: Id<"memberships">;
  readonly readerRoleDocId: Id<"roles">;
}

async function seed(t: Harness): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Connect Grant Co",
      issueKeyPrefix: "CGT",
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
      subject: "reader" | "blind",
      membershipId: string,
      roleId: string,
      permissions: string[],
    ) => {
      const userDocId = await ctx.db.insert("users", {
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
        userId: userDocId,
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
      return { membershipDocId, roleDocId };
    };

    const reader = await addMember("reader", READER_MEMBERSHIP_ID, READER_ROLE_ID, [
      "environments.read",
    ]);
    await addMember("blind", BLIND_MEMBERSHIP_ID, BLIND_ROLE_ID, ["issues.read"]);
    const registrationDocId = await ctx.db.insert("environmentRegistrations", {
      id: REGISTRATION_ID,
      companyId: companyDocId,
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: "connect-target-thumbprint",
      descriptor: {
        environmentId: ENVIRONMENT_ID,
        label: "Connect target",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: { repositoryIdentity: true },
      },
      relayLinkState: "linked",
      managedEndpointAvailable: true,
      lastSeenAt: now,
      serviceRoleIds: [],
      teamIds: [],
      state: "active",
      registeredByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      companyDocId,
      registrationDocId,
      readerMembershipDocId: reader.membershipDocId,
      readerRoleDocId: reader.roleDocId,
    };
  });
}

async function issue(t: Harness) {
  return await asUser(t, "reader").action(api.connectGrants.issue, {
    companyId: COMPANY_ID,
    environmentId: ENVIRONMENT_ID,
    permission: "environments.read",
  });
}

async function validate(t: Harness, token: string) {
  return await asRelay(t).mutation(api.connectGrants.validate, {
    tokenHash: await hashConnectGrantToken(token),
  });
}

describe("connect grants", () => {
  it("issues an opaque grant and validates it exactly once", async () => {
    const t = harness();
    await seed(t);

    const grant = await issue(t);
    expect(grant).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      membershipId: READER_MEMBERSHIP_ID,
      permission: "environments.read",
    });
    expect(grant.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(grant.token).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.expiresAt - grant.issuedAt).toBe(CONNECT_GRANT_TTL_MS);

    await expect(validate(t, grant.token)).resolves.toEqual({
      status: "accepted",
      environmentId: ENVIRONMENT_ID,
      membershipId: READER_MEMBERSHIP_ID,
      permission: "environments.read",
      expiresAt: grant.expiresAt,
    });
    await expect(validate(t, grant.token)).resolves.toEqual(REFUSED);

    const tokenHash = await hashConnectGrantToken(grant.token);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("connectGrants")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique();
      expect(row).toMatchObject({
        tokenHash,
        consumedAt: expect.any(Number),
        consumer: "pathway-relay",
      });
      expect(row).not.toHaveProperty("token");
      expect(await ctx.db.query("syncChanges").collect()).toEqual([]);
    });
  });

  it("does not issue for unknown or revoked registrations", async () => {
    const t = harness();
    const seeded = await seed(t);

    await expect(
      asUser(t, "reader").action(api.connectGrants.issue, {
        companyId: COMPANY_ID,
        environmentId: "unknown-environment",
        permission: "environments.read",
      }),
    ).rejects.toThrow("not actively registered");
    await t.run((ctx) => ctx.db.patch(seeded.registrationDocId, { state: "revoked" }));
    await expect(issue(t)).rejects.toThrow("not actively registered");
  });

  it("refuses an expired grant", async () => {
    const t = harness();
    await seed(t);
    const grant = await issue(t);
    const tokenHash = await hashConnectGrantToken(grant.token);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("connectGrants")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique();
      if (row === null) throw new Error("issue the grant first");
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });

    await expect(validate(t, grant.token)).resolves.toEqual(REFUSED);
  });

  it("refuses a fresh grant when its target registration is revoked", async () => {
    const t = harness();
    const seeded = await seed(t);
    const grant = await issue(t);
    await t.run((ctx) => ctx.db.patch(seeded.registrationDocId, { state: "revoked" }));

    await expect(validate(t, grant.token)).resolves.toEqual(REFUSED);
  });

  it("refuses a grant when its membership is deactivated after issue", async () => {
    const t = harness();
    const seeded = await seed(t);
    const grant = await issue(t);
    await t.run((ctx) => ctx.db.patch(seeded.readerMembershipDocId, { state: "locked" }));

    await expect(validate(t, grant.token)).resolves.toEqual(REFUSED);
  });

  it("refuses a grant when its asserted permission is revoked after issue", async () => {
    const t = harness();
    const seeded = await seed(t);
    const grant = await issue(t);
    await t.run((ctx) => ctx.db.patch(seeded.readerRoleDocId, { permissions: [] }));

    await expect(validate(t, grant.token)).resolves.toEqual(REFUSED);
  });

  it("does not issue when the caller lacks the asserted permission", async () => {
    const t = harness();
    await seed(t);

    await expect(
      asUser(t, "blind").action(api.connectGrants.issue, {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        permission: "environments.read",
      }),
    ).rejects.toThrow("Missing permission environments.read");
  });

  it("returns the same typed refusal for missing, expired, and consumed tokens", async () => {
    const t = harness();
    await seed(t);
    const consumed = await issue(t);
    await validate(t, consumed.token);
    const expired = await issue(t);
    const expiredHash = await hashConnectGrantToken(expired.token);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("connectGrants")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", expiredHash))
        .unique();
      if (row === null) throw new Error("issue the grant first");
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });

    const refusals = await Promise.all([
      validate(t, "missing-token"),
      validate(t, expired.token),
      validate(t, consumed.token),
    ]);
    expect(refusals).toEqual([REFUSED, REFUSED, REFUSED]);
  });
});
