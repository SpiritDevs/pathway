// @effect-diagnostics globalDate:off -- Fixtures and queue transitions use Convex epoch milliseconds.
/** Durable intent, permanent acceptance fencing, recovery, and authorization coverage. */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vite-plus/test";

import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import schema from "../convex/schema.ts";
import type { ThreadQueuePage } from "@spiritdevs/contracts/threadQueue";

const RELAY_ISSUER = "https://relay.example.test";
const CLERK_ISSUER = "https://clerk.example.test";
process.env.PATHWAY_RELAY_JWT_ISSUER = RELAY_ISSUER;
process.env.PATHWAY_RELAY_JWKS_URL = `${RELAY_ISSUER}/.well-known/jwks.json`;

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/agentThreads.ts": () => import("../convex/agentThreads.ts"),
  "../convex/threadQueue.ts": () => import("../convex/threadQueue.ts"),
  "../convex/sync.ts": () => import("../convex/sync.ts"),
};

const COMPANY_ID = "01990000-0000-7000-8000-000000000001";
const MANAGER_MEMBERSHIP_ID = "01990000-0000-7000-8000-000000000101";
const DISPATCHER_MEMBERSHIP_ID = "01990000-0000-7000-8000-000000000102";
const MANAGER_ROLE_ID = "01990000-0000-7000-8000-000000000201";
const DISPATCHER_ROLE_ID = "01990000-0000-7000-8000-000000000202";
const ENVIRONMENT_ONE = "command-environment-one";
const ENVIRONMENT_TWO = "command-environment-two";
const REVOKED_ENVIRONMENT = "command-environment-revoked";
const REGISTRATION_ONE_ID = "01990000-0000-7000-8000-000000000301";
const REGISTRATION_TWO_ID = "01990000-0000-7000-8000-000000000302";
const REGISTRATION_REVOKED_ID = "01990000-0000-7000-8000-000000000303";
const THUMBPRINT_ONE = "command-thumbprint-one";
const THUMBPRINT_TWO = "command-thumbprint-two";

function harness() {
  return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

function asMember(t: Harness, subject: "manager" | "dispatcher") {
  return t.withIdentity({
    issuer: CLERK_ISSUER,
    subject,
    tokenIdentifier: `${CLERK_ISSUER}|${subject}`,
    email: `${subject}@example.test`,
  });
}

function asEnvironment(t: Harness, environmentId = ENVIRONMENT_ONE) {
  const thumbprint = environmentId === ENVIRONMENT_ONE ? THUMBPRINT_ONE : THUMBPRINT_TWO;
  return t.withIdentity({
    issuer: RELAY_ISSUER,
    subject: environmentId,
    tokenIdentifier: `${RELAY_ISSUER}|${environmentId}`,
    cnf: { jkt: thumbprint },
  });
}

interface Seeded {
  readonly companyDocId: Id<"companies">;
}

async function seed(t: Harness): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const companyDocId = await ctx.db.insert("companies", {
      id: COMPANY_ID,
      name: "Environment Command Co",
      issueKeyPrefix: "CMD",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const addMember = async (
      subject: "manager" | "dispatcher",
      membershipId: string,
      roleId: string,
      permissions: string[],
    ) => {
      const userId = await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const membershipDocId = await ctx.db.insert("memberships", {
        id: membershipId,
        companyId: companyDocId,
        userId,
        state: "active",
        displayNameSnapshot: subject,
        emailSnapshot: `${subject}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const roleDocId = await ctx.db.insert("roles", {
        id: roleId,
        companyId: companyDocId,
        name: `${subject} role`,
        description: "",
        permissions,
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${membershipId}-assignment`,
        companyId: companyDocId,
        membershipId: membershipDocId,
        roleId: roleDocId,
        scope: "company",
        teamId: null,
        createdAt: now,
      });
    };

    await addMember("manager", MANAGER_MEMBERSHIP_ID, MANAGER_ROLE_ID, [
      "remoteAgents.dispatch",
      "remoteAgents.control",
      "environments.read",
      "environments.manage",
    ]);
    await addMember("dispatcher", DISPATCHER_MEMBERSHIP_ID, DISPATCHER_ROLE_ID, [
      "remoteAgents.dispatch",
      "environments.read",
    ]);

    const addRegistration = async (
      id: string,
      environmentId: string,
      thumbprint: string,
      state: "active" | "revoked",
    ) => {
      await ctx.db.insert("environmentRegistrations", {
        id,
        companyId: companyDocId,
        environmentId,
        publicKeyThumbprint: thumbprint,
        descriptor: {
          environmentId,
          label: environmentId,
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "1.0.0",
          capabilities: { repositoryIdentity: true },
        },
        relayLinkState: state === "active" ? "linked" : "revoked",
        managedEndpointAvailable: true,
        lastSeenAt: now,
        serviceRoleIds: [],
        teamIds: [],
        state,
        registeredByMembershipId: null,
        createdAt: now,
        updatedAt: now,
      });
    };
    await addRegistration(REGISTRATION_ONE_ID, ENVIRONMENT_ONE, THUMBPRINT_ONE, "active");
    await addRegistration(REGISTRATION_TWO_ID, ENVIRONMENT_TWO, THUMBPRINT_TWO, "active");
    await addRegistration(
      REGISTRATION_REVOKED_ID,
      REVOKED_ENVIRONMENT,
      "command-thumbprint-revoked",
      "revoked",
    );
    return { companyDocId };
  });
}

