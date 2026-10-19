// @effect-diagnostics globalDate:off -- Test fixtures exercise deterministic Convex lease time.
import { convexTest } from "convex-test";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";
const RELAY = "https://relay.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY}/.well-known/jwks.json`;
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/mail.ts": () => import("../convex/mail.ts"),
  "../convex/mailJobs.ts": () => import("../convex/mailJobs.ts"),
  "../convex/mailRelay.ts": () => import("../convex/mailRelay.ts"),
};
const COMPANY = "mail-company";
function harness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof harness>;
function human(t: Harness, subject = "owner") {
  return t.withIdentity({
    issuer: "https://clerk.example.test",
    subject,
    tokenIdentifier: `clerk|${subject}`,
  });
}
function relay(t: Harness) {
  return t.withIdentity({
    issuer: RELAY,
    subject: "pathway-relay",
    tokenKind: "relay-control-plane",
    tokenIdentifier: "relay|control",
  });
}
function environment(t: Harness, id = "primary") {
  return t.withIdentity({
    issuer: RELAY,
    subject: id,
    cnf: { jkt: `key-${id}` },
    tokenIdentifier: `relay|${id}`,
  });
}
async function seed(t: Harness) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", {
      id: COMPANY,
      name: "Mail",
      issueKeyPrefix: "MAIL",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const subject of ["owner", "colleague"]) {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("memberships", {
        id: `membership-${subject}`,
        companyId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const id of ["primary", "backup", "unselected"]) {
      await ctx.db.insert("environmentRegistrations", {
        id: `registration-${id}`,
        companyId,
        environmentId: id,
        publicKeyThumbprint: `key-${id}`,
        descriptor: {},
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
    }
  });
  const account = await relay(t).mutation(api.mailRelay.connectAccount, {
    companyId: COMPANY,
    ownerSubject: "owner",
    email: "owner@gmail.test",
    encryptedCredentials: "encrypted-only",
    oauthClientId: "client-a",
    credentialSource: "byo",
  });
  await human(t).mutation(api.mail.configureBrain, {
    companyId: COMPANY,
    accountId: account.id,
    brain: {
      primaryEnvironmentId: "primary",
      backupEnvironmentId: "backup",
      selection: { instanceId: "claude", model: "sonnet" },
      backupSelection: { instanceId: "codex", model: "gpt" },
    },
  });
  return account.id;
}
const sample = (id = "gmail-1") => ({
  providerMessageId: id,
  providerThreadId: "gmail-thread",
  historyId: "100",
  from: { email: "sender@example.test", name: "Sender" },
  to: ["owner@gmail.test"],
  cc: [],
  subject: "Please review",
  snippet: "Review this today",
  receivedAt: 1_700_000_000_000,
  labels: ["INBOX", "UNREAD"],
  textBody: "Review this today",
  attachments: [],
});
async function intake(t: Harness, accountId: string, ids = ["gmail-1"]) {
  const claim = await relay(t).mutation(api.mailRelay.claimSync, { accountId, leaseToken: "sync" });
  if (!claim) throw new Error("sync claim missing");
  const args = { accountId, leaseToken: "sync", generation: claim.generation };
  await relay(t).mutation(api.mailRelay.ingestPage, { ...args, messages: ids.map(sample) });
  await relay(t).mutation(api.mailRelay.finishSync, { ...args, cursor: "100" });
  return (await human(t).query(api.mail.listMessages, { companyId: COMPANY, accountId })).messages;
}
afterEach(() => vi.useRealTimers());
async function draftRequest() {
  const t = harness();
  const accountId = await seed(t);
  const [message] = await intake(t, accountId);
  const jobId = await human(t).mutation(api.mail.requestDraft, {
    companyId: COMPANY,
    messageId: message!.id,
    instructions: "Keep it short",
  });
  return { t, accountId, message: message!, jobId };
}
describe("draft generation visibility", () => {
  it("shows queued, running and failed requests to only the owner, then retries with original instructions", async () => {
    const { t, accountId, jobId } = await draftRequest();
    const list = async () =>
      (await human(t).query(api.mail.listDraftJobs, { companyId: COMPANY, accountId })).jobs;
    expect(await list()).toMatchObject([
      { id: jobId, status: "pending", subject: "Please review" },
    ]);
    await expect(
      human(t, "colleague").query(api.mail.listDraftJobs, { companyId: COMPANY, accountId }),
    ).rejects.toThrow("another member");
    const job = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(job?.id).toBe(jobId);
    expect(await list()).toMatchObject([{ status: "running" }]);
    await environment(t).mutation(api.mailJobs.fail, {
      companyId: COMPANY,
      jobId,
      generation: job!.generation,
      error: "Provider unavailable",
    });
    expect(await list()).toMatchObject([{ status: "failed", lastError: "Provider unavailable" }]);
    await expect(
      human(t, "colleague").mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId }),
    ).rejects.toThrow("another member");
    await human(t).mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId });
    expect(await list()).toMatchObject([{ status: "pending" }]);
    expect((await list())[0]?.lastError).toBeUndefined();
    await expect(
      human(t).mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId }),
    ).rejects.toThrow("not failed");
    const retry = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(retry).toMatchObject({
      id: jobId,
      instructions: "Keep it short",
      generation: job!.generation + 1,
    });
    expect(
      await environment(t).mutation(api.mailJobs.complete, {
        companyId: COMPANY,
        jobId,
        generation: job!.generation,
        result: {
          bucket: "priority",
          reason: "reply",
          draft: { to: [], subject: "Re: review", text: "Old result" },
        },
      }),
    ).toBe(false);
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId,
      generation: retry!.generation,
      result: {
        bucket: "priority",
        reason: "reply",
        draft: { to: [], subject: "Re: review", text: "Thanks" },
      },
    });
    expect(await list()).toEqual([]);
    expect(
      await human(t).query(api.mail.listDrafts, { companyId: COMPANY, accountId }),
    ).toMatchObject([{ text: "Thanks" }]);
  });
  it("exposes repeated interruption without changing message analysis and resets the attempt budget on retry", async () => {
    vi.useFakeTimers();
    const { t, accountId, jobId, message } = await draftRequest();
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
      expect(claimed?.id).toBe(jobId);
      vi.setSystemTime(Date.now() + 90_001);
    }
    await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(
      (await human(t).query(api.mail.listDraftJobs, { companyId: COMPANY, accountId })).jobs,
    ).toMatchObject([
      {
        id: jobId,
        status: "failed",
        lastError: "Reply generation interrupted repeatedly. Retry when an environment is ready.",
      },
    ]);
    const messages = await human(t).query(api.mail.listMessages, { companyId: COMPANY, accountId });
    expect(messages.messages[0]?.analysisStatus).toBe(message.analysisStatus);
    await human(t).mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId });
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query("mailJobs")
        .withIndex("by_domain_id", (q) => q.eq("id", jobId))
        .unique();
      expect(job).toMatchObject({ attempts: 0, status: "pending" });
    });
  });
  it("allows the owner to page through every failed request and requires a brain for retry", async () => {
    const { t, accountId, jobId } = await draftRequest();
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query("mailJobs")
        .withIndex("by_domain_id", (q) => q.eq("id", jobId))
        .unique();
      const { _id, _creationTime: _, ...fields } = job!;
      await ctx.db.patch(_id, { status: "failed" });
      for (let n = 0; n < 60; n++)
        await ctx.db.insert("mailJobs", {
          ...fields,
          id: `extra-${n}`,
          createdAt: fields.createdAt + n + 1,
          status: "failed",
        });
      for (let n = 0; n < 25; n++)
        await ctx.db.insert("mailJobs", {
          ...fields,
          id: `completed-${n}`,
          createdAt: fields.createdAt + n + 100,
          status: "completed",
        });
      const account = await ctx.db
        .query("mailAccounts")
        .withIndex("by_domain_id", (q) => q.eq("id", accountId))
        .unique();
      await ctx.db.patch(account!._id, { brain: undefined });
    });
    let cursor: string | undefined;
    const ids = new Set<string>();
    const first = await human(t).query(api.mail.listDraftJobs, { companyId: COMPANY, accountId });
    expect(first.jobs).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    do {
      const page = await human(t).query(api.mail.listDraftJobs, {
        companyId: COMPANY,
        accountId,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.jobs.length).toBeLessThanOrEqual(25);
      page.jobs.forEach((job) => ids.add(job.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(61);
    expect(ids.has(jobId)).toBe(true);
    await expect(
      human(t).mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId }),
    ).rejects.toThrow("Choose a mail analysis environment");
  });
  it("keeps invalid model output failures visible and prevents retry after disconnect", async () => {
    const { t, accountId, jobId } = await draftRequest();
    const claimed = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    await expect(
      environment(t).mutation(api.mailJobs.complete, {
        companyId: COMPANY,
        jobId,
        generation: claimed!.generation,
        result: { bucket: "priority", reason: "reply" },
      }),
    ).rejects.toThrow("valid reply draft");
    await environment(t).mutation(api.mailJobs.fail, {
      companyId: COMPANY,
      jobId,
      generation: claimed!.generation,
      error: "The environment did not produce a valid reply draft.",
    });
    expect(
      (await human(t).query(api.mail.listDraftJobs, { companyId: COMPANY, accountId })).jobs,
    ).toMatchObject([
      { status: "failed", lastError: "The environment did not produce a valid reply draft." },
    ]);
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("mailAccounts")
        .withIndex("by_domain_id", (q) => q.eq("id", accountId))
        .unique();
      await ctx.db.patch(account!._id, { status: "reauth_required" });
    });
    await expect(
      human(t).mutation(api.mail.retryDraftJob, { companyId: COMPANY, jobId }),
    ).rejects.toThrow("Reconnect");
  });
});
