// @effect-diagnostics globalDate:off -- Tests control the Convex transaction clock.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const RELAY_ISSUER = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/threadAlertPolicies.ts": () => import("../convex/threadAlertPolicies.ts"),
  "../convex/focusNotifications.ts": () => import("../convex/focusNotifications.ts"),
};

const CLERK_ISSUER = "https://clerk.example.test";
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const ENVIRONMENT_ID = "environment-a";
const ENVIRONMENT_PUBLIC_KEY = "public-key-a";

function harness() {
  const t = convexTest(schema, modules);
  return {
    t,
    relay: t.withIdentity({
      issuer: RELAY_ISSUER,
      subject: "pathway-relay",
      tokenIdentifier: `${RELAY_ISSUER}|pathway-relay`,
      tokenKind: "relay-control-plane",
    }),
    user: t.withIdentity({
      issuer: CLERK_ISSUER,
      subject: "user-1",
      tokenIdentifier: `${CLERK_ISSUER}|user-1`,
    }),
    secondUser: t.withIdentity({
      issuer: CLERK_ISSUER,
      subject: "user-2",
      tokenIdentifier: `${CLERK_ISSUER}|user-2`,
    }),
  };
}

type Harness = ReturnType<typeof harness>;

async function seed({ t }: Harness, linkedUserIds: ReadonlyArray<string> = ["user-1"]) {
  await t.run(async (ctx) => {
    for (const [index, userId] of linkedUserIds.entries()) {
      await ctx.db.insert("users", {
        clerkSubject: userId,
        email: `${userId}@example.test`,
        displayName: `User ${index + 1}`,
        imageUrl: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("relayEnvironmentLinks", {
        userId,
        environmentId: ENVIRONMENT_ID,
        displayName: "Studio",
        environmentLabel: "Studio",
        environmentPublicKey: ENVIRONMENT_PUBLIC_KEY,
        endpointHttpBaseUrl: "https://environment.example.test",
        endpointWsBaseUrl: "wss://environment.example.test",
        endpointProviderKind: "pathway_relay",
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
        createdByDeviceId: null,
        revokedAt: null,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      });
    }
  });
}

const event = (eventId: string) => ({
  eventId,
  environmentId: ENVIRONMENT_ID,
  environmentPublicKey: ENVIRONMENT_PUBLIC_KEY,
  threadId: `thread-${eventId}`,
  projectKey: `${ENVIRONMENT_ID}:project-a`,
  eventKind: "finished-unsettled" as const,
});

describe("Focus notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("records once per relay event and clears unread state with one shared watermark", async () => {
    const h = harness();
    await seed(h);

    await expect(
      h.user.mutation(api.focusNotifications.record, event("user-authored")),
    ).rejects.toThrow("reserved for the relay control plane");
    await expect(h.relay.mutation(api.focusNotifications.record, event("event-1"))).resolves.toBe(
      1,
    );
    await expect(h.relay.mutation(api.focusNotifications.record, event("event-1"))).resolves.toBe(
      0,
    );
    await expect(h.user.query(api.focusNotifications.unreadCount, {})).resolves.toBe(1);
    await expect(h.user.query(api.focusNotifications.list, {})).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", threadId: "thread-event-1" }),
    ]);

    await h.user.mutation(api.focusNotifications.markAllRead, {});
    await expect(h.user.query(api.focusNotifications.unreadCount, {})).resolves.toBe(0);
  });

  it("clears read and unread notifications only for the signed-in user", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await h.relay.mutation(api.focusNotifications.record, event("read"));
    await h.relay.mutation(api.focusNotifications.record, event("unread"));
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "read" });
    await expect(h.t.mutation(api.focusNotifications.clearAll, {})).rejects.toThrow();
    await h.user.mutation(api.focusNotifications.clearAll, {});
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([]);
    expect(await h.user.query(api.focusNotifications.unreadCount, {})).toBe(0);
    expect(await h.secondUser.query(api.focusNotifications.list, {})).toHaveLength(2);
    expect(
      await h.t.run((ctx) => ctx.db.query("focusNotificationAcknowledgements").collect()),
    ).toEqual([]);
    await h.user.mutation(api.focusNotifications.clearAll, {});
    await h.relay.mutation(api.focusNotifications.record, event("new"));
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({ eventId: "new", isRead: false }),
    ]);
  });

  it("tracks tray opens separately from reads and counts later events as unseen", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await h.relay.mutation(api.focusNotifications.record, event("first"));
    await expect(h.t.mutation(api.focusNotifications.markAllSeen, {})).rejects.toThrow();
    await h.user.mutation(api.focusNotifications.markAllSeen, {});
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({ eventId: "first", isRead: false, isSeen: true }),
    ]);
    expect(await h.user.query(api.focusNotifications.unreadCount, {})).toBe(1);
    expect(await h.secondUser.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({ isSeen: false }),
    ]);
    await h.relay.mutation(api.focusNotifications.record, event("second"));
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({ eventId: "second", isRead: false, isSeen: false }),
      expect.objectContaining({ eventId: "first", isRead: false, isSeen: true }),
    ]);
    await h.user.mutation(api.focusNotifications.markAllSeen, {});
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "first" });
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "second" });
    expect(
      (await h.user.query(api.focusNotifications.list, {})).every(
        (row) => row.isRead && row.isSeen,
      ),
    ).toBe(true);
    await h.user.mutation(api.focusNotifications.clearAll, {});
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([]);
  });

  it("fans one relay event out to every linked user", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);

    await expect(h.relay.mutation(api.focusNotifications.record, event("fanout"))).resolves.toBe(2);
    await expect(h.relay.mutation(api.focusNotifications.record, event("fanout"))).resolves.toBe(0);
    await expect(h.user.query(api.focusNotifications.unreadCount, {})).resolves.toBe(1);
    await expect(h.secondUser.query(api.focusNotifications.unreadCount, {})).resolves.toBe(1);
    await expect(
      h.t.run(async (ctx) => ctx.db.query("focusNotifications").collect()),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user-1", eventId: "fanout" }),
        expect.objectContaining({ userId: "user-2", eventId: "fanout" }),
      ]),
    );
  });

  it("stamps records from the transaction clock above the read watermark", async () => {
    const h = harness();
    await seed(h);

    await h.relay.mutation(api.focusNotifications.record, event("first"));
    await h.user.mutation(api.focusNotifications.markAllRead, {});
    await h.relay.mutation(api.focusNotifications.record, event("after-watermark"));

    await expect(h.user.query(api.focusNotifications.unreadCount, {})).resolves.toBe(1);
    await expect(h.user.query(api.focusNotifications.list, {})).resolves.toEqual([
      expect.objectContaining({ eventId: "after-watermark", createdAt: NOW + 1 }),
      expect.objectContaining({ eventId: "first", createdAt: NOW }),
    ]);
  });

  it("retains read events for seven days and unread events for thirty days", async () => {
    const h = harness();
    await seed(h);
    await h.relay.mutation(api.focusNotifications.record, event("read-event"));
    await h.user.mutation(api.focusNotifications.markAllRead, {});

    vi.setSystemTime(NOW + 7 * DAY - 1);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(0);
    vi.setSystemTime(NOW + 7 * DAY);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(1);

    const unreadCreatedAt = NOW + 7 * DAY + 1;
    vi.setSystemTime(unreadCreatedAt);
    await h.relay.mutation(api.focusNotifications.record, event("unread-event"));
    vi.setSystemTime(unreadCreatedAt + 30 * DAY - 1);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(0);
    vi.setSystemTime(unreadCreatedAt + 30 * DAY);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(1);
  });

  it("evicts the oldest event and lists the full retained log by default", async () => {
    const h = harness();
    await seed(h);
    for (let index = 0; index <= 200; index += 1) {
      vi.setSystemTime(NOW + index);
      await h.relay.mutation(
        api.focusNotifications.record,
        event(`event-${index.toString().padStart(3, "0")}`),
      );
      if (index === 0)
        await h.user.mutation(api.focusNotifications.markRead, { eventId: "event-000" });
      if (index === 99) await h.user.mutation(api.focusNotifications.markAllRead, {});
    }

    const rows = await h.user.query(api.focusNotifications.list, {});
    expect(rows).toHaveLength(200);
    expect(rows.at(-1)?.eventId).toBe("event-001");
    await expect(h.user.query(api.focusNotifications.unreadCount, {})).resolves.toBe(101);
    await expect(
      h.t.run(async (ctx) =>
        ctx.db
          .query("focusNotificationStates")
          .withIndex("by_user", (q) => q.eq("userId", "user-1"))
          .unique(),
      ),
    ).resolves.toEqual(expect.objectContaining({ nextCleanupAt: NOW + 1 + 7 * DAY }));
  });
  it("snapshots inherited policy per linked user without filtering muted events", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "global",
      scopeKey: "global",
      choices: { completion: true, permission: false, input: false, failure: false },
    });
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "project",
      scopeKey: "github.com/spiritdevs/pathway",
      choices: { completion: false, permission: true },
    });
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "thread",
      scopeKey: `environment:${ENVIRONMENT_ID}:thread:thread-enabled`,
      choices: { completion: true },
    });
    await h.relay.mutation(api.focusNotifications.record, {
      ...event("muted"),
      alertProjectKey: "github.com/spiritdevs/pathway",
    });
    await h.relay.mutation(api.focusNotifications.record, {
      ...event("enabled"),
      alertProjectKey: "github.com/spiritdevs/pathway",
    });
    await h.relay.mutation(api.focusNotifications.record, {
      ...event("permission"),
      alertProjectKey: "github.com/spiritdevs/pathway",
      eventKind: "pending-approval",
    });
    const rows = await h.user.query(api.focusNotifications.list, {});
    expect(new Map(rows.map((row) => [row.eventId, row.alertEligibleAtCreation]))).toEqual(
      new Map([
        ["muted", false],
        ["enabled", true],
        ["permission", true],
      ]),
    );
    expect(await h.secondUser.query(api.focusNotifications.list, {})).toHaveLength(3);
    expect(
      (await h.secondUser.query(api.focusNotifications.list, {})).every(
        (row) => !row.alertEligibleAtCreation,
      ),
    ).toBe(true);
    await h.user.mutation(api.threadAlertPolicies.reset, {
      scopeKind: "project",
      scopeKey: "github.com/spiritdevs/pathway",
    });
    await h.relay.mutation(api.focusNotifications.record, {
      ...event("muted"),
      alertProjectKey: "github.com/spiritdevs/pathway",
    });
    expect(
      (await h.user.query(api.focusNotifications.list, {})).find((row) => row.eventId === "muted")
        ?.alertEligibleAtCreation,
    ).toBe(false);
  });

  it("uses environment-scoped policy when an older environment omits repository identity", async () => {
    const h = harness();
    await seed(h);
    const scopeKey = `environment:${ENVIRONMENT_ID}:project:project-a`;
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "project",
      scopeKey,
      choices: { completion: true },
    });
    await h.relay.mutation(api.focusNotifications.record, event("legacy"));
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({
        alertProjectKey: scopeKey,
        alertEligibleAtCreation: true,
        isRead: false,
      }),
    ]);
  });

  it("keeps policy writes user-owned, scoped, and reversible", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await expect(
      h.t.mutation(api.threadAlertPolicies.upsert, {
        scopeKind: "project",
        scopeKey: "repo",
        choices: { completion: true },
      }),
    ).rejects.toThrow();
    await expect(
      h.user.mutation(api.threadAlertPolicies.upsert, {
        scopeKind: "global",
        scopeKey: "global",
        choices: { completion: true },
      }),
    ).rejects.toThrow("all four");
    await expect(
      h.user.mutation(api.threadAlertPolicies.upsert, {
        scopeKind: "global",
        scopeKey: "other",
        choices: {},
      }),
    ).rejects.toThrow("global key");
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "project",
      scopeKey: "repo",
      choices: { completion: true, failure: false },
    });
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "project",
      scopeKey: "repo",
      choices: { input: true },
    });
    expect(
      await h.user.query(api.threadAlertPolicies.list, {
        projectKeys: ["repo", "repo"],
        threadKeys: [],
      }),
    ).toEqual([{ scopeKind: "project", scopeKey: "repo", choices: { input: true } }]);
    expect(
      await h.secondUser.query(api.threadAlertPolicies.list, {
        projectKeys: ["repo"],
        threadKeys: [],
      }),
    ).toEqual([]);
    expect(
      await h.user.query(api.threadAlertPolicies.list, { projectKeys: [], threadKeys: [] }),
    ).toEqual([]);
    await h.user.mutation(api.threadAlertPolicies.upsert, {
      scopeKind: "project",
      scopeKey: "repo",
      choices: {},
    });
    expect(
      await h.user.query(api.threadAlertPolicies.list, { projectKeys: ["repo"], threadKeys: [] }),
    ).toEqual([]);
  });

  it("acknowledges only an owned event, idempotently, and clears acknowledgements on mark all read", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await h.relay.mutation(api.focusNotifications.record, event("first"));
    await h.relay.mutation(api.focusNotifications.record, event("second"));
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "first" });
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "first" });
    await expect(
      h.user.mutation(api.focusNotifications.markRead, { eventId: "missing" }),
    ).rejects.toThrow("not available");
    expect(await h.user.query(api.focusNotifications.unreadCount, {})).toBe(1);
    expect(await h.secondUser.query(api.focusNotifications.unreadCount, {})).toBe(2);
    expect(
      (await h.user.query(api.focusNotifications.list, {})).find((row) => row.eventId === "first")
        ?.isRead,
    ).toBe(true);
    expect(
      await h.t.run((ctx) => ctx.db.query("focusNotificationAcknowledgements").collect()),
    ).toHaveLength(1);
    await h.user.mutation(api.focusNotifications.markAllRead, {});
    expect(
      await h.t.run((ctx) => ctx.db.query("focusNotificationAcknowledgements").collect()),
    ).toHaveLength(0);
    expect(await h.user.query(api.focusNotifications.unreadCount, {})).toBe(0);
  });

  it("prunes individually read events and their acknowledgements at seven days", async () => {
    const h = harness();
    await seed(h);
    await h.relay.mutation(api.focusNotifications.record, event("read"));
    await h.relay.mutation(api.focusNotifications.record, event("unread"));
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "read" });
    vi.setSystemTime(NOW + 7 * DAY);
    expect(await h.t.mutation(internal.focusNotifications.pruneExpired, {})).toBe(1);
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({ eventId: "unread", isRead: false }),
    ]);
    expect(
      await h.t.run((ctx) => ctx.db.query("focusNotificationAcknowledgements").collect()),
    ).toEqual([]);
  });
  it("keeps historical rows ineligible and rejects acknowledgement of another user's event", async () => {
    const h = harness();
    await seed(h, ["user-1", "user-2"]);
    await h.t.run(async (ctx) => {
      await ctx.db.insert("focusNotifications", {
        ...event("legacy-row"),
        userId: "user-1",
        createdAt: NOW,
      });
    });
    expect(await h.user.query(api.focusNotifications.list, {})).toEqual([
      expect.objectContaining({
        eventId: "legacy-row",
        alertEligibleAtCreation: false,
        isRead: false,
      }),
    ]);
    await expect(
      h.secondUser.mutation(api.focusNotifications.markRead, { eventId: "legacy-row" }),
    ).rejects.toThrow("not available");
    await h.user.mutation(api.focusNotifications.markRead, { eventId: "legacy-row" });
    expect(await h.user.query(api.focusNotifications.unreadCount, {})).toBe(0);
  });
});
