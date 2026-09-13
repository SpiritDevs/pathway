// @effect-diagnostics globalDate:off -- Test clock defines activity boundaries.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";
import { anyApi, type ApiFromModules } from "convex/server";
import type * as timeTracking from "../convex/timeTracking.ts";
const api = anyApi as unknown as ApiFromModules<{ timeTracking: typeof timeTracking }>;
import schema from "../convex/schema.ts";
import { recordIssueSession } from "../convex/lib/trackedTime.ts";

const RELAY = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY}/.well-known/jwks.json`;
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/timeTracking.ts": () => import("../convex/timeTracking.ts"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkSubject: "one",
      email: "one@example.test",
      displayName: "One",
      imageUrl: null,
      createdAt: now,
      updatedAt: now,
    });
    const companyId = await ctx.db.insert("companies", {
      id: "company",
      name: "Company",
      issueKeyPrefix: "CO",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = await ctx.db.insert("memberships", {
      id: "member",
      companyId,
      userId,
      state: "active",
      displayNameSnapshot: "One",
      emailSnapshot: "one@example.test",
      invitedByMembershipId: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("roles", {
      id: "service-role",
      companyId,
      name: "Environment",
      description: "",
      permissions: ["projects.manage"],
      seeded: false,
      createdAt: now,
      updatedAt: now,
    });
    const registrationId = await ctx.db.insert("environmentRegistrations", {
      id: "registration",
      companyId,
      environmentId: "env",
      publicKeyThumbprint: "proof",
      descriptor: {},
      relayLinkState: "linked",
      managedEndpointAvailable: true,
      lastSeenAt: now,
      serviceRoleIds: ["service-role"],
      teamIds: [],
      state: "active",
      registeredByMembershipId: membershipId,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("cloudProjects", {
      id: "project",
      companyId,
      name: "Project",
      description: "",
      teamIds: [],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const bindingId = await ctx.db.insert("environmentBindings", {
      id: "binding",
      companyId,
      cloudProjectId: projectId,
      environmentId: "env",
      localProjectId: "local-project",
      localWorkspaceRoot: "/workspace",
      status: "active",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, companyId, membershipId, registrationId, bindingId, projectId };
  });
  const user = t.withIdentity({
    subject: "one",
    issuer: "https://clerk.example.test",
    tokenIdentifier: "https://clerk.example.test|one",
  });
  const environment = t.withIdentity({
    subject: "env",
    issuer: RELAY,
    tokenIdentifier: `${RELAY}|env`,
    cnf: { jkt: "proof" },
  });
  const snapshot = (id: string, start: number, end: number) => ({
    companyId: "company",
    session: {
      id,
      threadId: id,
      localProjectId: "local-project",
      description: `Thread ${id}`,
      startedAt: new Date(start).toISOString(),
      stoppedAt: new Date(end).toISOString() as string | null,
      state: "stopped" as "running" | "paused" | "stopped",
      intervals: [{ start, end }],
      runningSince: null as number | null,
      observedAt: end,
      revision: 1,
    },
  });
  return { t, ids, user, environment, snapshot };
}

describe("Automatic tracked activities", () => {
  it("shows working and input-blocked runs without listing queued follow-ups as paused timers", async () => {
    const { user, environment, snapshot } = await setup();
    const now = Date.now();
    const active = snapshot("active", now - 60_000, now);
    active.session.state = "running";
    active.session.stoppedAt = null;
    active.session.intervals = [];
    active.session.runningSince = now - 60_000;
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...active,
      session: { ...active.session, runStatus: "running" },
    });
    const followUp = snapshot("follow-up", now - 30_000, now);
    followUp.session.threadId = active.session.threadId;
    followUp.session.state = "paused";
    followUp.session.stoppedAt = null;
    followUp.session.intervals = [];
    for (const [index, runStatus] of ["queued", "preparing", "starting"].entries()) {
      await environment.mutation(api.timeTracking.syncAgentSession, {
        ...followUp,
        session: { ...followUp.session, runStatus, revision: index + 1 },
      });
      const timers = await user.query(api.timeTracking.listActive, {});
      expect(timers.complete).toBe(true);
      expect(timers.sessions).toHaveLength(1);
      expect(timers.sessions[0]).toMatchObject({ state: "running", runningSince: now - 60_000 });
    }
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...active,
      session: {
        ...active.session,
        state: "stopped",
        stoppedAt: new Date(now).toISOString(),
        runningSince: null,
        intervals: [{ start: now - 60_000, end: now }],
        revision: 2,
        runStatus: "completed",
      },
    });
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...followUp,
      session: {
        ...followUp.session,
        runStatus: "running",
        state: "running",
        runningSince: now,
        revision: 4,
      },
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toMatchObject([
      { state: "running", runningSince: now },
    ]);
    // A real blocking request can pause immediately, before any duration accumulates.
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...followUp,
      session: { ...followUp.session, runStatus: "running", revision: 5 },
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toMatchObject([
      { state: "paused", durationMs: 0 },
    ]);
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...followUp,
      session: { ...followUp.session, runStatus: "waiting", revision: 6 },
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toEqual([]);
  });

  it("accepts snapshots from older environments without retaining a stale queued status", async () => {
    const { user, environment, snapshot } = await setup();
    const now = Date.now();
    const input = snapshot("legacy", now - 60_000, now);
    input.session.state = "paused";
    input.session.stoppedAt = null;
    input.session.intervals = [];
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...input,
      session: { ...input.session, runStatus: "queued" },
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toEqual([]);
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...input,
      session: { ...input.session, revision: 2 },
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toMatchObject([
      { state: "paused" },
    ]);
  });

  it("updates completed summaries and retains source links without changing duration", async () => {
    const { user, environment, snapshot } = await setup();
    const end = Date.now();
    const input = snapshot("summary", end - 60000, end);
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    await environment.mutation(api.timeTracking.syncAgentSession, {
      ...input,
      session: {
        ...input.session,
        revision: 2,
        title: "Repair project selection",
        description: "Updated the selector and verified the fallback.",
      },
    });
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    const entry = (await user.query(api.timeTracking.listMine, {})).entries[0];
    expect(entry).toMatchObject({
      title: "Repair project selection",
      description: "Updated the selector and verified the fallback.",
      durationMs: 60000,
      environmentId: "env",
      threadId: input.session.threadId,
    });
  });

  it("sums eight concurrent agents while elapsed activity uses their union, and replay is idempotent", async () => {
    const { user, environment, snapshot } = await setup();
    const end = Date.now(),
      start = end - 30 * 60_000;
    for (let i = 0; i < 8; i++) {
      const input = snapshot(`run-${i}`, start, end);
      expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
        outcome: "published",
      });
      expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
        outcome: "unchanged",
      });
    }
    const overview = await user.query(api.timeTracking.overview, {
      since: new Date(start).toISOString(),
      until: new Date(end + 1).toISOString(),
    });
    expect((await user.query(api.timeTracking.listMine, {})).entries).toHaveLength(8);
    expect(overview.totals).toEqual({
      workMs: 4 * 3_600_000,
      elapsedMs: 30 * 60_000,
      agentMs: 4 * 3_600_000,
      manualMs: 0,
      issueMs: 0,
    });
    expect(overview.projects[0]?.projectKey).toBe("project");
    expect(overview.days.reduce((sum, day) => sum + day.workMs, 0)).toBe(overview.totals.workMs);
  });

  it("excludes blocked gaps, ignores older snapshots, and permits one manual timer beside active agents", async () => {
    const { user, environment, snapshot } = await setup();
    const now = Date.now(),
      start = now - 600_000;
    const input = snapshot("run", start, now);
    input.session.intervals = [
      { start, end: start + 60_000 },
      { start: now - 60_000, end: now },
    ];
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    const old = snapshot("run", start, now);
    old.session.revision = 0;
    expect(await environment.mutation(api.timeTracking.syncAgentSession, old)).toEqual({
      outcome: "unchanged",
    });
    const paused = snapshot("paused", start, now);
    paused.session.state = "paused";
    paused.session.stoppedAt = null;
    paused.session.intervals = [{ start, end: start + 60_000 }];
    await environment.mutation(api.timeTracking.syncAgentSession, paused);
    const running = snapshot("running", start, now);
    running.session.state = "running";
    running.session.stoppedAt = null;
    running.session.intervals = [];
    running.session.runningSince = now;
    await environment.mutation(api.timeTracking.syncAgentSession, running);
    await user.mutation(api.timeTracking.start, {
      id: "manual",
      description: "Manual",
      projectKey: "project",
      projectName: "Project",
    });
    await expect(
      user.mutation(api.timeTracking.start, {
        id: "manual2",
        description: "Manual",
        projectKey: "project",
        projectName: "Project",
      }),
    ).rejects.toThrow();
    const active = await user.query(api.timeTracking.listActive, {});
    expect(active.sessions).toHaveLength(3);
    expect((await user.query(api.timeTracking.listMine, {})).active?.id).toBe("manual");
    const history = await user.query(api.timeTracking.overview, {
      since: new Date(start).toISOString(),
      until: new Date(now).toISOString(),
    });
    expect(history.totals.agentMs).toBe(180_000);
    expect(history.totals.elapsedMs).toBe(120_000);
    expect(
      (
        await user.query(api.timeTracking.recentTotals, {
          todayStart: new Date(start).toISOString(),
          weekStart: new Date(start).toISOString(),
        })
      ).todayClippedMs,
    ).toBe(120_000);
  });

  it("records one-minute issue credit without inventing elapsed time and attributes measured composition across day boundaries", async () => {
    const { t, ids, user } = await setup();
    const now = Date.now();
    const base = {
      userId: ids.userId,
      companyId: ids.companyId,
      description: "Task",
      projectKey: "project",
      projectName: "Project",
    };
    await t.run(async (ctx) => {
      await recordIssueSession(ctx, { ...base, issueId: "short" });
      await recordIssueSession(ctx, { ...base, issueId: "short" });
      await recordIssueSession(ctx, {
        ...base,
        issueId: "long",
        activeIntervals: [
          { start: now - 300_000, end: now - 180_000 },
          { start: now - 120_000, end: now },
        ],
      });
    });
    const overview = await user.query(api.timeTracking.overview, {
      since: new Date(now - 600_000).toISOString(),
      until: new Date(now + 60_000).toISOString(),
    });
    expect((await user.query(api.timeTracking.listMine, {})).entries).toHaveLength(2);
    expect(overview.totals).toEqual({
      workMs: 300_000,
      elapsedMs: 240_000,
      issueMs: 300_000,
      manualMs: 0,
      agentMs: 0,
    });
    expect(overview.days.reduce((sum, day) => sum + day.issueMs, 0)).toBe(300_000);
  });

  it("caps stale running agents at the activity lease instead of counting a disconnected environment forever", async () => {
    const { user, environment, snapshot } = await setup();
    const now = Date.now(),
      observedAt = now - 600_000;
    const input = snapshot("run", observedAt - 60_000, observedAt);
    input.session.state = "running";
    input.session.stoppedAt = null;
    input.session.intervals = [];
    input.session.runningSince = observedAt - 60_000;
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    const overview = await user.query(api.timeTracking.overview, {
      since: new Date(now - 900_000).toISOString(),
      until: new Date(now + 1).toISOString(),
    });
    expect(overview.totals.agentMs).toBe(150_000);
  });

  it("rejects unauthenticated, human, wrong-key, revoked, and malformed agent snapshots", async () => {
    const { t, ids, user, environment, snapshot } = await setup();
    const now = Date.now(),
      input = snapshot("run", now - 60_000, now);
    await expect(t.mutation(api.timeTracking.syncAgentSession, input)).rejects.toThrow();
    await expect(user.mutation(api.timeTracking.syncAgentSession, input)).rejects.toThrow();
    const wrongKey = t.withIdentity({
      subject: "env",
      issuer: RELAY,
      tokenIdentifier: `${RELAY}|env`,
      cnf: { jkt: "other" },
    });
    await expect(wrongKey.mutation(api.timeTracking.syncAgentSession, input)).rejects.toThrow();
    input.session.intervals.push({ start: now - 30_000, end: now });
    await expect(environment.mutation(api.timeTracking.syncAgentSession, input)).rejects.toThrow();
    await t.run((ctx) => ctx.db.patch(ids.registrationId, { state: "revoked" }));
    await expect(
      environment.mutation(api.timeTracking.syncAgentSession, snapshot("run", now - 60_000, now)),
    ).rejects.toThrow();
  });

  it.each(["revoked binding", "deleted project"])(
    "finalizes existing agent time after a %s without reopening or changing its identity",
    async (removed) => {
      const { t, ids, user, environment, snapshot } = await setup();
      const now = Date.now(),
        start = now - 120_000;
      const input = snapshot("finishing", start, now - 60_000);
      input.session.state = "running";
      input.session.stoppedAt = null;
      input.session.intervals = [];
      input.session.runningSince = start;
      await environment.mutation(api.timeTracking.syncAgentSession, input);
      await t.run(async (ctx) => {
        if (removed === "revoked binding") await ctx.db.patch(ids.bindingId, { status: "revoked" });
        else await ctx.db.delete(ids.projectId);
      });
      input.session.revision = 2;
      expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
        outcome: "unbound",
      });
      const final = snapshot("finishing", start, now);
      final.session.revision = 3;
      final.session.description = "Should not replace the original attribution";
      await expect(
        environment.mutation(api.timeTracking.syncAgentSession, {
          ...final,
          session: { ...final.session, threadId: "another-thread" },
        }),
      ).rejects.toThrow("original activity identity");
      await expect(
        environment.mutation(api.timeTracking.syncAgentSession, {
          ...final,
          session: { ...final.session, localProjectId: "another-project" },
        }),
      ).rejects.toThrow("original activity identity");
      const wrongKey = t.withIdentity({
        subject: "env",
        issuer: RELAY,
        tokenIdentifier: `${RELAY}|env`,
        cnf: { jkt: "wrong" },
      });
      await expect(wrongKey.mutation(api.timeTracking.syncAgentSession, final)).rejects.toThrow();
      expect(await environment.mutation(api.timeTracking.syncAgentSession, final)).toEqual({
        outcome: "published",
      });
      expect(await environment.mutation(api.timeTracking.syncAgentSession, final)).toEqual({
        outcome: "unchanged",
      });
      expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
        outcome: "unchanged",
      });
      input.session.revision = 4;
      expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
        outcome: "unchanged",
      });
      expect(
        await environment.mutation(
          api.timeTracking.syncAgentSession,
          snapshot("new-unbound", start, now),
        ),
      ).toEqual({ outcome: "unbound" });
      expect((await user.query(api.timeTracking.listActive, {})).sessions).toEqual([]);
      const entries = (await user.query(api.timeTracking.listMine, {})).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        description: "Thread finishing",
        projectKey: "project",
        projectName: "Project",
        durationMs: 120_000,
        stoppedAt: new Date(now).toISOString(),
      });
    },
  );

  it("keeps the original account when registration ownership changes and only the original environment can finalize", async () => {
    const { t, ids, user, environment, snapshot } = await setup();
    const now = Date.now(),
      start = now - 120_000;
    const input = snapshot("legacy", start, now - 60_000);
    input.session.state = "running";
    input.session.stoppedAt = null;
    input.session.intervals = [];
    input.session.runningSince = start;
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("trackedSessions").collect())[0]!;
      await ctx.db.patch(row._id, { localProjectId: undefined });
      const userId = await ctx.db.insert("users", {
        clerkSubject: "two",
        email: "two@example.test",
        displayName: "Two",
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("memberships", {
        id: "other-member",
        companyId: ids.companyId,
        userId,
        state: "active",
        displayNameSnapshot: "Two",
        emailSnapshot: "two@example.test",
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(ids.registrationId, { registeredByMembershipId: membershipId });
      await ctx.db.patch(ids.membershipId, { state: "left" });
      await ctx.db.insert("environmentRegistrations", {
        id: "other-registration",
        companyId: ids.companyId,
        environmentId: "other-env",
        publicKeyThumbprint: "other-proof",
        descriptor: {},
        relayLinkState: "linked",
        managedEndpointAvailable: true,
        lastSeenAt: now,
        serviceRoleIds: ["service-role"],
        teamIds: [],
        state: "active",
        registeredByMembershipId: membershipId,
        createdAt: now,
        updatedAt: now,
      });
    });
    input.session.revision = 2;
    expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
      outcome: "published",
    });
    const otherUser = t.withIdentity({
      subject: "two",
      issuer: "https://clerk.example.test",
      tokenIdentifier: "https://clerk.example.test|two",
    });
    expect((await otherUser.query(api.timeTracking.listActive, {})).sessions).toEqual([]);
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(ids.bindingId, { status: "revoked" }));
    const final = snapshot("legacy", start, now);
    final.session.revision = 3;
    const otherEnvironment = t.withIdentity({
      subject: "other-env",
      issuer: RELAY,
      tokenIdentifier: `${RELAY}|other-env`,
      cnf: { jkt: "other-proof" },
    });
    expect(await otherEnvironment.mutation(api.timeTracking.syncAgentSession, final)).toEqual({
      outcome: "unbound",
    });
    expect((await user.query(api.timeTracking.listActive, {})).sessions).toHaveLength(1);
    expect(await environment.mutation(api.timeTracking.syncAgentSession, final)).toEqual({
      outcome: "published",
    });
    expect((await user.query(api.timeTracking.listMine, {})).entries).toHaveLength(1);
    expect((await otherUser.query(api.timeTracking.listMine, {})).entries).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("trackedSessions").collect())).toHaveLength(1);
  });

  it("does not resurrect deleted records or accept sessions from unbound projects", async () => {
    const { t, ids, user, environment, snapshot } = await setup();
    const now = Date.now(),
      input = snapshot("run", now - 60_000, now);
    await environment.mutation(api.timeTracking.syncAgentSession, input);
    const entry = (await user.query(api.timeTracking.listMine, {})).entries[0]!;
    await user.mutation(api.timeTracking.remove, { id: entry.id });
    input.session.revision++;
    expect(await environment.mutation(api.timeTracking.syncAgentSession, input)).toEqual({
      outcome: "unchanged",
    });
    await t.run((ctx) => ctx.db.patch(ids.bindingId, { status: "revoked" }));
    expect(
      await environment.mutation(
        api.timeTracking.syncAgentSession,
        snapshot("other", now - 60_000, now),
      ),
    ).toEqual({ outcome: "unbound" });
  });
});

describe("Time tracking calendar boundaries", () => {
  it("uses actual local midnights across daylight saving instead of fixed 24-hour buckets", async () => {
    const { user, environment, snapshot } = await setup();
    const first = Date.parse("2026-04-03T13:00:00Z");
    const second = Date.parse("2026-04-04T13:00:00Z");
    const third = Date.parse("2026-04-05T14:00:00Z");
    await environment.mutation(
      api.timeTracking.syncAgentSession,
      snapshot("dst", second - 1_800_000, third),
    );
    const overview = await user.query(api.timeTracking.overview, {
      since: new Date(first).toISOString(),
      until: new Date(third).toISOString(),
      dayBoundaries: [
        { date: "2026-04-04", start: first, end: second },
        { date: "2026-04-05", start: second, end: third },
      ],
    });
    expect(overview.days.map(({ date, workMs }) => ({ date, workMs }))).toEqual([
      { date: "2026-04-04", workMs: 1_800_000 },
      { date: "2026-04-05", workMs: 25 * 3_600_000 },
    ]);
    expect(overview.days.reduce((sum, day) => sum + day.workMs, 0)).toBe(overview.totals.workMs);
    await expect(
      user.query(api.timeTracking.overview, {
        since: new Date(first).toISOString(),
        until: new Date(third).toISOString(),
        dayBoundaries: [{ date: "2026-04-05", start: second, end: third }],
      }),
    ).rejects.toThrow();
  });
});
