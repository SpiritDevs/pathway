// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Exercises `convex/smoke.ts` — the internal-only seed for the relay → Convex trust-chain smoke
 * test — through the same identity resolution the production deployment runs: a relay-issued
 * environment token whose `cnf.jkt` must match the registered thumbprint.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";
import {
  SMOKE_COMPANY_DOMAIN_ID,
  SMOKE_ENVIRONMENT_ID_PREFIX,
  SMOKE_ORPHAN_MIN_AGE_MS,
  SMOKE_ROLE_DOMAIN_ID,
  smokeRegistrationDomainId,
  smokeServiceRolePermissions,
} from "./smokeSeed.ts";

const RELAY_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
// The sync surface gates on the capability switch; the smoke functions deliberately do not.

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/smoke.ts": () => import("../convex/smoke.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

function harness() {
  return convexTest(schema, modules);
}

/** The identity shape the relay mints: `pathway-convex` audience, environment subject, `cnf.jkt`. */
function asEnvironment(t: ReturnType<typeof harness>, environmentId: string, jkt: string) {
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: environmentId,
    tokenIdentifier: `${RELAY_ISSUER}|${environmentId}`,
    cnf: { jkt },
  });
}

const ENVIRONMENT_ID = "environment-smoke-1";
const THUMB_A = "thumbprint-aaaa";
const THUMB_B = "thumbprint-bbbb";

describe("smoke.seed", () => {
  it("creates the smoke company, service role, and active registration, and converges on re-run", async () => {
    const t = harness();
    const first = await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });
    expect(first).toEqual({
      companyId: SMOKE_COMPANY_DOMAIN_ID,
      registrationId: smokeRegistrationDomainId(ENVIRONMENT_ID),
      roleId: SMOKE_ROLE_DOMAIN_ID,
    });

    const second = await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });
    expect(second).toEqual(first);

    await t.run(async (ctx) => {
      const companies = await ctx.db.query("companies").collect();
      expect(companies).toHaveLength(1);
      expect(companies[0]?.id).toBe(SMOKE_COMPANY_DOMAIN_ID);
      expect(companies[0]?.name).toBe("Smoke Test — relay e2e");
      expect(companies[0]?.lifecycleState).toBe("active");

      const roles = await ctx.db.query("roles").collect();
      expect(roles).toHaveLength(1);
      expect(roles[0]?.permissions).toEqual([...smokeServiceRolePermissions()]);

      const registrations = await ctx.db.query("environmentRegistrations").collect();
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.publicKeyThumbprint).toBe(THUMB_A);
      expect(registrations[0]?.state).toBe("active");
      expect(registrations[0]?.relayLinkState).toBe("linked");
      expect(registrations[0]?.teamIds).toEqual([]);
      expect(registrations[0]?.registeredByMembershipId).toBeNull();
      expect(registrations[0]?.managedEndpointAvailable).toBe(false);
      expect(registrations[0]?.serviceRoleIds).toEqual([SMOKE_ROLE_DOMAIN_ID]);
    });
  });

  it("re-seeding with a new thumbprint updates the registration in place and restores it to active", async () => {
    const t = harness();
    const first = await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });
    await t.mutation(internal.smoke.revokeRegistration, { environmentId: ENVIRONMENT_ID });

    const second = await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_B,
    });
    expect(second.registrationId).toBe(first.registrationId);

    const state = await t.query(internal.smoke.inspect, { environmentId: ENVIRONMENT_ID });
    expect(state?.registration).toMatchObject({
      id: first.registrationId,
      publicKeyThumbprint: THUMB_B,
      state: "active",
      relayLinkState: "linked",
    });
  });

  it("refuses empty or untrimmed keys", async () => {
    const t = harness();
    await expect(
      t.mutation(internal.smoke.seed, { environmentId: "", publicKeyThumbprint: THUMB_A }),
    ).rejects.toThrow("non-empty");
    await expect(
      t.mutation(internal.smoke.seed, {
        environmentId: ENVIRONMENT_ID,
        publicKeyThumbprint: " padded ",
      }),
    ).rejects.toThrow("trimmed");
  });
});

