// @effect-diagnostics globalDate:off -- Test rows mirror Convex documents, whose clock is `Date.now()`.
/**
 * Drives `companies.listMine` through the production identity resolution. The listing is what a
 * client reconciles its sync engines against, so what it answers to a caller Convex could not
 * authenticate matters as much as what it answers to a member.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

process.env.PATHWAY_RELAY_JWT_ISSUER = "https://relay.example.test";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/companies.ts": () => import("../convex/companies.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const COMPANY_ID = "0198c0de-eeee-7eee-8eee-000000000001";
const MEMBERSHIP_ID = "0198c0de-eeee-7eee-8eee-000000000101";

function harness() {
  return convexTest(schema, modules);
}

const asClerkUser = (t: ReturnType<typeof harness>, subject: string) =>
  t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
  });

async function seed(t: ReturnType<typeof harness>) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Listing Test Co",
      issueKeyPrefix: "LIS",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {
      clerkSubject: "user_member",
      email: "member@example.test",
      displayName: "Member",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("memberships", {
      id: MEMBERSHIP_ID,
      companyId: companyDocId,
      userId,
      state: "active",
      displayNameSnapshot: "Member",
      emailSnapshot: "member@example.test",
      invitedByMembershipId: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("companies.listMine", () => {
  it("lists the companies the signed-in member belongs to", async () => {
    const t = harness();
    await seed(t);

    const companies = await asClerkUser(t, "user_member").query(api.companies.listMine, {});

    expect(
      companies.map((company) => [company.id, company.membershipId, company.workspaceKind]),
    ).toEqual([[COMPANY_ID, MEMBERSHIP_ID, "organization"]]);
  });

  /**
   * An empty listing is an instruction — "you are a member of nothing, stop every engine" — so it
   * must only ever be the answer to a question this deployment could actually answer. Handing it
   * to an unauthenticated caller makes "your token never arrived" look exactly like "you left every
   * company", and a client that believes it tears down its sync engines without a word.
   */
  it("refuses a caller it cannot authenticate instead of answering an empty listing", async () => {
    const t = harness();
    await seed(t);

    await expect(t.query(api.companies.listMine, {})).rejects.toThrow(
      "This request requires an authenticated identity.",
    );
  });

  /** A person who has signed in but has not been provisioned really is a member of nothing. */
  it("answers an empty listing for a signed-in identity with no user row yet", async () => {
    const t = harness();
    await seed(t);

    expect(await asClerkUser(t, "user_new").query(api.companies.listMine, {})).toEqual([]);
  });
});
