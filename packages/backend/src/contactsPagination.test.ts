import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type {
  BusinessContactPage,
  BusinessContactSearchField,
} from "@spiritdevs/contracts/businessTools";
import { describe, expect, it } from "vite-plus/test";
import schema from "../convex/schema.ts";
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/contacts.ts": () => import("../convex/contacts.ts"),
};
const list = makeFunctionReference<
  "query",
  {
    companyId: string;
    cursor?: string | null;
    search?: string;
    searchField?: BusinessContactSearchField;
    favoritesOnly?: boolean;
  },
  BusinessContactPage
>("contacts:list");
async function setup() {
  const t = convexTest(schema, modules);
  const { userId, companyId, otherId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkSubject: "member",
      email: "member@example.test",
      displayName: "Member",
      imageUrl: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const company = {
      name: "Company",
      issueKeyPrefix: "C",
      nextIssueNumber: 1,
      lifecycleState: "active" as const,
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const companyId = await ctx.db.insert("companies", { ...company, id: "company" });
    const otherId = await ctx.db.insert("companies", { ...company, id: "other" });
    await ctx.db.insert("memberships", {
      id: "member",
      companyId,
      userId,
      state: "active",
      displayNameSnapshot: "Member",
      emailSnapshot: "member@example.test",
      invitedByMembershipId: null,
      joinedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, companyId, otherId };
  });
  const insert = (
    count: number,
    fields: {
      name?: string;
      role?: string;
      company?: string;
      email?: string;
      phone?: string;
      favorite?: boolean;
      deletedAt?: number | null;
    } = {},
    other = false,
  ) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++)
        await ctx.db.insert("businessContacts", {
          id: `${other}:${JSON.stringify(fields)}:${i}`,
          companyId: other ? otherId : companyId,
          name: `Contact ${String(i).padStart(4, "0")}`,
          role: "",
          company: "",
          email: "",
          phone: "",
          notes: "",
          favorite: false,
          createdAt: "2026-09-06T00:00:00Z",
          revision: 1,
          deletedAt: null,
          lastRequestId: `import-${i}`,
          lastRequestUserId: userId,
          ...fields,
        });
    });
  const member = t.withIdentity({
    subject: "member",
    issuer: "https://clerk.example.test",
    tokenIdentifier: "https://clerk.example.test|member",
  });
  return { t, member, insert };
}
describe("Bounded searchable contact directory", () => {
  it("pages every live contact while excluding tombstones and foreign workspaces", async () => {
    const { member, insert, t } = await setup();
    await insert(123);
    await insert(70, { deletedAt: 1 });
    await insert(70, {}, true);
    let cursor: string | null = null;
    const ids = new Set<string>();
    do {
      const page: BusinessContactPage = await member.query(list, { companyId: "company", cursor });
      expect(page.contacts.length).toBeLessThanOrEqual(50);
      for (const row of page.contacts) {
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      expect(page.isDone).toBe(page.cursor === null);
      cursor = page.cursor;
    } while (cursor);
    expect(ids.size).toBe(123);
    await expect(t.query(list, { companyId: "company" })).rejects.toThrow();
    await expect(member.query(list, { companyId: "other" })).rejects.toThrow();
  });
  it.each(["name", "role", "company", "email", "phone"] as const)(
    "searches the full %s index beyond the first directory page",
    async (searchField) => {
      const { member, insert } = await setup();
      await insert(60);
      await insert(1, { name: "ZZZ target", [searchField]: "Needle" });
      await insert(1, { name: "ZZZ deleted", [searchField]: "Needle", deletedAt: 1 });
      await insert(1, { name: "ZZZ foreign", [searchField]: "Needle" }, true);
      expect((await member.query(list, { companyId: "company" })).contacts).toHaveLength(50);
      const result = await member.query(list, {
        companyId: "company",
        search: "Needle",
        searchField,
      });
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0]![searchField]).toBe("Needle");
      expect(result.isDone).toBe(true);
    },
  );
  it("loads an older contact directly and removes it from detail after deletion", async () => {
    const { member, insert, t } = await setup();
    await insert(1, { name: "Older" });
    const row = (await member.query(list, { companyId: "company" })).contacts[0]!;
    const get = makeFunctionReference<"query">("contacts:get");
    expect((await member.query(get, { companyId: "company", id: row.id })).name).toBe("Older");
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("businessContacts").first();
      await ctx.db.patch(stored!._id, { deletedAt: 1 });
    });
    expect(await member.query(get, { companyId: "company", id: row.id })).toBeNull();
    await expect(t.query(get, { companyId: "company", id: row.id })).rejects.toThrow();
    await expect(member.query(get, { companyId: "other", id: row.id })).rejects.toThrow();
  });
  it("pages search matches and applies favorites inside the directory query", async () => {
    const { member, insert } = await setup();
    await insert(72, { name: "Needle", favorite: true });
    await insert(72, { name: "Needle", favorite: false });
    const args = { companyId: "company", search: "Needle", favoritesOnly: true };
    const first = await member.query(list, args);
    const second = await member.query(list, { ...args, cursor: first.cursor });
    expect(first.contacts).toHaveLength(50);
    expect(second.contacts).toHaveLength(22);
    expect(second.isDone).toBe(true);
    expect([...first.contacts, ...second.contacts].every((row) => row.favorite)).toBe(true);
    expect(
      (await member.query(list, { companyId: "company", favoritesOnly: true })).contacts.every(
        (row) => row.favorite,
      ),
    ).toBe(true);
  });
});
