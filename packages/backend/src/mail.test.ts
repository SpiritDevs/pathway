// @effect-diagnostics globalDate:off -- Test fixtures exercise deterministic Convex lease time.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { DefaultFunctionArgs } from "convex/server";
import * as Redacted from "effect/Redacted";
import { makeMailRuntime, type MailRpc } from "../../../infra/relay/src/mail/runtime.ts";
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
describe("connected mail", () => {
  it("keeps mail, bodies, sender knowledge, drafts and credentials private to the owner", async () => {
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    expect(message).toBeDefined();
    expect(
      await human(t, "colleague").query(api.mail.listAccounts, { companyId: COMPANY }),
    ).toEqual([]);
    await expect(
      human(t, "colleague").query(api.mail.getMessage, {
        companyId: COMPANY,
        messageId: message!.id,
      }),
    ).rejects.toThrow("another member");
    await expect(
      human(t, "colleague").query(api.mail.getSender, {
        companyId: COMPANY,
        accountId,
        email: "sender@example.test",
      }),
    ).rejects.toThrow("another member");
    await expect(
      human(t).query(api.mailRelay.getOwnedAccount, {
        companyId: COMPANY,
        ownerSubject: "owner",
        accountId,
      }),
    ).rejects.toThrow("relay control plane");
    await expect(
      environment(t).query(api.mail.listAccounts, { companyId: COMPANY }),
    ).rejects.toThrow("owner");
    expect(
      JSON.stringify(await human(t).query(api.mail.listAccounts, { companyId: COMPANY })),
    ).not.toContain("encrypted");
    expect(
      await environment(t, "unselected").mutation(api.mailJobs.claim, { companyId: COMPANY }),
    ).toBeNull();
  });
  it("deduplicates intake and paginates equal timestamps without dropping messages", async () => {
    const t = harness();
    const accountId = await seed(t);
    await intake(t, accountId, ["a", "b", "c"]);
    await intake(t, accountId, ["a"]);
    const first = await human(t).query(api.mail.listMessages, {
      companyId: COMPANY,
      accountId,
      limit: 2,
    });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await human(t).query(api.mail.listMessages, {
      companyId: COMPANY,
      accountId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.messages).toHaveLength(1);
    expect(new Set([...first.messages, ...second.messages].map((m) => m.id)).size).toBe(3);
    const sender = await human(t).query(api.mail.getSender, {
      companyId: COMPANY,
      accountId,
      email: "sender@example.test",
    });
    expect(sender?.messageCount).toBe(3);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("mailJobs").collect()).toHaveLength(3);
    });
  });
  it("fences expired sync owners and publishes history only after commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t = harness();
    const accountId = await seed(t);
    const first = await relay(t).mutation(api.mailRelay.claimSync, {
      accountId,
      leaseToken: "first",
    });
    expect(
      await relay(t).mutation(api.mailRelay.claimSync, { accountId, leaseToken: "second" }),
    ).toBeNull();
    vi.setSystemTime(Date.now() + 121000);
    const second = await relay(t).mutation(api.mailRelay.claimSync, {
      accountId,
      leaseToken: "second",
    });
    expect(second!.generation).toBe(first!.generation + 1);
    await expect(
      relay(t).mutation(api.mailRelay.ingestPage, {
        accountId,
        leaseToken: "first",
        generation: first!.generation,
        messages: [sample()],
      }),
    ).rejects.toThrow("expired");
    await relay(t).mutation(api.mailRelay.ingestPage, {
      accountId,
      leaseToken: "second",
      generation: second!.generation,
      messages: [sample()],
      cursor: "must-not-publish",
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("mailAccounts").first())?.cursor).toBeUndefined();
    });
  });
  it("fails over without duplicate execution and retains a backup lease when primary returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t = harness();
    const accountId = await seed(t);
    await intake(t, accountId);
    expect(
      await environment(t, "backup").mutation(api.mailJobs.claim, { companyId: COMPANY }),
    ).toBeNull();
    const first = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(first?.kind).toBe("analyze");
    expect(
      await environment(t, "backup").mutation(api.mailJobs.claim, { companyId: COMPANY }),
    ).toBeNull();
    vi.setSystemTime(Date.now() + 91000);
    const backup = await environment(t, "backup").mutation(api.mailJobs.claim, {
      companyId: COMPANY,
    });
    expect(backup?.generation).toBe(first!.generation + 1);
    expect(backup?.selection.instanceId).toBe("codex");
    await t.run(async (ctx) => {
      const primary = await ctx.db
        .query("environmentRegistrations")
        .filter((q) => q.eq(q.field("environmentId"), "primary"))
        .first();
      await ctx.db.patch(primary!._id, { lastSeenAt: Date.now() });
    });
    expect(
      await environment(t, "backup").mutation(api.mailJobs.renew, {
        companyId: COMPANY,
        jobId: backup!.id,
        generation: backup!.generation,
      }),
    ).toBe(true);
    expect(
      await environment(t).mutation(api.mailJobs.complete, {
        companyId: COMPANY,
        jobId: first!.id,
        generation: first!.generation,
        result: { bucket: "noise", reason: "old claim" },
      }),
    ).toBe(false);
    expect(
      await environment(t, "backup").mutation(api.mailJobs.complete, {
        companyId: COMPANY,
        jobId: backup!.id,
        generation: backup!.generation,
        result: {
          bucket: "priority",
          reason: "Time-sensitive request",
          briefing: "Review the request today.",
          senderSummary: "Sends review requests.",
        },
      }),
    ).toBe(true);
  });
  it("promotion atomically saves a rule and cannot be undone by a stale analysis failure", async () => {
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    const old = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    await human(t).mutation(api.mail.setBucket, {
      companyId: COMPANY,
      messageId: message!.id,
      bucket: "priority",
    });
    await environment(t).mutation(api.mailJobs.fail, {
      companyId: COMPANY,
      jobId: old!.id,
      generation: old!.generation,
      error: "Old analysis failed",
    });
    expect(
      (await human(t).query(api.mail.getMessage, { companyId: COMPANY, messageId: message!.id }))
        .analysisStatus,
    ).toBe("pending");
    const brief = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(brief?.kind).toBe("brief");
    expect(brief?.forcedBucket).toBe("priority");
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: brief!.id,
      generation: brief!.generation,
      result: { bucket: "priority", reason: "Ignored model reason", briefing: "Review today" },
    });
    const messages = await intake(t, accountId, ["new-from-sender"]);
    expect(messages.find((m) => m.providerMessageId === "new-from-sender")?.bucket).toBe(
      "priority",
    );
  });
  it("holds AI replies as drafts, forces the original recipient, and blocks ambiguous retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    const analyze = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: analyze!.id,
      generation: analyze!.generation,
      result: { bucket: "noise", reason: "Routine update" },
    });
    await human(t).mutation(api.mail.requestDraft, { companyId: COMPANY, messageId: message!.id });
    const job = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: job!.id,
      generation: job!.generation,
      result: {
        bucket: "noise",
        reason: "Draft prepared",
        draft: { to: ["attacker@example.test"], subject: "Re: request", text: "Thanks" },
      },
    });
    const [draft] = await human(t).query(api.mail.listDrafts, { companyId: COMPANY, accountId });
    expect(draft?.status).toBe("draft");
    expect(draft?.to).toEqual(["sender@example.test"]);
    expect(
      await relay(t).mutation(api.mailRelay.claimOutbox, { accountId, leaseToken: "send" }),
    ).toBeNull();
    await human(t).mutation(api.mail.requestSend, { companyId: COMPANY, draftId: draft!.id });
    const send = await relay(t).mutation(api.mailRelay.claimOutbox, {
      accountId,
      leaseToken: "send",
    });
    expect(send?.status).toBe("sending");
    await expect(
      human(t).mutation(api.mail.requestSend, { companyId: COMPANY, draftId: draft!.id }),
    ).rejects.toThrow("already submitted");
    vi.setSystemTime(Date.now() + 121000);
    expect(
      await relay(t).mutation(api.mailRelay.claimOutbox, { accountId, leaseToken: "new" }),
    ).toBeNull();
    expect(
      (await human(t).query(api.mail.listDrafts, { companyId: COMPANY, accountId }))[0]?.status,
    ).toBe("unknown");
    expect(
      await relay(t).mutation(api.mailRelay.finishOutbox, {
        draftId: draft!.id,
        leaseToken: "send",
        generation: send!.generation,
        status: "sent",
        providerMessageId: "sent-id",
      }),
    ).toBe(false);
    await expect(
      human(t).mutation(api.mail.requestSend, { companyId: COMPANY, draftId: draft!.id }),
    ).rejects.toThrow("already submitted");
  });
  it("durably synchronizes read changes and fences old acknowledgements", async () => {
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    await human(t).mutation(api.mail.setRead, {
      companyId: COMPANY,
      messageId: message!.id,
      read: true,
    });
    const [old] = await relay(t).mutation(api.mailRelay.claimLabelUpdates, {
      accountId,
      leaseToken: "labels",
    });
    await human(t).mutation(api.mail.setRead, {
      companyId: COMPANY,
      messageId: message!.id,
      read: false,
    });
    expect(
      await relay(t).mutation(api.mailRelay.finishLabelUpdate, {
        id: old!.id,
        generation: old!.generation,
        leaseToken: "labels",
        success: true,
      }),
    ).toBe(false);
    const [latest] = await relay(t).mutation(api.mailRelay.claimLabelUpdates, {
      accountId,
      leaseToken: "latest",
    });
    expect(latest?.read).toBe(false);
  });
  it("reconnects into a fresh mailbox and cleans private copies and credentials durably", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await intake(t, accountId);
    await human(t).mutation(api.mail.disconnectAccount, { companyId: COMPANY, accountId });
    expect(await human(t).query(api.mail.listAccounts, { companyId: COMPANY })).toEqual([]);
    const fresh = await relay(t).mutation(api.mailRelay.connectAccount, {
      companyId: COMPANY,
      ownerSubject: "owner",
      email: "owner@gmail.test",
      encryptedCredentials: "fresh-encrypted",
      oauthClientId: "client-a",
      credentialSource: "byo",
    });
    expect(fresh.id).not.toBe(accountId);
    expect(fresh.cursor).toBeUndefined();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("mailMessages").collect()).toHaveLength(0);
    });
    const [cleanup] = await relay(t).mutation(api.mailRelay.claimAccountCleanup, {
      leaseToken: "cleanup",
    });
    expect(cleanup?.encryptedCredentials).toBe("encrypted-only");
    expect(cleanup?.revoke).toBe(false);
    await relay(t).mutation(api.mailRelay.finishAccountCleanup, {
      id: cleanup!.id,
      leaseToken: "cleanup",
      generation: cleanup!.generation,
    });
    await t.run(async (ctx) => {
      const credentials = await ctx.db.query("mailCredentials").collect();
      expect(credentials).toHaveLength(1);
      expect(credentials[0]?.accountId).toBe(fresh.id);
    });
  });
  it("atomically consumes expiring OAuth state and reserves private uploads for cleanup", async () => {
    vi.useFakeTimers();
    const t = harness();
    await seed(t);
    await relay(t).mutation(api.mailRelay.putOAuthState, {
      stateHash: "hash",
      encryptedState: "opaque",
      expiresAt: Date.now() + 1000,
    });
    expect(await relay(t).mutation(api.mailRelay.consumeOAuthState, { stateHash: "hash" })).toBe(
      "opaque",
    );
    expect(
      await relay(t).mutation(api.mailRelay.consumeOAuthState, { stateHash: "hash" }),
    ).toBeNull();
    await relay(t).mutation(api.mailRelay.registerBlobCleanup, { blobKeys: ["orphan"] });
    expect(
      await relay(t).mutation(api.mailRelay.claimBlobCleanup, { leaseToken: "clean" }),
    ).toEqual([]);
    vi.setSystemTime(Date.now() + 3600001);
    expect(
      (await relay(t).mutation(api.mailRelay.claimBlobCleanup, { leaseToken: "clean" }))[0]
        ?.blobKeys,
    ).toEqual(["orphan"]);
  });
  it("does not starve a selected mailbox behind another environment's backlog", async () => {
    const t = harness();
    const accountId = await seed(t);
    await intake(t, accountId);
    await t.run(async (ctx) => {
      const account = await ctx.db.query("mailAccounts").first();
      const job = await ctx.db.query("mailJobs").first();
      if (!account || !job) throw new Error("fixture missing");
      const {
        _id: accountDocId,
        _creationTime: accountCreated,
        backupEnvironmentId: oldBackup,
        ...accountFields
      } = account;
      void oldBackup;
      void accountDocId;
      void accountCreated;
      await ctx.db.insert("mailAccounts", {
        ...accountFields,
        id: "other-account",
        primaryEnvironmentId: "unselected",
        brain: {
          primaryEnvironmentId: "unselected",
          selection: { instanceId: "claude", model: "sonnet" },
        },
      });
      const { _id: jobDocId, _creationTime: jobCreated, ...jobFields } = job;
      void jobDocId;
      void jobCreated;
      for (let i = 0; i < 150; i++)
        await ctx.db.insert("mailJobs", {
          ...jobFields,
          id: `unrelated-${i}`,
          accountId: "other-account",
          createdAt: job.createdAt - 1000,
        });
    });
    expect((await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY }))?.kind).toBe(
      "analyze",
    );
  });
  it("pauses live analysis and allows sender rules to be removed", async () => {
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    const job = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    await human(t).mutation(api.mail.disableBrain, { companyId: COMPANY, accountId });
    expect(
      await environment(t).mutation(api.mailJobs.renew, {
        companyId: COMPANY,
        jobId: job!.id,
        generation: job!.generation,
      }),
    ).toBe(false);
    await human(t).mutation(api.mail.setBucket, {
      companyId: COMPANY,
      messageId: message!.id,
      bucket: "priority",
    });
    expect(
      await human(t).query(api.mail.listSenderRules, { companyId: COMPANY, accountId }),
    ).toHaveLength(1);
    await human(t).mutation(api.mail.removeSenderRule, {
      companyId: COMPANY,
      accountId,
      email: "sender@example.test",
    });
    expect(
      await human(t).query(api.mail.listSenderRules, { companyId: COMPANY, accountId }),
    ).toEqual([]);
  });
  it("retains optimistic read state until Gmail acknowledges matching labels", async () => {
    const t = harness();
    const accountId = await seed(t);
    const [message] = await intake(t, accountId);
    await human(t).mutation(api.mail.setRead, {
      companyId: COMPANY,
      messageId: message!.id,
      read: true,
    });
    const [update] = await relay(t).mutation(api.mailRelay.claimLabelUpdates, {
      accountId,
      leaseToken: "labels",
    });
    await relay(t).mutation(api.mailRelay.finishLabelUpdate, {
      id: update!.id,
      generation: update!.generation,
      leaseToken: "labels",
      success: true,
    });
    await intake(t, accountId);
    expect(
      (await human(t).query(api.mail.getMessage, { companyId: COMPANY, messageId: message!.id }))
        .read,
    ).toBe(true);
    const lease = await relay(t).mutation(api.mailRelay.claimSync, {
      accountId,
      leaseToken: "fresh",
    });
    await relay(t).mutation(api.mailRelay.ingestPage, {
      accountId,
      leaseToken: "fresh",
      generation: lease!.generation,
      messages: [{ ...sample(), labels: ["INBOX"] }],
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("mailLabelUpdates").collect()).toEqual([]);
    });
  });
  it("cancels cleanup only when private blob references commit and enforces blob ownership", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await relay(t).mutation(api.mailRelay.registerBlobCleanup, {
      blobKeys: ["body-key", "raw-key", "attachment-key"],
    });
    const lease = await relay(t).mutation(api.mailRelay.claimSync, {
      accountId,
      leaseToken: "blobs",
    });
    await relay(t).mutation(api.mailRelay.ingestPage, {
      accountId,
      leaseToken: "blobs",
      generation: lease!.generation,
      messages: [
        {
          ...sample(),
          bodyBlobKey: "body-key",
          rawBlobKey: "raw-key",
          attachments: [
            {
              partId: "1",
              filename: "note.txt",
              mimeType: "text/plain",
              size: 12,
              blobKey: "attachment-key",
            },
          ],
        },
      ],
    });
    const [message] = (
      await human(t).query(api.mail.listMessages, { companyId: COMPANY, accountId })
    ).messages;
    expect(
      await relay(t).query(api.mailRelay.getOwnedBlob, {
        ownerSubject: "colleague",
        companyId: COMPANY,
        messageId: message!.id,
        blobKey: "body-key",
      }),
    ).toBeNull();
    expect(
      await relay(t).query(api.mailRelay.getOwnedBlob, {
        ownerSubject: "owner",
        companyId: COMPANY,
        messageId: message!.id,
        blobKey: "body-key",
      }),
    ).toEqual({ blobKey: "body-key" });
    vi.setSystemTime(Date.now() + 3600001);
    expect(
      await relay(t).mutation(api.mailRelay.claimBlobCleanup, { leaseToken: "cleanup" }),
    ).toEqual([]);
    await human(t).mutation(api.mail.disconnectAccount, { companyId: COMPANY, accountId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      (await relay(t).mutation(api.mailRelay.claimBlobCleanup, { leaseToken: "cleanup" }))
        .flatMap((row) => row.blobKeys)
        .sort(),
    ).toEqual(["attachment-key", "body-key", "raw-key"]);
  });
  it("integrates OAuth, relay intake, analysis, promotion and explicit send against real Convex functions", async () => {
    const t = harness();
    await seed(t);
    const relayClient = relay(t);
    const rpc: MailRpc = {
      async query<T>(name: string, args: Record<string, unknown>): Promise<T> {
        return await relayClient.query(
          makeFunctionReference<"query", DefaultFunctionArgs, T>(`mailRelay:${name}`),
          args as DefaultFunctionArgs,
        );
      },
      async mutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
        return await relayClient.mutation(
          makeFunctionReference<"mutation", DefaultFunctionArgs, T>(`mailRelay:${name}`),
          args as DefaultFunctionArgs,
        );
      },
    };
    const enqueued: Array<{ accountId: string }> = [];
    const sentRequests: string[] = [];
    const gmailMessage = {
      id: "gmail-live",
      threadId: "thread-live",
      historyId: "500",
      internalDate: "1800000000000",
      sizeEstimate: 200,
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Please approve by Friday.",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Colleague <sender@example.test>" },
          { name: "To", value: "integrated@gmail.test" },
          { name: "Subject", value: "Approval needed" },
          { name: "Message-ID", value: "<original@example.test>" },
        ],
        body: { data: btoa("Please approve by Friday.") },
      },
    };
    const fixtureFetch: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      let response: unknown;
      if (url.hostname === "oauth2.googleapis.com")
        response = {
          access_token: "test-access",
          refresh_token: "test-refresh",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        };
      else if (url.pathname.endsWith("/profile"))
        response = { emailAddress: "integrated@gmail.test", historyId: "500" };
      else if (url.pathname.endsWith("/messages/send")) {
        sentRequests.push(String(init?.body));
        response = { id: "sent-live", threadId: "thread-live" };
      } else if (url.pathname.endsWith("/history")) response = { historyId: "500", history: [] };
      else if (url.pathname.endsWith("/messages")) response = { messages: [{ id: "gmail-live" }] };
      else if (url.pathname.endsWith("/messages/gmail-live"))
        response =
          url.searchParams.get("format") === "raw"
            ? {
                ...gmailMessage,
                raw: btoa("From: sender@example.test\r\n\r\nPlease approve by Friday."),
              }
            : gmailMessage;
      else throw new Error(`Unexpected fixture request ${url.pathname}`);
      return new Response(JSON.stringify(response), {
        headers: { "content-type": "application/json" },
      });
    };
    const runtime = makeMailRuntime({
      config: {
        encryptionKey: Redacted.make(btoa("x".repeat(32))),
        uploadThingApiKey: Redacted.make("fixture"),
        pubsubTopic: "fixture-topic",
        pubsubServiceAccount: "fixture@example.test",
        hostedClientId: "",
        hostedClientSecret: Redacted.make(""),
      },
      origin: "https://relay.example.test",
      rpc,
      enqueue: async (job) => {
        enqueued.push(job);
      },
      fetcher: fixtureFetch,
      storage: {
        put: async (name) => {
          const key = `fixture-${name}`;
          await relayClient.mutation(api.mailRelay.registerBlobCleanup, { blobKeys: [key] });
          return key;
        },
        signedUrl: async (key) => `https://storage.example.test/${key}`,
        delete: async () => {},
      },
    });
    const start = await runtime.startOAuth({
      ownerSubject: "owner",
      companyId: COMPANY,
      credentialSource: "byo",
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    const account = await runtime.finishOAuth(state!, "fixture-code");
    expect(enqueued).toEqual([{ accountId: account.id }]);
    await human(t).mutation(api.mail.configureBrain, {
      companyId: COMPANY,
      accountId: account.id,
      brain: {
        primaryEnvironmentId: "primary",
        selection: { instanceId: "claude", model: "sonnet" },
      },
    });
    await runtime.process({ accountId: account.id });
    const [message] = (
      await human(t).query(api.mail.listMessages, { companyId: COMPANY, accountId: account.id })
    ).messages;
    expect(message?.subject).toBe("Approval needed");
    const analysis = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(analysis?.message.textBody).toBe("Please approve by Friday.");
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: analysis!.id,
      generation: analysis!.generation,
      result: { bucket: "noise", reason: "Initial classification" },
    });
    await human(t).mutation(api.mail.setBucket, {
      companyId: COMPANY,
      messageId: message!.id,
      bucket: "priority",
    });
    const briefing = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(briefing?.forcedBucket).toBe("priority");
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: briefing!.id,
      generation: briefing!.generation,
      result: {
        bucket: "priority",
        reason: "Owner requested priority",
        briefing: "Approve by Friday.",
      },
    });
    const draftId = await human(t).mutation(api.mail.saveDraft, {
      companyId: COMPANY,
      accountId: account.id,
      replyToMessageId: message!.id,
      to: ["sender@example.test"],
      subject: "Re: Approval needed",
      text: "Approved, thank you.",
    });
    await runtime.process({ accountId: account.id });
    expect(sentRequests).toEqual([]);
    await human(t).mutation(api.mail.requestSend, { companyId: COMPANY, draftId });
    await runtime.process({ accountId: account.id });
    expect(sentRequests).toHaveLength(1);
    expect(JSON.parse(sentRequests[0]!).threadId).toBe("thread-live");
    const [sent] = await human(t).query(api.mail.listDrafts, {
      companyId: COMPANY,
      accountId: account.id,
    });
    expect(sent?.status).toBe("sent");
    expect(sent?.providerMessageId).toBe("sent-live");
  });
  it("retires mail when its owner leaves and cannot acquire sync or delivery afterward", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await intake(t, accountId);
    await t.run(async (ctx) => {
      const owner = await ctx.db
        .query("memberships")
        .filter((q) => q.eq(q.field("id"), "membership-owner"))
        .first();
      await ctx.db.patch(owner!._id, { state: "left" });
    });
    expect(
      await relay(t).mutation(api.mailRelay.claimSync, { accountId, leaseToken: "revoked" }),
    ).toBeNull();
    expect(
      await relay(t).mutation(api.mailRelay.claimOutbox, { accountId, leaseToken: "revoked" }),
    ).toBeNull();
    expect(await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY })).toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("mailMessages").collect()).toEqual([]);
      expect((await ctx.db.query("mailAccounts").first())?.status).toBe("disconnected");
    });
  });
  it("rejects committing uploads already claimed or removed by durable cleanup", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await relay(t).mutation(api.mailRelay.registerBlobCleanup, { blobKeys: ["expired-blob"] });
    vi.setSystemTime(Date.now() + 3600001);
    const [cleanup] = await relay(t).mutation(api.mailRelay.claimBlobCleanup, {
      leaseToken: "cleanup",
    });
    const sync = await relay(t).mutation(api.mailRelay.claimSync, {
      accountId,
      leaseToken: "sync",
    });
    const args = {
      accountId,
      leaseToken: "sync",
      generation: sync!.generation,
      messages: [{ ...sample(), rawBlobKey: "expired-blob" }],
    };
    await expect(relay(t).mutation(api.mailRelay.ingestPage, args)).rejects.toThrow(
      "upload expired",
    );
    await relay(t).mutation(api.mailRelay.finishBlobCleanup, {
      id: cleanup!.id,
      generation: cleanup!.generation,
      leaseToken: "cleanup",
    });
    await expect(relay(t).mutation(api.mailRelay.ingestPage, args)).rejects.toThrow(
      "upload expired",
    );
  });
  it("blocks publishing refreshed credentials while an old grant is being revoked", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await human(t).mutation(api.mail.disconnectAccount, { companyId: COMPANY, accountId });
    const [cleanup] = await relay(t).mutation(api.mailRelay.claimAccountCleanup, {
      leaseToken: "revoke",
    });
    expect(cleanup?.revoke).toBe(true);
    await expect(
      relay(t).mutation(api.mailRelay.connectAccount, {
        ownerSubject: "owner",
        companyId: COMPANY,
        email: "owner@gmail.test",
        credentialSource: "byo",
        encryptedCredentials: "fresh",
        oauthClientId: "client-a",
      }),
    ).rejects.toThrow("disconnect is finishing");
    await relay(t).mutation(api.mailRelay.finishAccountCleanup, {
      id: cleanup!.id,
      generation: cleanup!.generation,
      leaseToken: "revoke",
    });
    expect(
      (
        await relay(t).mutation(api.mailRelay.connectAccount, {
          ownerSubject: "owner",
          companyId: COMPANY,
          email: "owner@gmail.test",
          credentialSource: "byo",
          encryptedCredentials: "fresh",
          oauthClientId: "client-a",
        })
      ).id,
    ).not.toBe(accountId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
  it("claims newly requested briefings and drafts ahead of historical analysis backlog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t = harness();
    const accountId = await seed(t);
    const messages = await intake(t, accountId, [
      ...Array.from({ length: 35 }, (_, index) => `backlog-${index}`),
      "promote-now",
      "draft-now",
    ]);
    const promotion = messages.find((message) => message.providerMessageId === "promote-now")!;
    const reply = messages.find((message) => message.providerMessageId === "draft-now")!;
    vi.setSystemTime(Date.now() + 1000);
    await human(t).mutation(api.mail.setBucket, {
      companyId: COMPANY,
      messageId: promotion.id,
      bucket: "priority",
    });
    vi.setSystemTime(Date.now() + 1);
    await human(t).mutation(api.mail.requestDraft, { companyId: COMPANY, messageId: reply.id });
    const briefing = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(briefing?.kind).toBe("brief");
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: briefing!.id,
      generation: briefing!.generation,
      result: { bucket: "priority", reason: "Owner promotion", briefing: "Requested briefing." },
    });
    const draft = await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY });
    expect(draft?.kind).toBe("draft");
    await environment(t).mutation(api.mailJobs.complete, {
      companyId: COMPANY,
      jobId: draft!.id,
      generation: draft!.generation,
      result: {
        bucket: "noise",
        reason: "Requested draft",
        draft: { to: ["sender@example.test"], subject: "Re: Please review", text: "Thanks." },
      },
    });
    expect((await environment(t).mutation(api.mailJobs.claim, { companyId: COMPANY }))?.kind).toBe(
      "analyze",
    );
  });
  it("allows only the owner to discard editable drafts and retains every submitted state", async () => {
    const t = harness();
    const accountId = await seed(t);
    for (const status of ["draft", "failed", "queued", "sending", "sent", "unknown"] as const) {
      const draftId = await human(t).mutation(api.mail.saveDraft, {
        companyId: COMPANY,
        accountId,
        to: ["sender@example.test"],
        subject: `Draft ${status}`,
        text: "Saved text",
      });
      await t.run(async (ctx) => {
        const draft = await ctx.db
          .query("mailDrafts")
          .withIndex("by_domain_id", (q) => q.eq("id", draftId))
          .unique();
        await ctx.db.patch(draft!._id, { status });
      });
      await expect(
        human(t, "colleague").mutation(api.mail.discardDraft, { companyId: COMPANY, draftId }),
      ).rejects.toThrow("another member");
      if (status === "draft" || status === "failed") {
        expect(
          await human(t).mutation(api.mail.discardDraft, { companyId: COMPANY, draftId }),
        ).toBeNull();
        expect(
          (await human(t).query(api.mail.listDrafts, { companyId: COMPANY, accountId })).some(
            (draft) => draft.id === draftId,
          ),
        ).toBe(false);
      } else {
        await expect(
          human(t).mutation(api.mail.discardDraft, { companyId: COMPANY, draftId }),
        ).rejects.toThrow("cannot be discarded");
        expect(
          (await human(t).query(api.mail.listDrafts, { companyId: COMPANY, accountId })).find(
            (draft) => draft.id === draftId,
          )?.status,
        ).toBe(status);
      }
    }
  });
  it("revokes a disconnected grant when the same mailbox reconnects with a different OAuth client", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await human(t).mutation(api.mail.disconnectAccount, { companyId: COMPANY, accountId });
    const separateGrant = await relay(t).mutation(api.mailRelay.connectAccount, {
      ownerSubject: "owner",
      companyId: COMPANY,
      email: "owner@gmail.test",
      credentialSource: "byo",
      oauthClientId: "client-b",
      encryptedCredentials: "different-client-credentials",
    });
    const [cleanup] = await relay(t).mutation(api.mailRelay.claimAccountCleanup, {
      leaseToken: "revoke-client-a",
    });
    expect(cleanup?.accountId).toBe(accountId);
    expect(cleanup?.revoke).toBe(true);
    await relay(t).mutation(api.mailRelay.finishAccountCleanup, {
      id: cleanup!.id,
      generation: cleanup!.generation,
      leaseToken: "revoke-client-a",
    });
    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mailCredentials").collect();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.accountId).toBe(separateGrant.id);
      expect(remaining[0]?.encryptedCredentials).toBe("different-client-credentials");
    });
    const visible = await human(t).query(api.mail.listAccounts, { companyId: COMPANY });
    expect(JSON.stringify(visible)).not.toContain("oauthClientId");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
  it("allows a different OAuth client to connect while an older client's grant revocation is leased", async () => {
    vi.useFakeTimers();
    const t = harness();
    const accountId = await seed(t);
    await human(t).mutation(api.mail.disconnectAccount, { companyId: COMPANY, accountId });
    const [cleanup] = await relay(t).mutation(api.mailRelay.claimAccountCleanup, {
      leaseToken: "revoke-client-a",
    });
    expect(cleanup?.revoke).toBe(true);
    const differentClient = await relay(t).mutation(api.mailRelay.connectAccount, {
      ownerSubject: "owner",
      companyId: COMPANY,
      email: "owner@gmail.test",
      credentialSource: "byo",
      oauthClientId: "client-b",
      encryptedCredentials: "different-client",
    });
    expect(differentClient.oauthClientId).toBe("client-b");
    expect(differentClient.id).not.toBe(accountId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
