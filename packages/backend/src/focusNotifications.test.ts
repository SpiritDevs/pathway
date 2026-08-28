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
  };
}

type Harness = ReturnType<typeof harness>;

async function seed({ t }: Harness) {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkSubject: "user-1",
      email: "user-1@example.test",
      displayName: "User One",
      imageUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("relayEnvironmentLinks", {
      userId: "user-1",
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
  });
}

const event = (eventId: string, createdAt = NOW) => ({
  eventId,
  environmentId: ENVIRONMENT_ID,
  environmentPublicKey: ENVIRONMENT_PUBLIC_KEY,
  threadId: `thread-${eventId}`,
  projectKey: `${ENVIRONMENT_ID}:project-a`,
  eventKind: "finished-unsettled" as const,
  createdAt,
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
    await h.relay.mutation(api.focusNotifications.record, event("unread-event", unreadCreatedAt));
    vi.setSystemTime(unreadCreatedAt + 30 * DAY - 1);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(0);
    vi.setSystemTime(unreadCreatedAt + 30 * DAY);
    await expect(h.t.mutation(internal.focusNotifications.pruneExpired, {})).resolves.toBe(1);
  });

  it("evicts the oldest event when a user exceeds two hundred notifications", async () => {
    const h = harness();
    await seed(h);
    for (let index = 0; index <= 200; index += 1) {
      await h.relay.mutation(
        api.focusNotifications.record,
        event(`event-${index.toString().padStart(3, "0")}`, NOW + index),
      );
    }

    const rows = await h.user.query(api.focusNotifications.list, { limit: 200 });
    expect(rows).toHaveLength(200);
    expect(rows.at(-1)?.eventId).toBe("event-001");
  });
});
