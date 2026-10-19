import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vite-plus/test";
import schema from "../convex/schema.ts";
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/contacts.ts": () => import("../convex/contacts.ts"),
  "../convex/timeTracking.ts": () => import("../convex/timeTracking.ts"),
};
const mutation = (name: string) => makeFunctionReference<"mutation">(name);
const query = (name: string) => makeFunctionReference<"query">(name);
async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const subject of ["owner", "reader", "outsider"])
      await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: 1,
        updatedAt: 1,
      });
    const companyId = await ctx.db.insert("companies", {
      id: "company",
      name: "Company",
      issueKeyPrefix: "C",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    for (const subject of ["owner", "reader"]) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
        .unique();
      const membershipId = await ctx.db.insert("memberships", {
        id: subject,
        companyId,
        userId: user!._id,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      if (subject === "owner")
        await ctx.db.insert("companyOwners", {
          companyId,
          membershipId,
          grantedByMembershipId: null,
          createdAt: 1,
        });
    }
  });
  return {
    t,
    as: (subject: string) =>
      t.withIdentity({
        subject,
        issuer: "https://clerk.example.test",
        tokenIdentifier: `https://clerk.example.test|${subject}`,
      }),
  };
}
const fields = {
  name: "A Person",
  role: "Engineer",
  company: "Example",
  email: "person@example.test",
  phone: "",
  notes: "",
  favorite: false,
};
const timer = { id: "timer", description: "Writing", projectKey: "", projectName: "No project" };
describe("Shared business tools", () => {
  it("enforces company membership and contact write authority", async () => {
    const { t, as } = await setup();
    await expect(t.query(query("contacts:list"), { companyId: "company" })).rejects.toThrow();
    await expect(
      as("outsider").query(query("contacts:list"), { companyId: "company" }),
    ).rejects.toThrow();
    const create = {
      companyId: "company",
      id: "c",
      requestId: "write",
      expectedRevision: null,
      ...fields,
    };
    await expect(as("reader").mutation(mutation("contacts:upsert"), create)).rejects.toThrow();
    await as("owner").mutation(mutation("contacts:upsert"), create);
    expect(
      (await as("reader").query(query("contacts:list"), { companyId: "company" })).contacts,
    ).toHaveLength(1);
  });
  it("retries contact writes once and refuses stale edits", async () => {
    const { as } = await setup();
    const create = {
      companyId: "company",
      id: "c",
      requestId: "write",
      expectedRevision: null,
      ...fields,
    };
    await as("owner").mutation(mutation("contacts:upsert"), create);
    await as("owner").mutation(mutation("contacts:upsert"), create);
    await as("owner").mutation(mutation("contacts:upsert"), {
      ...create,
      requestId: "new",
      expectedRevision: 1,
      name: "Updated",
    });
    await expect(
      as("owner").mutation(mutation("contacts:upsert"), {
        ...create,
        requestId: "stale",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/changed/);
    const { contacts: rows } = await as("owner").query(query("contacts:list"), {
      companyId: "company",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Updated");
  });
  it("imports contacts idempotently and does not resurrect deleted imports", async () => {
    const { as } = await setup();
    const args = {
      companyId: "company",
      contacts: [{ id: "local", ...fields, createdAt: "2026-09-06T00:00:00Z" }],
    };
    await as("owner").mutation(mutation("contacts:importLocal"), args);
    expect(await as("owner").mutation(mutation("contacts:importLocal"), args)).toEqual({
      imported: 0,
    });
    const { contacts: rows } = await as("owner").query(query("contacts:list"), {
      companyId: "company",
    });
    await as("owner").mutation(mutation("contacts:remove"), {
      companyId: "company",
      id: rows[0].id,
      expectedRevision: 1,
    });
    await as("owner").mutation(mutation("contacts:importLocal"), args);
    expect(
      (await as("owner").query(query("contacts:list"), { companyId: "company" })).contacts,
    ).toEqual([]);
  });
  it("allows one running timer per user and retries do not restart it", async () => {
    const { as } = await setup();
    const first = await as("owner").mutation(mutation("timeTracking:start"), timer);
    expect(await as("owner").mutation(mutation("timeTracking:start"), timer)).toEqual(first);
    await expect(
      as("owner").mutation(mutation("timeTracking:start"), { ...timer, id: "second" }),
    ).rejects.toThrow(/already running/);
    await as("reader").mutation(mutation("timeTracking:start"), timer);
    expect((await as("owner").query(query("timeTracking:listMine"), {})).active.id).toBe("timer");
    expect((await as("reader").query(query("timeTracking:listMine"), {})).active.id).toBe("timer");
  });
  it("serializes simultaneous starts from two devices", async () => {
    const { as } = await setup();
    const results = await Promise.allSettled([
      as("owner").mutation(mutation("timeTracking:start"), { ...timer, id: "phone" }),
      as("owner").mutation(mutation("timeTracking:start"), { ...timer, id: "desktop" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const state = await as("owner").query(query("timeTracking:listMine"), {});
    expect(["phone", "desktop"]).toContain(state.active.id);
  });
  it("a stale stop cannot stop a newer timer or another user's timer", async () => {
    const { as } = await setup();
    await as("owner").mutation(mutation("timeTracking:start"), timer);
    await expect(
      as("reader").mutation(mutation("timeTracking:stop"), { id: "timer" }),
    ).rejects.toThrow();
    await as("owner").mutation(mutation("timeTracking:stop"), { id: "timer" });
    await as("owner").mutation(mutation("timeTracking:start"), { ...timer, id: "new" });
    await as("owner").mutation(mutation("timeTracking:stop"), { id: "timer" });
    const state = await as("owner").query(query("timeTracking:listMine"), {});
    expect(state.active.id).toBe("new");
    expect(state.entries).toHaveLength(1);
  });
  it("recomputes imported durations and rejects malformed sessions atomically", async () => {
    const { as } = await setup();
    const entry = {
      ...timer,
      startedAt: "2026-09-06T00:00:00Z",
      stoppedAt: "2026-09-06T01:00:00Z",
      durationMs: 1,
    };
    await as("owner").mutation(mutation("timeTracking:importLocal"), { entries: [entry] });
    await as("owner").mutation(mutation("timeTracking:importLocal"), { entries: [entry] });
    const state = await as("owner").query(query("timeTracking:listMine"), {});
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].durationMs).toBe(3_600_000);
    await expect(
      as("owner").mutation(mutation("timeTracking:importLocal"), {
        entries: [
          { ...entry, id: "valid" },
          { ...entry, id: "bad", stoppedAt: "bad" },
        ],
      }),
    ).rejects.toThrow();
    expect((await as("owner").query(query("timeTracking:listMine"), {})).entries).toHaveLength(1);
  });
});