function launch(threadId = "thread-one", commandId = "launch-one", text = "Build the feature") {
  return {
    kind: "launch" as const,
    input: {
      commandId,
      threadId,
      projectId: null,
      conversationCompanyId: COMPANY_ID,
      title: "Pending feature",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: `message-${commandId}`, text, attachments: [] },
    },
  };
}
function followup(commandId = "followup-one") {
  return {
    kind: "message" as const,
    input: {
      type: "message.dispatch",
      commandId,
      threadId: "thread-one",
      messageId: `message-${commandId}`,
      text: "Add tests",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    },
  };
}
async function enqueue(t: Harness, submission = launch()) {
  return asMember(t, "manager").mutation(api.threadQueue.enqueue, {
    companyId: COMPANY_ID,
    environmentId: ENVIRONMENT_ONE,
    threadId: "thread-one",
    submission,
    attachmentIds: [],
  });
}
const queueIdentity = { companyId: COMPANY_ID, threadId: "thread-one" };
const firstFence = {
  ...queueIdentity,
  commandId: "launch-one",
  revision: 1,
};
async function capabilities(t: Harness) {
  await t.run(async (ctx) => {
    const company = await ctx.db.query("companies").first();
    await ctx.db.insert("environmentProviderCapabilities", {
      companyId: company!._id,
      environmentId: ENVIRONMENT_TWO,
      revision: 1,
      supportsSlackCoordination: false,
      supportsAutomationJobs: false,
      providers: [
        {
          instanceId: "codex",
          driverKind: "codex",
          enabled: true,
          available: true,
          modelIds: ["gpt-5"],
        },
      ],
      publishedAt: Date.now(),
    });
  });
}

