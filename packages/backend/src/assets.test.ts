// @effect-diagnostics globalDate:off -- Convex test fixture clock.
import { convexTest } from "convex-test";
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import schema from "../convex/schema.ts";
import { api, internal } from "../convex/_generated/api.js";
const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/assets.ts": () => import("../convex/assets.ts"),
  "../convex/assetStorage.ts": () => import("../convex/assetStorage.ts"),
  "../convex/http.ts": () => import("../convex/http.ts"),
};
const companyId = "asset-company",
  checksum = "a".repeat(64);
async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const now = Date.now();
    const company = await ctx.db.insert("companies", {
      id: companyId,
      name: "Assets",
      issueKeyPrefix: "AST",
      nextIssueNumber: 1,
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      authorizationEpoch: 1,
      syncVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const name of ["uploader", "viewer", "admin"]) {
      const user = await ctx.db.insert("users", {
        clerkSubject: name,
        email: `${name}@example.test`,
        displayName: name,
        imageUrl: null,
        createdAt: now,
        updatedAt: now,
      });
      const member = await ctx.db.insert("memberships", {
        id: name,
        companyId: company,
        userId: user,
        state: "active",
        displayNameSnapshot: name,
        emailSnapshot: `${name}@example.test`,
        invitedByMembershipId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const role = await ctx.db.insert("roles", {
        id: `${name}-role`,
        companyId: company,
        name,
        description: "",
        permissions:
          name === "admin"
            ? ["company.manage", "assets.share", "environments.read"]
            : name === "uploader"
              ? ["assets.share", "environments.read"]
              : ["environments.read"],
        seeded: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("roleAssignments", {
        id: `${name}-assignment`,
        companyId: company,
        membershipId: member,
        roleId: role,
        scope: "company",
        teamId: null,
        createdAt: now,
      });
    }
    await ctx.db.insert("agentThreads", {
      id: "env:thread",
      companyId: company,
      environmentId: "env",
      threadId: "thread",
      cloudProjectId: null,
      localProjectId: null,
      shell: { title: "Visible thread" },
      updatedAt: now,
    });
  });
  process.env.CONVEX_SITE_URL = "https://assets.example.test";
  const as = (subject: string) =>
    t.withIdentity({
      issuer: "https://clerk.test",
      subject,
      tokenIdentifier: `https://clerk.test|${subject}`,
    });
  return { t, as };
}
async function original(
  as: ReturnType<Awaited<ReturnType<typeof setup>>["as"]>,
  context?: { kind: "thread"; id: string; environmentId: string },
) {
  const row = await as.mutation(internal.assets.reserve, {
    companyId,
    clientRequestId: "request",
    fileName: "proof.png",
    mimeType: "image/png",
    byteSize: 10,
    checksum,
    ...(context ? { context } : {}),
  });
  await as.mutation(internal.assets.setUpload, {
    companyId,
    assetId: row.id,
    key: "private-key",
    url: "https://ingest.test/upload",
  });
  await as.mutation(internal.assets.complete, {
    companyId,
    assetId: row.id,
    key: "private-key",
    byteSize: 10,
    checksum,
    previewReady: true,
  });
  return row.id;
}
describe("company assets", () => {
  it("keeps standalone assets private while admins can manage them", async () => {
    const { as } = await setup();
    const id = await original(as("uploader"));
    expect(await as("viewer").query(api.assets.get, { companyId, assetId: id })).toBeNull();
    expect(
      (await as("admin").query(api.assets.get, { companyId, assetId: id }))?.permissions.canManage,
    ).toBe(true);
    await expect(
      as("viewer").mutation(api.assets.resolve, { companyId, assetId: id }),
    ).rejects.toThrow();
  });
  it("makes retry reservations idempotent and rejects different originals", async () => {
    const { as } = await setup(),
      u = as("uploader");
    const args = {
      companyId,
      clientRequestId: "same",
      fileName: "x",
      mimeType: "application/octet-stream",
      byteSize: 10,
      checksum,
    };
    const first = await u.mutation(internal.assets.reserve, args);
    expect((await u.mutation(internal.assets.reserve, args)).id).toBe(first.id);
    await expect(u.mutation(internal.assets.reserve, { ...args, byteSize: 11 })).rejects.toThrow();
    expect((await u.query(api.assets.list, { companyId })).usage.reservedBytes).toBe(10);
  });
  it("serializes concurrent quota reservations", async () => {
    const { as } = await setup();
    await as("admin").mutation(api.assets.configureQuota, {
      companyId,
      maxFileBytes: 10,
      maxBytes: 15,
    });
    const u = as("uploader"),
      result = await Promise.allSettled(
        ["one", "two"].map((clientRequestId) =>
          u.mutation(internal.assets.reserve, {
            companyId,
            clientRequestId,
            fileName: "x",
            mimeType: "text/plain",
            byteSize: 10,
            checksum,
          }),
        ),
      );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await u.query(api.assets.list, { companyId })).usage.reservedBytes).toBe(10);
  });
  it("requires visibility confirmation, then allows viewers but not management", async () => {
    const { as } = await setup(),
      u = as("uploader"),
      id = await original(u),
      context = { kind: "thread" as const, id: "thread", environmentId: "env" };
    await expect(
      u.mutation(api.assets.attach, {
        companyId,
        assetId: id,
        context,
        confirmBroaderAccess: false,
      }),
    ).rejects.toThrow();
    await u.mutation(api.assets.attach, {
      companyId,
      assetId: id,
      context,
      confirmBroaderAccess: true,
    });
    const visible = await as("viewer").query(api.assets.get, { companyId, assetId: id });
    expect(visible?.contexts).toEqual([{ ...context, title: "Visible thread" }]);
    expect(visible?.permissions.canManage).toBe(false);
    await expect(
      as("viewer").mutation(api.assets.trash, { companyId, assetId: id }),
    ).rejects.toThrow();
  });
  it("revokes shares and read tickets on trash; restore does not revive them", async () => {
    const { t, as } = await setup(),
      u = as("uploader"),
      assetId = await original(u);
    const share = await u.mutation(api.assets.share, { companyId, assetId });
    const read = await u.mutation(api.assets.resolve, { companyId, assetId });
    const token = (url: string) => new URL(url).searchParams.get("token")!;
    expect(
      await t.query(internal.assets.authorizeRead, { token: token(share.url) }),
    ).not.toBeNull();
    await u.mutation(api.assets.trash, { companyId, assetId });
    expect(await t.query(internal.assets.authorizeRead, { token: token(share.url) })).toBeNull();
    expect(await t.query(internal.assets.authorizeRead, { token: token(read.url) })).toBeNull();
    await u.mutation(api.assets.restore, { companyId, assetId });
    expect(await t.query(internal.assets.authorizeRead, { token: token(share.url) })).toBeNull();
  });
  it("checks current membership on every read request", async () => {
    const { t, as } = await setup(),
      u = as("uploader"),
      assetId = await original(u),
      read = await u.mutation(api.assets.resolve, { companyId, assetId });
    const token = new URL(read.url).searchParams.get("token")!;
    expect(await t.query(internal.assets.authorizeRead, { token })).not.toBeNull();
    await t.run(async (ctx) => {
      const member = (await ctx.db.query("memberships").collect()).find(
        (m) => m.id === "uploader",
      )!;
      await ctx.db.patch(member._id, { state: "locked" });
    });
    expect(await t.query(internal.assets.authorizeRead, { token })).toBeNull();
  });
  it("retains reused assets when removing one context and hides inaccessible usage", async () => {
    const { as } = await setup(),
      u = as("uploader"),
      context = { kind: "thread" as const, id: "thread", environmentId: "env" },
      assetId = await original(u, context);
    await u.mutation(api.assets.keep, { companyId, assetId, keep: true });
    await u.mutation(api.assets.detach, { companyId, assetId, context });
    expect((await u.query(api.assets.get, { companyId, assetId }))?.state).toBe("ready");
    expect(await as("viewer").query(api.assets.get, { companyId, assetId })).toBeNull();
  });
  it("verifies bytes before releasing quota reservation", async () => {
    const { as } = await setup(),
      u = as("uploader");
    const row = await u.mutation(internal.assets.reserve, {
      companyId,
      clientRequestId: "bad",
      fileName: "x",
      mimeType: "text/plain",
      byteSize: 10,
      checksum,
    });
    await u.mutation(internal.assets.setUpload, {
      companyId,
      assetId: row.id,
      key: "key",
      url: "https://ingest.test",
    });
    await expect(
      u.mutation(internal.assets.complete, {
        companyId,
        assetId: row.id,
        key: "key",
        byteSize: 9,
        checksum,
        previewReady: false,
      }),
    ).rejects.toThrow();
    expect((await u.query(api.assets.list, { companyId })).usage.reservedBytes).toBe(10);
  });
});