describe("relay trust chain through the seeded registration", () => {
  it("admits an environment token bound to the registered key and refuses every other key", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_A).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).resolves.toMatchObject({ version: 0 });

    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_B).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).rejects.toThrow("not bound to the key");

    await expect(
      asEnvironment(t, "environment-unregistered", THUMB_A).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).rejects.toThrow("not registered");
  });

  it("setThumbprint flips which key is admitted, driving the key-mismatch rejection", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    const updated = await t.mutation(internal.smoke.setThumbprint, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_B,
    });
    expect(updated).toEqual({ updated: true });

    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_A).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).rejects.toThrow("not bound to the key");
    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_B).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).resolves.toMatchObject({ version: 0 });

    await expect(
      t.mutation(internal.smoke.setThumbprint, {
        environmentId: "environment-unknown",
        publicKeyThumbprint: THUMB_A,
      }),
    ).resolves.toEqual({ updated: false });
  });

  it("revokeRegistration shuts the environment out until it is re-seeded", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    await expect(
      t.mutation(internal.smoke.revokeRegistration, { environmentId: ENVIRONMENT_ID }),
    ).resolves.toEqual({ revoked: true });
    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_A).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).rejects.toThrow("not registered");

    // Idempotent, and a miss reports itself rather than throwing.
    await expect(
      t.mutation(internal.smoke.revokeRegistration, { environmentId: ENVIRONMENT_ID }),
    ).resolves.toEqual({ revoked: true });
    await expect(
      t.mutation(internal.smoke.revokeRegistration, { environmentId: "environment-unknown" }),
    ).resolves.toEqual({ revoked: false });
  });

  it("the seeded permissions cover the change-feed read gates", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    await expect(
      asEnvironment(t, ENVIRONMENT_ID, THUMB_A).query(api.sync.listChanges, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
        cursor: 0,
      }),
    ).resolves.toMatchObject({ _tag: "Changes", changes: [], hasMore: false });
  });
});

/** Backdates every registration past the orphan threshold: residue of a long-dead run. */
async function ageOutRegistrations(t: ReturnType<typeof harness>) {
  await t.run(async (ctx) => {
    const stale = Date.now() - SMOKE_ORPHAN_MIN_AGE_MS - 1_000;
    for (const registration of await ctx.db.query("environmentRegistrations").collect()) {
      await ctx.db.patch(registration._id, { updatedAt: stale });
    }
  });
}