describe("durable thread queue", () => {
  it("isolates identical thread and command IDs by environment while preserving stable queue IDs", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    const first = await enqueue(t);
    const client = asMember(t, "manager");
    const second = await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_TWO,
      submission: launch(),
      attachmentIds: [],
    });
    expect(first.thread.queueId).toBeTruthy();
    expect(second.thread.queueId).not.toBe(first.thread.queueId);
    await expect(client.query(api.threadQueue.getThread, queueIdentity)).rejects.toThrow(
      "ambiguous-queue",
    );
    expect(
      (
        await client.query(api.threadQueue.getThread, {
          ...queueIdentity,
          environmentId: ENVIRONMENT_TWO,
        })
      ).thread.queueId,
    ).toBe(second.thread.queueId);
    await client.mutation(api.threadQueue.edit, {
      ...firstFence,
      queueId: first.thread.queueId!,
      text: "Only the first environment",
    });
    expect(
      (
        await client.query(api.threadQueue.getThread, {
          ...queueIdentity,
          queueId: second.thread.queueId!,
        })
      ).messages[0]?.revision,
    ).toBe(1);
    await expect(
      client.mutation(api.threadQueue.reassign, {
        ...queueIdentity,
        queueId: first.thread.queueId!,
        revision: 1,
        environmentId: ENVIRONMENT_TWO,
        localProjectId: null,
      }),
    ).rejects.toThrow("destination-conflict");
    const heads = await asEnvironment(t, ENVIRONMENT_TWO).query(api.threadQueue.environmentHead, {
      companyId: COMPANY_ID,
    });
    expect(heads).toHaveLength(1);
    expect(heads[0]?.queueId).toBe(second.thread.queueId);
    expect(
      await asEnvironment(t).mutation(api.threadQueue.accept, {
        ...firstFence,
        queueId: second.thread.queueId!,
      }),
    ).toBeNull();
    await asEnvironment(t, ENVIRONMENT_TWO).mutation(api.threadQueue.accept, {
      ...firstFence,
      queueId: second.thread.queueId!,
    });
    expect(
      (
        await client.query(api.threadQueue.submissionStatus, {
          ...queueIdentity,
          queueId: first.thread.queueId!,
          commandId: "launch-one",
        })
      )?.state,
    ).toBe("queued");
  });

  it("keeps a queue identity and its original submission receipt after reassignment", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    const first = await enqueue(t);
    const moved = await asMember(t, "manager").mutation(api.threadQueue.reassign, {
      ...queueIdentity,
      queueId: first.thread.queueId!,
      revision: 1,
      environmentId: ENVIRONMENT_TWO,
      localProjectId: null,
    });
    expect(moved.queueId).toBe(first.thread.queueId);
    const replay = await enqueue(t);
    expect(replay.thread.queueId).toBe(first.thread.queueId);
    expect(replay.thread.environmentId).toBe(ENVIRONMENT_TWO);
    expect(
      (
        await asEnvironment(t, ENVIRONMENT_TWO).query(api.threadQueue.environmentHead, {
          companyId: COMPANY_ID,
        })
      )[0]?.queueId,
    ).toBe(first.thread.queueId);
  });

  it("paginates retained queue history without losing delivered receipts", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("threadQueueThreads").first())!;
      const { _id, _creationTime, ...metadata } = row;
      for (let i = 0; i < 260; i++)
        await ctx.db.insert("threadQueueThreads", { ...metadata, threadId: `history-${i}` });
    });
    const client = asMember(t, "manager");
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(128);
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page: ThreadQueuePage = await client.query(api.threadQueue.listPage, {
        companyId: COMPANY_ID,
        paginationOpts: { numItems: 64, cursor },
      });
      expect(page.page.length).toBeLessThanOrEqual(64);
      for (const thread of page.page) seen.add(thread.queueId!);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen.size).toBe(261);
    expect(
      (
        await client.query(api.threadQueue.submissionStatus, {
          ...queueIdentity,
          commandId: "launch-one",
        })
      )?.state,
    ).toBe("delivered");
    await expect(
      client.query(api.threadQueue.listPage, {
        companyId: COMPANY_ID,
        paginationOpts: { numItems: 1000, cursor: null },
      }),
    ).rejects.toThrow("128");
  });

  it("retains pending handoffs and canceled content while retiring published delivered rows", async () => {
    const t = harness();
    await seed(t);
    const saved = await enqueue(t);
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find(
        (row) => row.id === MANAGER_ROLE_ID,
      )!;
      await ctx.db.patch(role._id, { permissions: [...role.permissions, "projects.manage"] });
      const environment = (await ctx.db.query("environmentRegistrations").collect()).find(
        (row) => row.environmentId === ENVIRONMENT_ONE,
      )!;
      await ctx.db.patch(environment._id, { serviceRoleIds: [role.id] });
    });
    const client = asMember(t, "manager");
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(1);
    const beforePublication = await t.run((ctx) =>
      ctx.db.get(saved.thread.queueId! as Id<"threadQueueThreads">),
    );
    expect(beforePublication?.listingExpiresAt).toBe(Number.MAX_SAFE_INTEGER);
    await asEnvironment(t).mutation(api.agentThreads.upsert, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ONE,
      threadId: "thread-one",
      localProjectId: null,
      shell: { id: "thread-one", projectId: null, conversationCompanyId: COMPANY_ID },
    });
    const published = await t.run((ctx) =>
      ctx.db.get(saved.thread.queueId! as Id<"threadQueueThreads">),
    );
    expect(published!.listingExpiresAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    await t.run((ctx) => ctx.db.patch(published!._id, { listingExpiresAt: Date.now() - 1 }));
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(0);
    expect(
      (
        await client.query(api.threadQueue.submissionStatus, {
          ...queueIdentity,
          commandId: "launch-one",
          queueId: saved.thread.queueId!,
        })
      )?.state,
    ).toBe("delivered");
    // A duplicate publisher snapshot cannot resurrect expired receipt-only history.
    await asEnvironment(t).mutation(api.agentThreads.upsert, {
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ONE,
      threadId: "thread-one",
      localProjectId: null,
      shell: { id: "thread-one", projectId: null, conversationCompanyId: COMPANY_ID },
    });
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(0);
    await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      queueId: saved.thread.queueId!,
      environmentId: ENVIRONMENT_ONE,
      submission: followup(),
      attachmentIds: [],
    });
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(1);
    await client.mutation(api.threadQueue.cancel, {
      ...queueIdentity,
      queueId: saved.thread.queueId!,
      commandId: "followup-one",
      revision: 1,
    });
    expect((await t.run((ctx) => ctx.db.get(published!._id)))?.listingExpiresAt).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("migrates preview listing metadata without changing legacy receipt identity", async () => {
    const t = harness();
    await seed(t);
    const saved = await enqueue(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("threadQueueThreads").first())!;
      const {
        _id,
        _creationTime,
        queueVersion: _queueVersion,
        originEnvironmentId: _originEnvironmentId,
        listingExpiresAt: _listingExpiresAt,
        ...legacy
      } = row;
      await ctx.db.replace(_id, legacy);
      const message = (await ctx.db.query("threadQueueMessages").first())!;
      const {
        _id: messageId,
        _creationTime: _messageCreated,
        queueThreadId: _queueThreadId,
        issuedByMembershipDomainId: _issuedByMembershipDomainId,
        ...legacyMessage
      } = message;
      await ctx.db.replace(messageId, legacyMessage);
    });
    expect(await t.mutation(internal.threadQueue.migrateListing, {})).toBe(1);
    const client = asMember(t, "manager");
    expect((await client.query(api.threadQueue.list, { companyId: COMPANY_ID }))[0]?.queueId).toBe(
      saved.thread.queueId,
    );
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).messages).toHaveLength(1);
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    expect(
      (
        await client.query(api.threadQueue.submissionStatus, {
          ...queueIdentity,
          commandId: "launch-one",
        })
      )?.state,
    ).toBe("delivered");
  });

  it("validates queued checkout metadata before storing it", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.enqueue, {
        ...queueIdentity,
        environmentId: ENVIRONMENT_ONE,
        submission: { ...followup(), branch: 42 },
        attachmentIds: [],
      }),
    ).rejects.toThrow("Invalid checkout branch");
  });

  it("lets the issuer read and cancel saved intent after dispatch permission is revoked", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find(
        (row) => row.id === MANAGER_ROLE_ID,
      )!;
      await ctx.db.patch(role._id, { permissions: [] });
    });
    const client = asMember(t, "manager");
    expect(await client.query(api.threadQueue.list, { companyId: COMPANY_ID })).toHaveLength(1);
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).messages).toHaveLength(1);
    await expect(asEnvironment(t).mutation(api.threadQueue.accept, firstFence)).rejects.toThrow(
      "remoteAgents.dispatch",
    );
    await expect(
      client.mutation(api.threadQueue.edit, { ...firstFence, text: "Changed" }),
    ).rejects.toThrow("remoteAgents.dispatch");
    await client.mutation(api.threadQueue.cancel, firstFence);
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).thread.state).toBe(
      "canceled",
    );
    await expect(
      client.mutation(api.threadQueue.retry, { ...firstFence, revision: 2 }),
    ).rejects.toThrow("remoteAgents.dispatch");
  });

  it("reconciles accepted work after its issuer membership and permissions are revoked", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const environment = asEnvironment(t);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").collect()).find(
        (row) => row.id === MANAGER_MEMBERSHIP_ID,
      )!;
      await ctx.db.delete(membership._id);
    });
    const candidate = await environment.query(api.threadQueue.prepare, firstFence);
    expect(candidate).toMatchObject({
      state: "accepted",
      issuedByMembershipId: MANAGER_MEMBERSHIP_ID,
    });
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.acknowledge, firstFence);
    expect(
      await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }),
    ).toEqual([]);
  });

  it("cancels a proven rejected initial message and unblocks its followup without permitting unsafe cancellation", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const client = asMember(t, "manager");
    await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup(),
      attachmentIds: [],
    });
    const environment = asEnvironment(t);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      error: "Unknown delivery result",
    });
    await expect(client.mutation(api.threadQueue.cancel, firstFence)).rejects.toThrow(
      "already accepted",
    );
    await client.mutation(api.threadQueue.retry, firstFence);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      rejection: "initial-message",
      error: "Target turn ended",
    });
    await expect(
      client.mutation(api.threadQueue.edit, { ...firstFence, text: "Changed" }),
    ).rejects.toThrow("already accepted");
    await client.mutation(api.threadQueue.cancel, firstFence);
    expect(
      (await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }))[0]
        ?.commandId,
    ).toBe("followup-one");
    expect(
      (await client.query(api.threadQueue.getThread, queueIdentity)).thread.acceptedAt,
    ).not.toBeNull();
  });

  it("normalizes a synthetic conversation project before saving or delivering its launch", async () => {
    const t = harness();
    await seed(t);
    const submission = launch();
    const args = {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: {
        ...submission,
        input: { ...submission.input, projectId: `conversations:${COMPANY_ID}` },
      },
      attachmentIds: [],
    };
    const client = asMember(t, "manager");
    const saved = await client.mutation(api.threadQueue.enqueue, args);
    expect(saved.thread.localProjectId).toBeNull();
    expect(saved.thread.launch?.projectId).toBeNull();
    expect(saved.messages[0]?.submission.input).toMatchObject({
      projectId: null,
      conversationCompanyId: COMPANY_ID,
    });
    expect((await client.mutation(api.threadQueue.enqueue, args)).messages).toHaveLength(1);
    const accepted = await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    expect(accepted).toMatchObject({
      localProjectId: null,
      submission: { input: { projectId: null, conversationCompanyId: COMPANY_ID } },
    });
  });

  it("rejects a conversation company mismatch even when its client project is non-null", async () => {
    const t = harness();
    await seed(t);
    const submission = launch();
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.enqueue, {
        ...queueIdentity,
        environmentId: ENVIRONMENT_ONE,
        submission: {
          ...submission,
          input: {
            ...submission.input,
            projectId: "conversations:another-company",
            conversationCompanyId: "another-company",
          },
        },
        attachmentIds: [],
      }),
    ).rejects.toThrow("Conversation company must match");
  });

  it("retains lightweight delivered receipts without retransmitting historical prompt bodies", async () => {
    const t = harness();
    await seed(t);
    const client = asMember(t, "manager");
    const statusArgs = { ...queueIdentity, commandId: "launch-one" };
    expect(await client.query(api.threadQueue.submissionStatus, statusArgs)).toBeNull();
    await enqueue(t);
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).messages).toEqual([]);
    expect(await client.query(api.threadQueue.submissionStatus, statusArgs)).toMatchObject({
      threadId: "thread-one",
      commandId: "launch-one",
      messageId: "message-launch-one",
      state: "delivered",
      revision: 1,
      deliveryAttempt: 0,
    });
    await expect(
      asMember(t, "dispatcher").query(api.threadQueue.submissionStatus, statusArgs),
    ).rejects.toThrow("another member");
  });

  it("persists offline intent and stable identity across retries without exposing another member's prompts", async () => {
    const t = harness();
    await seed(t);
    const first = await enqueue(t);
    expect(first.thread).toMatchObject({
      threadId: "thread-one",
      environmentId: ENVIRONMENT_ONE,
      state: "queued",
      queuedCount: 1,
      acceptedAt: null,
    });
    await enqueue(t);
    expect(
      (await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity)).messages,
    ).toHaveLength(1);
    expect(
      await asMember(t, "dispatcher").query(api.threadQueue.list, { companyId: COMPANY_ID }),
    ).toEqual([]);
    await expect(
      asMember(t, "dispatcher").query(api.threadQueue.getThread, queueIdentity),
    ).rejects.toThrow("another member");
    await expect(
      asEnvironment(t, ENVIRONMENT_TWO).query(api.threadQueue.getThread, {
        ...queueIdentity,
        queueId: first.thread.queueId!,
      }),
    ).rejects.toThrow("another environment");
  });

  it("delivers messages in order and resumes a permanent acceptance after a lost acknowledgement", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await asMember(t, "manager").mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup(),
      attachmentIds: [],
    });
    const environment = asEnvironment(t);
    expect(
      await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }),
    ).toMatchObject([
      {
        threadId: "thread-one",
        commandId: "launch-one",
        revision: 1,
        deliveryAttempt: 0,
        state: "queued",
      },
    ]);
    const accepted = await environment.mutation(api.threadQueue.accept, firstFence);
    expect(accepted?.commandId).toBe("launch-one");
    expect(await environment.mutation(api.threadQueue.accept, firstFence)).toEqual(accepted);
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.cancel, firstFence),
    ).rejects.toThrow("already accepted");
    await environment.mutation(api.threadQueue.acknowledge, firstFence);
    await environment.mutation(api.threadQueue.acknowledge, firstFence);
    expect(
      await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }),
    ).toMatchObject([
      {
        threadId: "thread-one",
        commandId: "followup-one",
        revision: 1,
        deliveryAttempt: 0,
        state: "queued",
      },
    ]);
    expect(
      (await asMember(t, "manager").query(api.threadQueue.list, { companyId: COMPANY_ID }))[0]
        ?.queuedCount,
    ).toBe(1);
  });

  it("moves an unstarted thread atomically and fences an old environment's stale head", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    await enqueue(t);
    await asMember(t, "manager").mutation(api.threadQueue.reassign, {
      ...queueIdentity,
      revision: 1,
      environmentId: ENVIRONMENT_TWO,
      localProjectId: null,
    });
    expect(
      await asEnvironment(t).query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }),
    ).toEqual([]);
    expect(await asEnvironment(t).mutation(api.threadQueue.accept, firstFence)).toBeNull();
    const head = (
      await asEnvironment(t, ENVIRONMENT_TWO).query(api.threadQueue.environmentHead, {
        companyId: COMPANY_ID,
      })
    )[0]!;
    expect(head.revision).toBe(2);
    await asEnvironment(t, ENVIRONMENT_TWO).mutation(api.threadQueue.accept, {
      companyId: COMPANY_ID,
      threadId: head.threadId,
      commandId: head.commandId,
      revision: head.revision,
    });
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.reassign, {
        ...queueIdentity,
        revision: 2,
        environmentId: ENVIRONMENT_ONE,
        localProjectId: null,
      }),
    ).rejects.toThrow("never been accepted");
  });

  it("keeps canceled content, supports editing before acceptance, and rejects stale edits", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const client = asMember(t, "manager");
    await client.mutation(api.threadQueue.edit, { ...firstFence, text: "Updated request" });
    await expect(
      client.mutation(api.threadQueue.edit, { ...firstFence, text: "Stale request" }),
    ).rejects.toThrow("changed");
    await enqueue(t); // A delayed retry cannot undo a later user edit.
    await client.mutation(api.threadQueue.cancel, { ...firstFence, revision: 2 });
    let detail = await client.query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread.state).toBe("canceled");
    expect(detail.messages[0]?.submission).toMatchObject({
      input: { initialMessage: { text: "Updated request" } },
    });
    await client.mutation(api.threadQueue.retry, { ...firstFence, revision: 3 });
    detail = await client.query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread.state).toBe("queued");
    expect(detail.thread.queuedCount).toBe(1);
  });

  it("retains attachment bytes across handoff and rejects unowned metadata references", async () => {
    const t = harness();
    await seed(t);
    const blob = new Blob(["hello"], { type: "text/plain" });
    const storageId = await t.run((ctx) => ctx.storage.store(blob));
    const attachment = {
      type: "file",
      id: "file_one",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    const client = asMember(t, "manager");
    const attachmentId = await client.mutation(api.threadQueue.registerAttachment, {
      companyId: COMPANY_ID,
      storageId,
      attachment,
    });
    await expect(
      asMember(t, "dispatcher").mutation(api.threadQueue.registerAttachment, {
        companyId: COMPANY_ID,
        storageId,
        attachment,
      }),
    ).rejects.toThrow("owned");
    const submission = launch();
    const withFile = {
      ...submission,
      input: {
        ...submission.input,
        initialMessage: { ...submission.input.initialMessage, attachments: [attachment] },
      },
    };
    await expect(
      client.mutation(api.threadQueue.enqueue, {
        ...queueIdentity,
        environmentId: ENVIRONMENT_ONE,
        submission: withFile,
        attachmentIds: [],
      }),
    ).rejects.toThrow("uploaded");
    await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: withFile,
      attachmentIds: [attachmentId],
    });
    const expectedUrl = await t.run((ctx) => ctx.storage.getUrl(storageId));
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).attachmentUrls).toEqual({
      file_one: expectedUrl,
    });
    await expect(
      asMember(t, "dispatcher").query(api.threadQueue.getThread, queueIdentity),
    ).rejects.toThrow("another member");
    await t.run(async (ctx) => {
      const company = (await ctx.db.query("companies").first())!;
      await ctx.db.insert("agentThreads", {
        id: `${ENVIRONMENT_ONE}:thread-one`,
        companyId: company._id,
        environmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        localProjectId: null,
        threadId: "thread-one",
        shell: { title: "Shared conversation" },
        updatedAt: Date.now(),
      });
    });
    expect(
      (await asMember(t, "dispatcher").query(api.threadQueue.getThread, queueIdentity))
        .attachmentUrls,
    ).toEqual({ file_one: expectedUrl });
    const accepted = await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    expect(accepted?.attachments[0]?.attachment).toEqual(attachment);
    expect(accepted?.attachments[0]?.url).toBeTruthy();
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    expect((await client.query(api.threadQueue.getThread, queueIdentity)).attachmentUrls).toEqual(
      {},
    );
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId))?.text())).toBe("hello");
  });
  it("preflights without ownership and never releases an accepted fence on a stale preflight failure", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    await enqueue(t);
    const environment = asEnvironment(t);
    expect((await environment.query(api.threadQueue.prepare, firstFence))?.state).toBe("queued");
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "preflight",
      error: "Provider unavailable",
    });
    let detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread).toMatchObject({ state: "blocked", acceptedAt: null });
    await asMember(t, "manager").mutation(api.threadQueue.retry, firstFence);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "preflight",
      error: "Stale failed preflight",
    });
    detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread.state).toBe("accepted");
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.reassign, {
        ...queueIdentity,
        revision: 1,
        environmentId: ENVIRONMENT_TWO,
        localProjectId: null,
      }),
    ).rejects.toThrow("never been accepted");
  });

  it("blocks later queued turns behind delivery failures and resumes without duplicate acceptance", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await asMember(t, "manager").mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup(),
      attachmentIds: [],
    });
    const environment = asEnvironment(t);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      error: "Disk unavailable after acceptance",
    });
    expect(
      await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }),
    ).toEqual([]);
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.edit, { ...firstFence, text: "Replacement" }),
    ).rejects.toThrow("already accepted");
    await asMember(t, "manager").mutation(api.threadQueue.retry, firstFence);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.acknowledge, firstFence);
    expect(
      (await environment.query(api.threadQueue.environmentHead, { companyId: COMPANY_ID }))[0]
        ?.commandId,
    ).toBe("followup-one");
  });
  it("rejects an idempotency key reused for different intent", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await expect(
      enqueue(t, launch("thread-one", "launch-one", "Different instruction")),
    ).rejects.toThrow("different message");
  });

  it("allows exactly one winner when acceptance races reassignment", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    await enqueue(t);
    const results = await Promise.allSettled([
      asEnvironment(t).mutation(api.threadQueue.accept, firstFence),
      asMember(t, "manager").mutation(api.threadQueue.reassign, {
        ...queueIdentity,
        revision: 1,
        environmentId: ENVIRONMENT_TWO,
        localProjectId: null,
      }),
    ]);
    const accepted = results[0]!.status === "fulfilled" && results[0]!.value !== null;
    const moved = results[1]!.status === "fulfilled";
    expect(Number(accepted) + Number(moved)).toBe(1);
    const detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread.environmentId).toBe(accepted ? ENVIRONMENT_ONE : ENVIRONMENT_TWO);
  });

  it("rechecks submitter permissions at acceptance and exposes registered destinations while offline", async () => {
    const t = harness();
    await seed(t);
    await capabilities(t);
    await enqueue(t);
    const destinations = await asMember(t, "manager").query(
      api.threadQueue.destinations,
      queueIdentity,
    );
    expect(
      destinations.find((row) => row.environmentId === ENVIRONMENT_TWO)?.providers,
    ).toMatchObject([{ instanceId: "codex", modelIds: ["gpt-5"] }]);
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find(
        (row) => row.id === MANAGER_ROLE_ID,
      )!;
      await ctx.db.patch(role._id, { permissions: ["remoteAgents.dispatch"] });
    });
    await expect(asEnvironment(t).mutation(api.threadQueue.accept, firstFence)).rejects.toThrow(
      "remoteAgents.control",
    );
    await asEnvironment(t).mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "preflight",
      error: "Submitting member lost permission to run agents",
    });
    const detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread).toMatchObject({ state: "blocked", acceptedAt: null });
  });
  it("queues a first message preparing a worktree on an existing thread without making its history movable", async () => {
    const t = harness();
    await seed(t);
    await t.run(async (ctx) => {
      const company = (await ctx.db.query("companies").first())!;
      await ctx.db.insert("agentThreads", {
        id: `${ENVIRONMENT_ONE}:thread-one`,
        companyId: company._id,
        environmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        localProjectId: null,
        threadId: "thread-one",
        shell: { title: "Existing empty thread" },
        updatedAt: Date.now(),
      });
    });
    const submission = launch();
    const queued = await asMember(t, "manager").mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: { ...submission, input: { ...submission.input, reuseExistingThread: true } },
      attachmentIds: [],
    });
    expect(queued.thread.launch).toBeNull();
    expect(queued.thread.acceptedAt).not.toBeNull();
    await expect(
      asMember(t, "manager").mutation(api.threadQueue.reassign, {
        ...queueIdentity,
        revision: 1,
        environmentId: ENVIRONMENT_TWO,
        localProjectId: null,
      }),
    ).rejects.toThrow("never been accepted");
    await asMember(t, "manager").mutation(api.threadQueue.cancel, firstFence);
    expect(
      (await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity)).messages[0]
        ?.state,
    ).toBe("canceled");
  });
  it("retries a canceled message at the tail without putting it before newer accepted turns", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const client = asMember(t, "manager");
    await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup("cancel-me"),
      attachmentIds: [],
    });
    await client.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup("newer-message"),
      attachmentIds: [],
    });
    await client.mutation(api.threadQueue.cancel, {
      ...queueIdentity,
      commandId: "cancel-me",
      revision: 1,
    });
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, firstFence);
    await client.mutation(api.threadQueue.retry, {
      ...queueIdentity,
      commandId: "cancel-me",
      revision: 2,
    });
    const heads = await asEnvironment(t).query(api.threadQueue.environmentHead, {
      companyId: COMPANY_ID,
    });
    expect(heads[0]?.commandId).toBe("newer-message");
    const detail = await client.query(api.threadQueue.getThread, queueIdentity);
    expect(detail.messages.map((message) => message.commandId)).toEqual([
      "newer-message",
      "cancel-me",
    ]);
  });
  it("advances delivery identity only after proven rejection and fences stale attempt acknowledgements", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const environment = asEnvironment(t);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      rejection: "command",
      error: "Durably rejected command",
    });
    await asMember(t, "manager").mutation(api.threadQueue.retry, firstFence);
    let candidate = await environment.query(api.threadQueue.prepare, {
      ...firstFence,
      revision: 2,
    });
    expect(candidate).toMatchObject({ revision: 2, deliveryAttempt: 1, state: "accepted" });
    await expect(environment.mutation(api.threadQueue.acknowledge, firstFence)).rejects.toThrow(
      "stale",
    );
    await environment.mutation(api.threadQueue.accept, { ...firstFence, revision: 2 });
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      revision: 2,
      phase: "delivery",
      error: "Connection lost after local write",
    });
    await asMember(t, "manager").mutation(api.threadQueue.retry, { ...firstFence, revision: 2 });
    candidate = await environment.query(api.threadQueue.prepare, { ...firstFence, revision: 2 });
    expect(candidate).toMatchObject({ revision: 2, deliveryAttempt: 1 });
  });

  it("retains a visible failure when preflight fails again after retrying an accepted delivery", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const environment = asEnvironment(t);
    await environment.mutation(api.threadQueue.accept, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      error: "Lost connection after acceptance",
    });
    await asMember(t, "manager").mutation(api.threadQueue.retry, firstFence);
    await environment.mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      error: "Provider unavailable during retry preflight",
    });
    const detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.messages[0]).toMatchObject({
      state: "blocked",
      error: "Provider unavailable during retry preflight",
      deliveryAttempt: 0,
    });
    expect(detail.messages[0]?.acceptedAt).not.toBeNull();
    expect(detail.thread.state).toBe("blocked");
  });

  it("reuses an existing launch thread only when its initial message was proven rejected", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    await asEnvironment(t).mutation(api.threadQueue.accept, firstFence);
    await asEnvironment(t).mutation(api.threadQueue.reportBlocked, {
      ...firstFence,
      phase: "delivery",
      rejection: "initial-message",
      error: "Initial message rejected after thread creation",
    });
    await asMember(t, "manager").mutation(api.threadQueue.retry, firstFence);
    const candidate = await asEnvironment(t).query(api.threadQueue.prepare, {
      ...firstFence,
      revision: 2,
    });
    expect(candidate).toMatchObject({
      deliveryAttempt: 1,
      submission: { kind: "launch", input: { reuseExistingThread: true } },
    });
    const detail = await asMember(t, "manager").query(api.threadQueue.getThread, queueIdentity);
    expect(detail.thread.acceptedAt).not.toBeNull();
  });
  it("shares a published conversation queue under existing read/control permissions while keeping unpublished prompts private", async () => {
    const t = harness();
    await seed(t);
    await enqueue(t);
    const collaborator = asMember(t, "dispatcher");
    expect(await collaborator.query(api.threadQueue.list, { companyId: COMPANY_ID })).toEqual([]);
    await t.run(async (ctx) => {
      const company = (await ctx.db.query("companies").first())!;
      await ctx.db.insert("agentThreads", {
        id: `${ENVIRONMENT_ONE}:thread-one`,
        companyId: company._id,
        environmentId: ENVIRONMENT_ONE,
        cloudProjectId: null,
        localProjectId: null,
        threadId: "thread-one",
        shell: { title: "Shared conversation" },
        updatedAt: Date.now(),
      });
    });
    expect(
      (await collaborator.query(api.threadQueue.getThread, queueIdentity)).messages,
    ).toHaveLength(1);
    await expect(
      collaborator.mutation(api.threadQueue.edit, { ...firstFence, text: "Without control" }),
    ).rejects.toThrow("remoteAgents.control");
    await t.run(async (ctx) => {
      const role = (await ctx.db.query("roles").collect()).find(
        (row) => row.id === DISPATCHER_ROLE_ID,
      )!;
      await ctx.db.patch(role._id, {
        permissions: ["remoteAgents.dispatch", "remoteAgents.control", "environments.read"],
      });
    });
    await collaborator.mutation(api.threadQueue.enqueue, {
      ...queueIdentity,
      environmentId: ENVIRONMENT_ONE,
      submission: followup("collaborator-message"),
      attachmentIds: [],
    });
    await collaborator.mutation(api.threadQueue.edit, {
      ...firstFence,
      text: "Shared edited request",
    });
    expect(
      (await collaborator.query(api.threadQueue.list, { companyId: COMPANY_ID }))[0]?.queuedCount,
    ).toBe(2);
    await asEnvironment(t).mutation(api.threadQueue.accept, { ...firstFence, revision: 2 });
    await asEnvironment(t).mutation(api.threadQueue.acknowledge, { ...firstFence, revision: 2 });
    const candidate = await asEnvironment(t).query(api.threadQueue.prepare, {
      ...queueIdentity,
      commandId: "collaborator-message",
      revision: 1,
    });
    expect(candidate?.issuedByMembershipId).toBe(DISPATCHER_MEMBERSHIP_ID);
  });
});