afterEach(() => vi.unstubAllGlobals());
it("authorizes ranges before storage access and serves untrusted files as downloads", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    assetId = await original(u),
    resolved = await u.mutation(api.assets.resolve, { companyId, assetId });
  process.env.UPLOADTHING_TOKEN = "sk_fixture";
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    String(input).includes("requestFileAccess")
      ? Response.json({ url: "https://private.test/file" })
      : new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { "content-range": "bytes 0-1/10", "content-length": "2" },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const path = new URL(resolved.url).pathname + new URL(resolved.url).search;
  const result = await t.fetch(path, { headers: { Range: "bytes=0-1" } });
  expect(result.status).toBe(206);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("content-range")).toBe("bytes 0-1/10");
  expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ Range: "bytes=0-1" });
  await u.mutation(api.assets.trash, { companyId, assetId });
  const calls = fetcher.mock.calls.length;
  expect((await t.fetch(path, { headers: { Range: "bytes=2-3" } })).status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
it("fences purge before deleting bytes and only then releases quota", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    assetId = await original(u);
  await u.mutation(api.assets.trash, { companyId, assetId });
  const id = await t.run(async (ctx) => {
    const r = (await ctx.db.query("assets").collect())[0]!;
    await ctx.db.patch(r._id, { trashedAt: Date.now() - 31 * 86400_000 });
    return r._id;
  });
  expect(await t.mutation(internal.assets.claimCleanup, { id })).toBe(true);
  await u.mutation(api.assets.restore, { companyId, assetId });
  expect((await u.query(api.assets.get, { companyId, assetId }))?.state).toBe("purged");
  expect((await u.query(api.assets.list, { companyId })).usage.usedBytes).toBe(10);
  await t.mutation(internal.assets.finishCleanup, { id });
  await t.mutation(internal.assets.finishCleanup, { id });
  expect((await u.query(api.assets.list, { companyId })).usage.usedBytes).toBe(0);
});
it("limits processing to explicit service permission and revokes a worker read on role removal", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    assetId = await original(u);
  process.env.PATHWAY_RELAY_JWT_ISSUER = "https://assets-relay.test";
  process.env.PATHWAY_RELAY_JWKS_URL = "https://assets-relay.test/.well-known/jwks.json";
  const env = t.withIdentity({
    issuer: "https://assets-relay.test",
    subject: "worker",
    tokenIdentifier: "https://assets-relay.test|worker",
    cnf: { jkt: "worker-key" },
  });
  const registrationId = await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!;
    const asset = (await ctx.db.query("assets").collect())[0]!;
    await ctx.db.patch(asset._id, { state: "preparing", previewState: "pending" });
    return ctx.db.insert("environmentRegistrations", {
      id: "worker-reg",
      companyId: company._id,
      environmentId: "worker",
      publicKeyThumbprint: "worker-key",
      descriptor: {
        environmentId: "worker",
        label: "Worker",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: { repositoryIdentity: true },
      },
      relayLinkState: "linked",
      managedEndpointAvailable: true,
      lastSeenAt: Date.now(),
      serviceRoleIds: [],
      teamIds: [],
      state: "active",
      registeredByMembershipId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  await expect(env.mutation(api.assets.claimProcessing, { companyId })).rejects.toThrow();
  await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!;
    await ctx.db.insert("roles", {
      id: "processor",
      companyId: company._id,
      name: "Processor",
      description: "",
      permissions: ["assets.process"],
      seeded: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(registrationId, { serviceRoleIds: ["processor"] });
  });
  const claim = await env.mutation(api.assets.claimProcessing, { companyId });
  expect(claim?.assetId).toBe(assetId);
  expect(await env.mutation(api.assets.claimProcessing, { companyId })).toBeNull();
  const token = new URL(claim!.original.url).searchParams.get("token")!;
  expect(await t.query(internal.assets.authorizeRead, { token })).not.toBeNull();
  await t.run((ctx) => ctx.db.patch(registrationId, { serviceRoleIds: [] }));
  expect(await t.query(internal.assets.authorizeRead, { token })).toBeNull();
});

it("migrates a legacy cloud upload to verified private bytes with a stable metadata alias", async () => {
  const { t, as } = await setup(),
    u = as("uploader");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const legacyId = await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!,
      member = (await ctx.db.query("memberships").collect()).find((m) => m.id === "uploader")!;
    const storageId = await ctx.storage.store(new Blob([bytes]));
    const attachmentId = await ctx.db.insert("threadQueueAttachments", {
      companyId: company._id,
      issuedByMembershipId: member._id,
      storageId,
      attachment: {
        id: "legacy-metadata-id",
        type: "image",
        name: "legacy.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      },
      createdAt: Date.now(),
    });
    const queueThreadId = await ctx.db.insert("threadQueueThreads", {
      companyId: company._id,
      threadId: "thread",
      environmentId: "env",
      localProjectId: null,
      cloudProjectId: null,
      issuedByMembershipId: member._id,
      title: "Visible thread",
      launch: null,
      state: "delivered",
      error: null,
      revision: 1,
      acceptedAt: Date.now(),
      nextSequence: 1,
      queuedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("threadQueueMessages", {
      companyId: company._id,
      threadId: "thread",
      queueThreadId,
      commandId: "legacy-command",
      messageId: "legacy-message",
      issuedByMembershipId: member._id,
      sequence: 0,
      revision: 1,
      state: "delivered",
      error: null,
      submission: {},
      submissionFingerprint: "legacy-fingerprint",
      attachmentIds: [attachmentId],
      acceptedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return attachmentId;
  });
  process.env.UPLOADTHING_TOKEN = "sk_fixture";
  let privateRequested = false,
    streamed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("prepareUpload")) {
        privateRequested = JSON.parse(String(init?.body)).acl === "private";
        return Response.json({ key: "migrated-private-key", url: "https://ingest.test/private" });
      }
      if (url.includes("requestFileAccess"))
        return Response.json({ url: "https://private.test/object" });
      if (init?.method === "PUT") {
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
        }
        streamed = total > bytes.length;
        return Response.json({ success: true });
      }
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    }),
  );
  const migrated = await u.action(api.assets.migrateLegacy, {
    companyId,
    source: "queue",
    legacyId,
  });
  expect(privateRequested).toBe(true);
  expect(streamed).toBe(true);
  expect(migrated.originalReady).toBe(true);
  expect(migrated.state).toBe("ready");
  expect(
    (
      await u.query(api.assets.resolveLegacy, {
        companyId,
        source: "queue",
        legacyId: "legacy-metadata-id",
      })
    )?.id,
  ).toBe(migrated.id);
  // Fixture ID was produced by the server's createDeterministicAttachmentId("thread", "legacy-metadata-id").
  const acceptedId = "thread-19a1502a-81fc-ad99-c99f-9e6dbe78b94a";
  expect(
    (
      await as("viewer").query(api.assets.resolveLegacy, {
        companyId,
        source: "queue",
        legacyId: acceptedId,
      })
    )?.id,
  ).toBe(migrated.id);
  expect(migrated.contexts).toContainEqual({
    kind: "thread",
    id: "thread",
    environmentId: "env",
    messageId: "legacy-message",
    title: "Visible thread",
  });
  expect((await u.query(api.assets.threadCounts, { companyId }))[0]?.count).toBe(1);
  await t.run(async (ctx) => {
    const role = (await ctx.db.query("roles").collect()).find((r) => r.id === "viewer-role")!;
    await ctx.db.patch(role._id, { permissions: [] });
  });
  expect(
    await as("viewer").query(api.assets.resolveLegacy, {
      companyId,
      source: "queue",
      legacyId: acceptedId,
    }),
  ).toBeNull();
  expect(
    (await u.query(api.assets.legacyList, { companyId, source: "queue" })).items[0]?.migrationState,
  ).toBe("migrated");
  expect(
    (await u.action(api.assets.migrateLegacy, { companyId, source: "queue", legacyId })).id,
  ).toBe(migrated.id);
  expect((await u.query(api.assets.list, { companyId })).usage.usedBytes).toBe(bytes.length);
});
it("maintains one indexed thread count per asset across reuse, Trash, restore and detach", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    context = { kind: "thread" as const, id: "thread", environmentId: "env" },
    assetId = await original(u, context);
  const counts = () => u.query(api.assets.threadCounts, { companyId });
  expect(await counts()).toEqual([{ threadId: "thread", environmentId: "env", count: 1 }]);
  const second = { ...context, messageId: "second-message" };
  await u.mutation(api.assets.attach, {
    companyId,
    assetId,
    context: second,
    confirmBroaderAccess: true,
  });
  expect(await counts()).toEqual([{ threadId: "thread", environmentId: "env", count: 1 }]);
  expect(await t.run((ctx) => ctx.db.query("assetThreadCounts").collect())).toHaveLength(1);
  await u.mutation(api.assets.trash, { companyId, assetId });
  expect(await counts()).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("assetThreadCounts").collect())).toHaveLength(0);
  await u.mutation(api.assets.restore, { companyId, assetId });
  expect(await counts()).toEqual([{ threadId: "thread", environmentId: "env", count: 1 }]);
  await u.mutation(api.assets.detach, { companyId, assetId, context });
  expect((await counts())[0]?.count).toBe(1);
  await u.mutation(api.assets.detach, { companyId, assetId, context: second });
  expect(await counts()).toEqual([]);
  expect((await u.query(api.assets.get, { companyId, assetId }))?.state).toBe("trashed");
});
it("requires real service management and sharing grants, never just asserted user instruction", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    context = { kind: "thread" as const, id: "thread", environmentId: "env" },
    assetId = await original(u, context);
  process.env.PATHWAY_RELAY_JWT_ISSUER = "https://asset-management-relay.test";
  process.env.PATHWAY_RELAY_JWKS_URL = "https://asset-management-relay.test/.well-known/jwks.json";
  const env = t.withIdentity({
    issuer: "https://asset-management-relay.test",
    subject: "env",
    tokenIdentifier: "https://asset-management-relay.test|env",
    cnf: { jkt: "management-key" },
  });
  const roleId = await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!;
    const roleId = await ctx.db.insert("roles", {
      id: "asset-management",
      companyId: company._id,
      name: "Asset management",
      description: "",
      permissions: [],
      seeded: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("environmentRegistrations", {
      id: "management-env",
      companyId: company._id,
      environmentId: "env",
      publicKeyThumbprint: "management-key",
      descriptor: {
        environmentId: "env",
        label: "Environment",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "1.0.0",
        capabilities: { repositoryIdentity: true },
      },
      relayLinkState: "linked",
      managedEndpointAvailable: true,
      lastSeenAt: Date.now(),
      serviceRoleIds: ["asset-management"],
      teamIds: [],
      state: "active",
      registeredByMembershipId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return roleId;
  });
  const request = { companyId, assetId, context };
  await expect(
    env.mutation(api.assets.agentManage, {
      ...request,
      operation: "trash",
      explicitUserInstruction: true,
    }),
  ).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch(roleId, { permissions: ["assets.manage"] }));
  expect(
    (
      await env.mutation(api.assets.agentManage, {
        ...request,
        operation: "rename",
        name: "Reviewed.png",
      })
    ).asset.name,
  ).toBe("Reviewed.png");
  await expect(
    env.mutation(api.assets.agentManage, { ...request, operation: "trash" }),
  ).rejects.toThrow();
  await expect(
    env.mutation(api.assets.agentManage, {
      ...request,
      operation: "share",
      explicitUserInstruction: true,
    }),
  ).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch(roleId, { permissions: ["assets.manage", "assets.share"] }));
  const result = await env.mutation(api.assets.agentManage, {
    ...request,
    operation: "share",
    explicitUserInstruction: true,
  });
  const token = new URL(result.share!.url).searchParams.get("token")!;
  expect(await t.query(internal.assets.authorizeRead, { token })).not.toBeNull();
  await env.mutation(api.assets.agentManage, {
    ...request,
    operation: "trash",
    explicitUserInstruction: true,
  });
  expect(await t.query(internal.assets.authorizeRead, { token })).toBeNull();
  expect(
    (await env.mutation(api.assets.agentManage, { ...request, operation: "restore" })).asset.state,
  ).toBe("ready");
  expect(await t.query(internal.assets.authorizeRead, { token })).toBeNull();
  await env.mutation(api.assets.agentManage, {
    ...request,
    context: { ...context, messageId: "another-message" },
    operation: "attach",
    explicitUserInstruction: true,
  });
  expect((await u.query(api.assets.threadCounts, { companyId }))[0]?.count).toBe(1);
  await t.run(async (ctx) => {
    const company = (await ctx.db.query("companies").collect())[0]!;
    await ctx.db.insert("agentThreads", {
      id: "env:other",
      companyId: company._id,
      environmentId: "env",
      threadId: "other",
      cloudProjectId: null,
      localProjectId: null,
      shell: { title: "Other thread" },
      updatedAt: Date.now(),
    });
  });
  await u.mutation(api.assets.attach, {
    companyId,
    assetId,
    context: { ...context, id: "other" },
    confirmBroaderAccess: true,
  });
  await expect(
    env.mutation(api.assets.agentManage, {
      ...request,
      operation: "trash",
      explicitUserInstruction: true,
    }),
  ).rejects.toThrow();
  await expect(
    env.mutation(api.assets.agentManage, {
      ...request,
      operation: "share",
      explicitUserInstruction: true,
    }),
  ).rejects.toThrow();
});
it("serves M4A preview ranges inline with the audio/mp4 content type", async () => {
  const { t, as } = await setup(),
    u = as("uploader"),
    assetId = await original(u);
  await t.run(async (ctx) => {
    const asset = (await ctx.db.query("assets").collect())[0]!;
    await ctx.db.patch(asset._id, { kind: "audio", name: "recording.wav", mimeType: "audio/wav" });
    await ctx.db.insert("assetRepresentations", {
      companyId: asset.companyId,
      assetId,
      kind: "preview",
      name: "preview.m4a",
      lease: "completed-preview",
      key: "private-m4a-key",
      byteSize: 10,
      checksum,
      mimeType: "audio/mp4",
      state: "ready",
      createdAt: Date.now(),
    });
  });
  const resolved = await u.mutation(api.assets.resolve, {
    companyId,
    assetId,
    representation: "preview",
  });
  expect(resolved.mimeType).toBe("audio/mp4");
  expect(resolved.name).toBe("preview.m4a");
  process.env.UPLOADTHING_TOKEN = "sk_fixture";
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    String(input).includes("requestFileAccess")
      ? Response.json({ url: "https://private.test/preview.m4a" })
      : new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: {
            "content-range": "bytes 2-5/10",
            "content-length": "4",
            "accept-ranges": "bytes",
          },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const url = new URL(resolved.url),
    result = await t.fetch(url.pathname + url.search, { headers: { Range: "bytes=2-5" } });
  expect(result.status).toBe(206);
  expect(result.headers.get("content-type")).toBe("audio/mp4");
  expect(result.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''preview.m4a");
  expect(result.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(result.headers.get("accept-ranges")).toBe("bytes");
  expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({ Range: "bytes=2-5" });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    fileKey: "private-m4a-key",
  });
});