describe("smoke.cleanup", () => {
  it("deletes the registration, and the company with its rows only once no registrations remain", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: "environment-one",
      publicKeyThumbprint: THUMB_A,
    });
    await t.mutation(internal.smoke.seed, {
      environmentId: "environment-two",
      publicKeyThumbprint: THUMB_B,
    });

    // Environment-actor writes the cleanup must sweep up afterwards: a key lease, plus the
    // issue-domain round trip the smoke harness performs (an `issueLabel` created then tombstoned
    // through `sync.applyOperations`, exactly as `convexSyncSmoke.ts` sends it).
    await asEnvironment(t, "environment-one", THUMB_A).mutation(api.sync.reserveIssueKeys, {
      companyId: SMOKE_COMPANY_DOMAIN_ID,
      clientId: "smoke-client",
    });
    const labelId = "0198f7f0-3333-7333-8333-000000000001";
    const labelOp = (suffix: string, sequence: number, kind: string, args: unknown) => ({
      protocolVersion: 1,
      operationId: `0198f7f0-3333-7333-8333-00000000${suffix}`,
      companyId: SMOKE_COMPANY_DOMAIN_ID,
      clientId: "smoke-client",
      environmentId: "environment-one",
      actor: { kind: "environment" as const, environmentId: "environment-one" },
      localSequence: sequence,
      baseVersion: 0,
      kind,
      entityId: labelId,
      args,
      dependsOn: [],
    });
    const applied = await asEnvironment(t, "environment-one", THUMB_A).mutation(
      api.sync.applyOperations,
      {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
        operations: [
          labelOp("1001", 1, "issueLabel.create", { name: "smoke-label", color: "#0ea5e9" }),
          labelOp("1002", 2, "issueLabel.delete", {}),
        ],
      },
    );
    // The seeded service role's `workflow.manage` grant is what admits these; a rejection here
    // means the smoke role and the sync surface's write gate have drifted apart.
    expect(applied.receipts.map((receipt) => receipt.status)).toEqual(["accepted", "accepted"]);

    const first = await t.mutation(internal.smoke.cleanup, { environmentId: "environment-one" });
    // "environment-two" lacks the synthetic prefix, so the sweep must leave it alone.
    expect(first).toMatchObject({
      registrations: 1,
      sweptRegistrations: 0,
      companies: 0,
      roles: 0,
    });

    // The second registration still holds the company open.
    await expect(
      t.query(internal.smoke.inspect, { environmentId: "environment-two" }),
    ).resolves.toMatchObject({ companyId: SMOKE_COMPANY_DOMAIN_ID });

    const second = await t.mutation(internal.smoke.cleanup, { environmentId: "environment-two" });
    expect(second).toMatchObject({
      registrations: 1,
      companies: 1,
      roles: 1,
      issueKeyReservations: 1,
      // The tombstoned label row; label operations emit no audit events.
      issueDomainRows: 1,
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("companies").collect()).toHaveLength(0);
      expect(await ctx.db.query("roles").collect()).toHaveLength(0);
      expect(await ctx.db.query("environmentRegistrations").collect()).toHaveLength(0);
      expect(await ctx.db.query("issueKeyReservations").collect()).toHaveLength(0);
      expect(await ctx.db.query("issueLabels").collect()).toHaveLength(0);
      expect(await ctx.db.query("syncChanges").collect()).toHaveLength(0);
      expect(await ctx.db.query("syncOperationReceipts").collect()).toHaveLength(0);
    });

    // A cleanup against nothing is a no-op, and the world is reseedable afterwards.
    const empty = await t.mutation(internal.smoke.cleanup, { environmentId: "environment-two" });
    expect(Object.values(empty).every((count) => count === 0)).toBe(true);
    await expect(
      t.mutation(internal.smoke.seed, {
        environmentId: ENVIRONMENT_ID,
        publicKeyThumbprint: THUMB_A,
      }),
    ).resolves.toMatchObject({ companyId: SMOKE_COMPANY_DOMAIN_ID });
  });

  it("never touches rows outside the smoke company", async () => {
    const t = harness();
    // A neighboring company that must survive cleanup untouched.
    const otherIds = await t.run(async (ctx) => {
      const now = Date.now();
      const companyDocId = await ctx.db.insert("companies", {
        id: "0198f7f0-1111-7111-8111-000000000001",
        name: "Real Company",
        issueKeyPrefix: "REAL",
        nextIssueNumber: 1,
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        authorizationEpoch: 1,
        syncVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roles", {
        id: "0198f7f0-1111-7111-8111-000000000002",
        companyId: companyDocId,
        name: "Member",
        description: "",
        permissions: ["issues.read"],
        seeded: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("environmentRegistrations", {
        id: "0198f7f0-1111-7111-8111-000000000003",
        companyId: companyDocId,
        environmentId: ENVIRONMENT_ID,
        publicKeyThumbprint: THUMB_B,
        descriptor: null,
        relayLinkState: "linked",
        managedEndpointAvailable: false,
        lastSeenAt: null,
        serviceRoleIds: [],
        teamIds: [],
        state: "active",
        registeredByMembershipId: null,
        createdAt: now,
        updatedAt: now,
      });
      return { companyDocId };
    });

    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });
    await t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(otherIds.companyDocId)).not.toBeNull();
      expect(await ctx.db.query("roles").collect()).toHaveLength(1);
      // The other company's registration for the same environment id is untouched.
      expect(await ctx.db.query("environmentRegistrations").collect()).toHaveLength(1);
    });
  });

  it("sweeps aged-out env-smoke-* registrations so an interrupted run cannot pin the company", async () => {
    const t = harness();
    const named = `${SMOKE_ENVIRONMENT_ID_PREFIX}named`;
    // Two orphans from interrupted earlier runs: their cleanup never ran.
    await t.mutation(internal.smoke.seed, {
      environmentId: `${SMOKE_ENVIRONMENT_ID_PREFIX}orphan-a`,
      publicKeyThumbprint: THUMB_A,
    });
    await t.mutation(internal.smoke.seed, {
      environmentId: `${SMOKE_ENVIRONMENT_ID_PREFIX}orphan-b`,
      publicKeyThumbprint: THUMB_B,
    });
    await t.mutation(internal.smoke.seed, {
      environmentId: named,
      publicKeyThumbprint: THUMB_A,
    });
    await ageOutRegistrations(t);

    const counts = await t.mutation(internal.smoke.cleanup, { environmentId: named });
    expect(counts).toMatchObject({
      registrations: 1,
      sweptRegistrations: 2,
      retainedRegistrations: 0,
      companies: 1,
      roles: 1,
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("companies").collect()).toHaveLength(0);
      expect(await ctx.db.query("environmentRegistrations").collect()).toHaveLength(0);
      expect(await ctx.db.query("roles").collect()).toHaveLength(0);
    });
  });

  it("leaves a concurrent run's fresh env-smoke-* registration — and the company — alone", async () => {
    const t = harness();
    const mine = `${SMOKE_ENVIRONMENT_ID_PREFIX}mine`;
    const concurrent = `${SMOKE_ENVIRONMENT_ID_PREFIX}concurrent`;
    await t.mutation(internal.smoke.seed, { environmentId: mine, publicKeyThumbprint: THUMB_A });
    await t.mutation(internal.smoke.seed, {
      environmentId: concurrent,
      publicKeyThumbprint: THUMB_B,
    });

    // Both registrations were touched moments ago: the other run is still in flight, so only this
    // run's own registration goes.
    const counts = await t.mutation(internal.smoke.cleanup, { environmentId: mine });
    expect(counts).toMatchObject({
      registrations: 1,
      sweptRegistrations: 0,
      retainedRegistrations: 1,
      companies: 0,
      roles: 0,
    });

    // The concurrent run can still authenticate and read its company.
    await expect(
      asEnvironment(t, concurrent, THUMB_B).query(api.sync.latestVersion, {
        companyId: SMOKE_COMPANY_DOMAIN_ID,
      }),
    ).resolves.toMatchObject({ version: 0 });

    // Once it ages out (its own run long gone), the next cleanup collects it.
    await ageOutRegistrations(t);
    expect(await t.mutation(internal.smoke.cleanup, { environmentId: mine })).toMatchObject({
      registrations: 0,
      sweptRegistrations: 1,
      companies: 1,
    });
  });

  it("refuses company deletion when a table the smoke flow cannot write holds a row", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    // A membership is something no smoke function can create: its presence means real data.
    await t.run(async (ctx) => {
      const now = Date.now();
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", SMOKE_COMPANY_DOMAIN_ID))
        .unique();
      if (company === null) throw new Error("seed did not create the smoke company");
      const userId = await ctx.db.insert("users", {
        clerkSubject: "user_smoke_foreign",
        email: "foreign@example.test",
        displayName: "Foreign User",
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("memberships", {
        id: "0198f7f0-2222-7222-8222-000000000001",
        companyId: company._id,
        userId,
        state: "active",
        displayNameSnapshot: "Foreign User",
        emailSnapshot: "foreign@example.test",
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("memberships");

    // The refusal rolls the whole transaction back: even the registration delete is undone.
    await t.run(async (ctx) => {
      expect(await ctx.db.query("companies").collect()).toHaveLength(1);
      expect(await ctx.db.query("environmentRegistrations").collect()).toHaveLength(1);
      expect(await ctx.db.query("roles").collect()).toHaveLength(1);
      expect(await ctx.db.query("memberships").collect()).toHaveLength(1);
    });
  });

  it("refuses over a companySettings row instead of deleting it blind", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    // No sync operation kind writes `companySettings`, so a row here is somebody else's data —
    // an admin surface or a dashboard edit — and must stop the company delete.
    await t.run(async (ctx) => {
      const now = Date.now();
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", SMOKE_COMPANY_DOMAIN_ID))
        .unique();
      if (company === null) throw new Error("seed did not create the smoke company");
      await ctx.db.insert("companySettings", {
        companyId: company._id,
        offlineAccessDays: 7,
        updatedByMembershipId: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("companySettings");

    await t.run(async (ctx) => {
      expect(await ctx.db.query("companySettings").collect()).toHaveLength(1);
      expect(await ctx.db.query("companies").collect()).toHaveLength(1);
    });
  });

  it("refuses over a role the seed did not write instead of deleting it blind", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    // `seed` writes exactly one role, at the reserved id; a second one is foreign by construction.
    await t.run(async (ctx) => {
      const now = Date.now();
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", SMOKE_COMPANY_DOMAIN_ID))
        .unique();
      if (company === null) throw new Error("seed did not create the smoke company");
      await ctx.db.insert("roles", {
        id: "0198f7f0-5555-7555-8555-000000000001",
        companyId: company._id,
        name: "Hand-added",
        description: "",
        permissions: ["issues.read"],
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    await expect(
      t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("roles");

    await t.run(async (ctx) => {
      expect(await ctx.db.query("roles").collect()).toHaveLength(2);
      expect(await ctx.db.query("companies").collect()).toHaveLength(1);
    });
  });

  it("still refuses over issueAttachments, the one issue-domain table the sync surface cannot write", async () => {
    const t = harness();
    await t.mutation(internal.smoke.seed, {
      environmentId: ENVIRONMENT_ID,
      publicKeyThumbprint: THUMB_A,
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", SMOKE_COMPANY_DOMAIN_ID))
        .unique();
      if (company === null) throw new Error("seed did not create the smoke company");
      await ctx.db.insert("issueAttachments", {
        id: "0198f7f0-4444-7444-8444-000000000001",
        companyId: company._id,
        issueId: "0198f7f0-4444-7444-8444-000000000002",
        commentId: null,
        storageId: null,
        fileName: "foreign.txt",
        mimeType: "text/plain",
        byteSize: 1,
        checksum: "sha256:0",
        uploadedByMembershipId: null,
        state: "pending",
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 0,
      });
    });

    await expect(
      t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("issueAttachments");
  });
});

describe("smoke provenance guard", () => {
  /** A company squatting on the reserved id without the marker name: not ours to touch. */
  async function insertImpostorCompany(t: ReturnType<typeof harness>) {
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("companies", {
        id: SMOKE_COMPANY_DOMAIN_ID,
        name: "Imported Real Company",
        issueKeyPrefix: "REAL",
        nextIssueNumber: 1,
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        authorizationEpoch: 1,
        syncVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  it("every smoke function refuses a company at the reserved id whose name is not the marker", async () => {
    const t = harness();
    await insertImpostorCompany(t);

    // Seed must not rename or reactivate it — it must not touch it at all.
    await expect(
      t.mutation(internal.smoke.seed, {
        environmentId: ENVIRONMENT_ID,
        publicKeyThumbprint: THUMB_A,
      }),
    ).rejects.toThrow("not the smoke marker");
    await expect(
      t.mutation(internal.smoke.cleanup, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("not the smoke marker");
    await expect(
      t.mutation(internal.smoke.revokeRegistration, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("not the smoke marker");
    await expect(
      t.query(internal.smoke.inspect, { environmentId: ENVIRONMENT_ID }),
    ).rejects.toThrow("not the smoke marker");

    await t.run(async (ctx) => {
      const companies = await ctx.db.query("companies").collect();
      expect(companies).toHaveLength(1);
      expect(companies[0]?.name).toBe("Imported Real Company");
      expect(companies[0]?.lifecycleState).toBe("active");
      expect(await ctx.db.query("environmentRegistrations").collect()).toHaveLength(0);
      expect(await ctx.db.query("roles").collect()).toHaveLength(0);
    });
  });
});
