// @effect-diagnostics globalDate:off -- Fixtures use the Convex transaction clock and wire ISO dates.
import type { TrackedSessionPage } from "@spiritdevs/contracts/businessTools";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vite-plus/test";
import schema from "../convex/schema.ts";
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/timeTracking.ts": () => import("../convex/timeTracking.ts"),
};
const query = (name: string) => makeFunctionReference<"query">(`timeTracking:${name}`);
async function setup() {
  const t = convexTest(schema, modules);
  const users = await t.run(async (ctx) =>
    Promise.all(
      ["one", "two"].map((subject) =>
        ctx.db.insert("users", {
          clerkSubject: subject,
          email: `${subject}@example.test`,
          displayName: subject,
          imageUrl: null,
          createdAt: 1,
          updatedAt: 1,
        }),
      ),
    ),
  );
  const as = (subject: string) =>
    t.withIdentity({
      subject,
      issuer: "https://clerk.example.test",
      tokenIdentifier: `https://clerk.example.test|${subject}`,
    });
  const insert = (
    count: number,
    stop: number,
    state: "stopped" | "deleted" | "running" = "stopped",
    user = 0,
    start = stop - 60_000,
  ) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++)
        await ctx.db.insert("trackedSessions", {
          id: `${user}:${state}:${stop}:${i}`,
          userId: users[user]!,
          description: "Work",
          projectKey: "",
          projectName: "No project",
          startedAt: new Date(start).toISOString(),
          stoppedAt: state === "running" ? null : new Date(stop).toISOString(),
          durationMs: stop - start,
          state,
        });
    });
  return { t, as, insert };
}
describe("Bounded tracked time reads", () => {
  it("pages every stopped session without scanning deleted or foreign rows and always returns the active timer", async () => {
    const { as, insert } = await setup();
    const now = Date.now();
    await insert(123, now - 10_000);
    await insert(70, now - 1_000, "deleted");
    await insert(80, now - 1_000, "stopped", 1);
    await insert(1, now - 40 * 86_400_000, "running");
    const ids = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: TrackedSessionPage = await as("one").query(query("listMine"), { cursor });
      expect(page.entries.length).toBeLessThanOrEqual(50);
      expect(page.active?.startedAt).toBe(new Date(now - 40 * 86_400_000 - 60_000).toISOString());
      for (const entry of page.entries) {
        expect(ids.has(entry.id)).toBe(false);
        ids.add(entry.id);
      }
      expect(page.isDone).toBe(page.cursor === null);
      cursor = page.cursor;
      pages++;
    } while (cursor);
    expect(ids.size).toBe(123);
    expect(pages).toBe(3);
    expect((await as("two").query(query("listMine"), {})).active).toBeNull();
  });
  it("filters by completion date so an overnight session remains in its selected period", async () => {
    const { as, insert } = await setup();
    const now = Date.now(),
      boundary = now - 3_600_000;
    await insert(1, boundary + 1_000, "stopped", 0, boundary - 10_000);
    await insert(1, boundary - 1_000);
    const page = await as("one").query(query("listMine"), {
      since: new Date(boundary).toISOString(),
    });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].durationMs).toBe(11_000);
    expect(page.isDone).toBe(true);
    await expect(as("one").query(query("listMine"), { since: "invalid" })).rejects.toThrow();
  });
  it("keeps complete day/week totals independent of history pages and preserves each client's overnight semantics", async () => {
    const { as, insert, t } = await setup();
    const now = Date.now(),
      today = now - 3_600_000,
      week = today - 86_400_000;
    await insert(80, today + 1_000, "stopped", 0, today - 1_000);
    await insert(1, today - 1_000, "stopped", 0, week - 1_000);
    await insert(100, week - 1_000);
    await insert(30, today + 1_000, "deleted");
    await insert(30, today + 1_000, "stopped", 1);
    const args = {
      todayStart: new Date(today).toISOString(),
      weekStart: new Date(week).toISOString(),
    };
    expect(await as("one").query(query("recentTotals"), args)).toEqual({
      complete: true,
      todayMs: 160_000,
      todayClippedMs: 80_000,
      weekMs: 86_560_000,
      weekClippedMs: 86_559_000,
    });
    expect((await as("one").query(query("listMine"), {})).entries).toHaveLength(50);
    await expect(t.query(query("recentTotals"), args)).rejects.toThrow();
    await expect(
      as("one").query(query("recentTotals"), {
        ...args,
        weekStart: new Date(now - 20 * 86_400_000).toISOString(),
      }),
    ).rejects.toThrow();
  });
  it("explicitly marks totals incomplete at the bounded read ceiling while retaining paginated access", async () => {
    const { as, insert } = await setup();
    const now = Date.now(),
      today = now - 3_600_000;
    await insert(2_001, now - 1_000);
    const totals = await as("one").query(query("recentTotals"), {
      todayStart: new Date(today).toISOString(),
      weekStart: new Date(today).toISOString(),
    });
    expect(totals.complete).toBe(false);
    const page = await as("one").query(query("listMine"), {});
    expect(page.entries).toHaveLength(50);
    expect(page.isDone).toBe(false);
    expect(page.cursor).not.toBeNull();
  });
});
