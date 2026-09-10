// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
/** Cloud-owned thread intent. Acceptance is a permanent fence, never an expiring execution lease. */
import { v } from "convex/values";
import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@spiritdevs/contracts";
import type {
  ThreadQueueAcceptance,
  ThreadQueueDetail,
  ThreadQueueHead,
  ThreadQueueMessage,
  ThreadQueueSubmission,
  ThreadQueueSubmissionStatus,
  ThreadQueueThread,
} from "@spiritdevs/contracts/threadQueue";
import {
  canonicalQueueJson,
  queueSubmissionFingerprint,
  decodeQueueSubmission,
  submissionMessage,
  THREAD_QUEUE_MAX_MESSAGES,
  validateAttachment,
  validateModelSelection,
} from "../src/threadQueue.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { backendError } from "./lib/errors.ts";
import {
  requireCompanyActor,
  membershipAuthorization,
  requirePermission,
  requireRecordPermission,
  type CompanyActor,
  type MemberActor,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const identityArgs = { companyId: domainIdArg, threadId: v.string() };
const messageArgs = { ...identityArgs, commandId: v.string() };
const fenceArgs = { ...messageArgs, revision: v.number() };
const invalid = (message: string) => backendError("invalid-arguments", message);

function member(actor: CompanyActor): asserts actor is MemberActor {
  if (actor.kind !== "member")
    throw backendError(
      "permission-denied",
      "A signed-in member must submit or change queued work.",
    );
  requirePermission(actor, "remoteAgents.dispatch");
}
function validate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Invalid submission.");
  }
}
async function threadById(ctx: QueryCtx, companyId: Id<"companies">, threadId: string) {
  return ctx.db
    .query("threadQueueThreads")
    .withIndex("by_company_and_thread", (q) =>
      q.eq("companyId", companyId).eq("threadId", threadId),
    )
    .unique();
}
async function messageById(ctx: QueryCtx, companyId: Id<"companies">, commandId: string) {
  return ctx.db
    .query("threadQueueMessages")
    .withIndex("by_company_and_command", (q) =>
      q.eq("companyId", companyId).eq("commandId", commandId),
    )
    .unique();
}
async function publishedThread(ctx: QueryCtx, thread: Doc<"threadQueueThreads">) {
  return ctx.db
    .query("agentThreads")
    .withIndex("by_company_and_environment_and_thread", (q) =>
      q
        .eq("companyId", thread.companyId)
        .eq("environmentId", thread.environmentId)
        .eq("threadId", thread.threadId),
    )
    .unique();
}
async function canReadThread(ctx: QueryCtx, actor: MemberActor, thread: Doc<"threadQueueThreads">) {
  if (thread.issuedByMembershipId === actor.membership._id) return true;
  if (!actor.permissions.isOwner && !actor.permissions.company.has("environments.read"))
    return false;
  // Publishing is the existing conversation visibility boundary. Pending unpublished prompts
  // remain private to their author even when another member controls the same environment.
  return (await publishedThread(ctx, thread)) !== null;
}
async function authorizeThread(
  ctx: QueryCtx,
  actor: CompanyActor,
  thread: Doc<"threadQueueThreads">,
) {
  if (actor.kind === "member") {
    member(actor);
    if (!(await canReadThread(ctx, actor, thread)))
      throw backendError(
        "permission-denied",
        "This unpublished queued conversation belongs to another member.",
      );
  } else if (actor.registration.environmentId !== thread.environmentId) {
    throw backendError("permission-denied", "This queue belongs to another environment.");
  }
}
async function ownedThread(ctx: QueryCtx, args: { companyId: string; threadId: string }) {
  const actor = await requireCompanyActor(ctx, args.companyId);
  const thread = await threadById(ctx, actor.company._id, args.threadId);
  if (!thread) throw backendError("entity-not-found", "Queued thread not found.");
  await authorizeThread(ctx, actor, thread);
  return { actor, thread };
}
async function queuedMessage(
  ctx: QueryCtx,
  args: { companyId: string; threadId: string; commandId: string },
) {
  const result = await ownedThread(ctx, args);
  const message = await messageById(ctx, result.actor.company._id, args.commandId);
  if (!message || message.threadId !== args.threadId)
    throw backendError("entity-not-found", "Queued message not found.");
  return { ...result, message };
}
async function target(
  ctx: QueryCtx,
  actor: CompanyActor,
  environmentId: string,
  localProjectId: string | null,
) {
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
    )
    .unique();
  if (!registration || registration.state !== "active")
    throw backendError("environment-unavailable", "Select a registered environment.");
  requireRecordPermission(actor, "remoteAgents.dispatch", registration.teamIds);
  if (localProjectId === null) return null;
  const bindings = await ctx.db
    .query("environmentBindings")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
    )
    .collect();
  const binding = bindings.find(
    (row) => row.localProjectId === localProjectId && row.status === "active",
  );
  if (!binding)
    throw backendError(
      "binding-unavailable",
      "Select an active project directory on this environment.",
    );
  const project = await ctx.db.get(binding.cloudProjectId);
  if (!project || project.deletedAt !== null || project.archivedAt !== null)
    throw backendError("binding-unavailable", "The bound project is no longer available.");
  requireRecordPermission(actor, "remoteAgents.dispatch", project.teamIds);
  return binding.cloudProjectId;
}
async function wireThread(
  ctx: QueryCtx,
  row: Doc<"threadQueueThreads">,
): Promise<ThreadQueueThread> {
  const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
  return {
    threadId: row.threadId,
    environmentId: row.environmentId,
    localProjectId: row.localProjectId,
    cloudProjectId: project?.id ?? null,
    title: row.title,
    launch: row.launch,
    state: row.state,
    error: row.error,
    revision: row.revision,
    acceptedAt: row.acceptedAt,
    queuedCount: row.queuedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function wireMessage(row: Doc<"threadQueueMessages">): ThreadQueueMessage {
  return {
    deliveryAttempt: row.deliveryAttempt ?? 0,
    rejection: row.rejection ?? null,
    commandId: row.commandId,
    messageId: row.messageId,
    sequence: row.sequence,
    revision: row.revision,
    state: row.state,
    error: row.error,
    submission: row.submission,
    attachmentIds: row.attachmentIds,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
async function firstOutstanding(ctx: QueryCtx, thread: Doc<"threadQueueThreads">) {
  const states = ["queued", "accepted", "blocked"] as const;
  const heads = await Promise.all(
    states.map((state) =>
      ctx.db
        .query("threadQueueMessages")
        .withIndex("by_company_thread_and_state", (q) =>
          q.eq("companyId", thread.companyId).eq("threadId", thread.threadId).eq("state", state),
        )
        .first(),
    ),
  );
  return heads.filter((row) => row !== null).sort((a, b) => a.sequence - b.sequence)[0] ?? null;
}
async function refreshThread(ctx: MutationCtx, thread: Doc<"threadQueueThreads">) {
  const head = await firstOutstanding(ctx, thread);
  await ctx.db.patch(thread._id, {
    state: head?.state ?? "delivered",
    error: head?.error ?? null,
    updatedAt: Date.now(),
  });
}

export const generateUploadUrl = mutation({
  args: { companyId: domainIdArg },
  handler: async (ctx, args) => {
    member(await requireCompanyActor(ctx, args.companyId));
    return ctx.storage.generateUploadUrl();
  },
});
export const registerAttachment = mutation({
  args: { companyId: domainIdArg, storageId: v.id("_storage"), attachment: v.any() },
  handler: async (ctx, args): Promise<string> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    member(actor);
    const attachment = validate(() => validateAttachment(args.attachment));
    const existing = await ctx.db
      .query("threadQueueAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (existing) {
      if (
        existing.companyId !== actor.company._id ||
        existing.issuedByMembershipId !== actor.membership._id ||
        canonicalQueueJson(existing.attachment) !== canonicalQueueJson(attachment)
      )
        throw backendError(
          "permission-denied",
          "This upload is already owned by another submission.",
        );
      return existing._id;
    }
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      !metadata ||
      metadata.size !== attachment.sizeBytes ||
      (metadata.contentType && metadata.contentType !== attachment.mimeType)
    )
      throw invalid("Uploaded bytes do not match the attachment metadata.");
    return ctx.db.insert("threadQueueAttachments", {
      companyId: actor.company._id,
      issuedByMembershipId: actor.membership._id,
      storageId: args.storageId,
      attachment,
      createdAt: Date.now(),
    });
  },
});
async function attachmentsForSubmission(
  ctx: QueryCtx,
  actor: MemberActor,
  submission: ThreadQueueSubmission,
  ids: string[],
) {
  const attachments = submissionMessage(submission).attachments;
  if (ids.length !== attachments.length || new Set(ids).size !== ids.length)
    throw invalid("Every attachment must be uploaded before submission.");
  for (let index = 0; index < ids.length; index++) {
    const storageRowId = ctx.db.normalizeId("threadQueueAttachments", ids[index]!);
    const row = storageRowId ? await ctx.db.get(storageRowId) : null;
    if (
      !row ||
      row.companyId !== actor.company._id ||
      row.issuedByMembershipId !== actor.membership._id ||
      canonicalQueueJson(row.attachment) !== canonicalQueueJson(attachments[index])
    )
      throw backendError(
        "attachment-unavailable",
        "An attachment is not durably uploaded for this member.",
      );
  }
}

export const enqueue = mutation({
  args: {
    ...identityArgs,
    environmentId: v.string(),
    submission: v.any(),
    attachmentIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<ThreadQueueDetail> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    member(actor);
    requirePermission(actor, "remoteAgents.control");
    let submission = validate(() => decodeQueueSubmission(args.submission, args.threadId));
    if (submission.kind === "launch") {
      const companyId = submission.input.conversationCompanyId;
      if (companyId != null && companyId !== args.companyId)
        throw invalid("Conversation company must match its queue.");
      // Clients display conversations in a synthetic project, while the environment creates
      // them with a null project. Never resolve that UI identity as a directory binding.
      if (
        companyId === args.companyId &&
        submission.input.projectId === `conversations:${companyId}`
      )
        submission = { ...submission, input: { ...submission.input, projectId: null } };
    }
    const input = submission.input;
    const content = submissionMessage(submission);
    const fingerprint = await queueSubmissionFingerprint({
      submission,
      attachmentIds: args.attachmentIds,
    });
    const existingMessage = await messageById(ctx, actor.company._id, input.commandId);
    let thread = await threadById(ctx, actor.company._id, args.threadId);
    if (existingMessage) {
      if (
        !thread ||
        existingMessage.threadId !== args.threadId ||
        existingMessage.issuedByMembershipId !== actor.membership._id
      )
        throw backendError("submission-conflict", "Command identity is already in use.");
      await authorizeThread(ctx, actor, thread);
      // Identity survives edits and destination changes: retries cannot resurrect old content.
      if (
        existingMessage.messageId !== content.messageId ||
        existingMessage.submissionFingerprint !== fingerprint
      )
        throw backendError("submission-conflict", "Command identity names a different message.");
      return { thread: await wireThread(ctx, thread), messages: [wireMessage(existingMessage)] };
    }
    const duplicateMessage = await ctx.db
      .query("threadQueueMessages")
      .withIndex("by_company_and_message", (q) =>
        q.eq("companyId", actor.company._id).eq("messageId", content.messageId),
      )
      .unique();
    if (duplicateMessage)
      throw backendError("submission-conflict", "Message identity is already in use.");
    await attachmentsForSubmission(ctx, actor, submission, args.attachmentIds);
    const now = Date.now();
    if (!thread) {
      let localProjectId: string | null;
      let title: string;
      let launch: ThreadQueueThread["launch"] = null;
      if (submission.kind === "launch" && !submission.input.reuseExistingThread) {
        if (
          submission.input.projectId === null &&
          submission.input.conversationCompanyId !== args.companyId
        )
          throw invalid("Conversation company must match its queue.");
        localProjectId = submission.input.projectId;
        title = submission.input.title;
        const { initialMessage: _initialMessage, ...metadata } = submission.input;
        launch = metadata;
      } else {
        const shell = await ctx.db
          .query("agentThreads")
          .withIndex("by_company_and_environment_and_thread", (q) =>
            q
              .eq("companyId", actor.company._id)
              .eq("environmentId", args.environmentId)
              .eq("threadId", args.threadId),
          )
          .unique();
        if (!shell)
          throw backendError(
            "thread-unavailable",
            "The environment has not published this conversation yet.",
          );
        if (submission.kind === "launch" && submission.input.projectId !== shell.localProjectId)
          throw invalid("Existing thread project must match its published directory.");
        localProjectId = shell.localProjectId;
        title = typeof shell.shell?.title === "string" ? shell.shell.title : "Conversation";
      }
      const cloudProjectId = await target(ctx, actor, args.environmentId, localProjectId);
      const id = await ctx.db.insert("threadQueueThreads", {
        companyId: actor.company._id,
        threadId: args.threadId,
        environmentId: args.environmentId,
        localProjectId,
        cloudProjectId,
        issuedByMembershipId: actor.membership._id,
        title,
        launch,
        state: "queued",
        error: null,
        revision: 1,
        acceptedAt: launch ? null : now,
        nextSequence: 0,
        queuedCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      thread = (await ctx.db.get(id))!;
    } else {
      await authorizeThread(ctx, actor, thread);
      if (thread.environmentId !== args.environmentId)
        throw backendError(
          "destination-changed",
          "This conversation was moved to another environment. Refresh before sending.",
        );
      if (submission.kind === "launch")
        throw backendError("submission-conflict", "This thread already has a launch submission.");
      if (thread.state === "canceled")
        throw backendError(
          "invalid-command-state",
          "Retry the canceled thread before adding messages.",
        );
    }
    if (thread.queuedCount >= THREAD_QUEUE_MAX_MESSAGES)
      throw invalid(
        "This thread has too many pending messages. Cancel or deliver some before adding more.",
      );
    const messageId = await ctx.db.insert("threadQueueMessages", {
      companyId: actor.company._id,
      threadId: args.threadId,
      commandId: input.commandId,
      messageId: content.messageId,
      issuedByMembershipId: actor.membership._id,
      sequence: thread.nextSequence,
      revision: 1,
      state: "queued",
      error: null,
      submission,
      submissionFingerprint: fingerprint,
      attachmentIds: args.attachmentIds,
      acceptedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(thread._id, {
      nextSequence: thread.nextSequence + 1,
      queuedCount: thread.queuedCount + 1,
      updatedAt: now,
    });
    await refreshThread(ctx, thread);
    return {
      thread: await wireThread(ctx, (await ctx.db.get(thread._id))!),
      messages: [wireMessage((await ctx.db.get(messageId))!)],
    };
  },
});

export const list = query({
  args: { companyId: domainIdArg },
  handler: async (ctx, args): Promise<ThreadQueueThread[]> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    member(actor);
    const rows = await ctx.db
      .query("threadQueueThreads")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    const visible = await Promise.all(
      rows.map(async (row) =>
        (await canReadThread(ctx, actor, row)) ? wireThread(ctx, row) : null,
      ),
    );
    return visible.filter((row) => row !== null);
  },
});
export const getThread = query({
  args: identityArgs,
  handler: async (ctx, args): Promise<ThreadQueueDetail> => {
    const { thread } = await ownedThread(ctx, args);
    // Delivered bodies are environment history. Fetch only visible queued work rather than
    // retransmitting a growing lifetime transcript for every queue update.
    const messages = (
      await Promise.all(
        (["queued", "accepted", "blocked", "canceled"] as const).map((state) =>
          ctx.db
            .query("threadQueueMessages")
            .withIndex("by_company_thread_and_state", (q) =>
              q
                .eq("companyId", thread.companyId)
                .eq("threadId", thread.threadId)
                .eq("state", state),
            )
            .collect(),
        ),
      )
    )
      .flat()
      .sort((a, b) => a.sequence - b.sequence);
    const attachmentEntries = await Promise.all(
      [...new Set(messages.flatMap((message) => message.attachmentIds))].map(async (id) => {
        const rowId = ctx.db.normalizeId("threadQueueAttachments", id);
        const row = rowId ? await ctx.db.get(rowId) : null;
        if (!row || row.companyId !== thread.companyId) return null;
        const url = await ctx.storage.getUrl(row.storageId);
        return url ? ([row.attachment.id, url] as const) : null;
      }),
    );
    return {
      thread: await wireThread(ctx, thread),
      messages: messages.map(wireMessage),
      attachmentUrls: Object.fromEntries(attachmentEntries.filter((entry) => entry !== null)),
    };
  },
});
export const submissionStatus = query({
  args: { ...identityArgs, commandId: domainIdArg },
  handler: async (ctx, args): Promise<ThreadQueueSubmissionStatus | null> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind === "member") member(actor);
    const thread = await threadById(ctx, actor.company._id, args.threadId);
    if (!thread) return null;
    await authorizeThread(ctx, actor, thread);
    const message = await messageById(ctx, actor.company._id, args.commandId);
    if (!message || message.threadId !== thread.threadId) return null;
    return {
      threadId: thread.threadId,
      commandId: message.commandId,
      messageId: message.messageId,
      state: message.state,
      revision: message.revision,
      deliveryAttempt: message.deliveryAttempt ?? 0,
    };
  },
});
export const environmentHead = query({
  args: { companyId: domainIdArg },
  handler: async (ctx, args): Promise<ThreadQueueHead[]> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      throw backendError("permission-denied", "Only an environment can consume its queue.");
    const threads = (
      await Promise.all(
        (["queued", "accepted"] as const).map((state) =>
          ctx.db
            .query("threadQueueThreads")
            .withIndex("by_company_environment_and_state", (q) =>
              q
                .eq("companyId", actor.company._id)
                .eq("environmentId", actor.registration.environmentId)
                .eq("state", state),
            )
            .collect(),
        ),
      )
    ).flat();
    const heads: ThreadQueueHead[] = [];
    for (const thread of threads) {
      const head = await firstOutstanding(ctx, thread);
      if (head && head.state !== "blocked")
        heads.push({
          threadId: head.threadId,
          commandId: head.commandId,
          revision: head.revision,
          deliveryAttempt: head.deliveryAttempt ?? 0,
          state: head.acceptedAt === null ? "queued" : "accepted",
        });
    }
    return heads;
  },
});
function checkFence(actor: CompanyActor, message: Doc<"threadQueueMessages">, revision: number) {
  if (actor.kind !== "environment")
    throw backendError(
      "permission-denied",
      "Only the assigned environment may accept queued work.",
    );
  if (message.revision !== revision)
    throw backendError("stale-command-claim", "This queued message changed before acceptance.");
}
async function prepareAcceptance(
  ctx: QueryCtx,
  args: { companyId: string; threadId: string; commandId: string; revision: number },
): Promise<ThreadQueueAcceptance | null> {
  const actor = await requireCompanyActor(ctx, args.companyId);
  if (actor.kind !== "environment")
    throw backendError("permission-denied", "Only an environment can consume queued work.");
  const thread = await threadById(ctx, actor.company._id, args.threadId);
  const message = await messageById(ctx, actor.company._id, args.commandId);
  if (
    !thread ||
    !message ||
    thread.environmentId !== actor.registration.environmentId ||
    message.threadId !== thread.threadId ||
    message.revision !== args.revision ||
    (message.state !== "queued" && message.state !== "accepted")
  )
    return null;
  const head = await firstOutstanding(ctx, thread);
  if (head?._id !== message._id) return null;
  const membership = await ctx.db.get(message.issuedByMembershipId);
  if (!membership || membership.state !== "active")
    throw backendError("permission-denied", "The submitting member no longer has access.");
  const user = await ctx.db.get(membership.userId);
  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", actor.company._id).eq("membershipId", membership._id),
    )
    .unique();
  if (!user) throw backendError("permission-denied", "The submitting account no longer exists.");
  const authorization = await membershipAuthorization(ctx, membership, owner !== null);
  const issuer: MemberActor = {
    kind: "member",
    user,
    membership,
    company: actor.company,
    isOwner: owner !== null,
    ...authorization,
  };
  member(issuer);
  requirePermission(issuer, "remoteAgents.control");
  const currentProject = await target(ctx, issuer, thread.environmentId, thread.localProjectId);
  if (currentProject !== thread.cloudProjectId)
    throw backendError(
      "binding-unavailable",
      "The selected directory now belongs to another project.",
    );
  const attachments: { attachment: ChatAttachment; url: string }[] = [];
  for (const id of message.attachmentIds) {
    const rowId = ctx.db.normalizeId("threadQueueAttachments", id);
    const row = rowId ? await ctx.db.get(rowId) : null;
    const url = row ? await ctx.storage.getUrl(row.storageId) : null;
    if (!row || row.companyId !== thread.companyId || !url)
      throw backendError("attachment-unavailable", "A queued attachment is unavailable.");
    attachments.push({ attachment: row.attachment, url });
  }
  const original = message.submission as ThreadQueueSubmission;
  const submission =
    original.kind === "launch" && message.retryReusesThread
      ? { ...original, input: { ...original.input, reuseExistingThread: true } }
      : original;
  return {
    threadId: thread.threadId,
    commandId: message.commandId,
    revision: message.revision,
    deliveryAttempt: message.deliveryAttempt ?? 0,
    state: message.acceptedAt === null ? "queued" : "accepted",
    submission,
    localProjectId: thread.localProjectId,
    issuedByMembershipId: membership.id,
    attachments,
  };
}
/** Download and inspect prerequisites before acquiring the irreversible execution fence. */
export const prepare = query({ args: fenceArgs, handler: prepareAcceptance });
export const accept = mutation({
  args: fenceArgs,
  handler: async (ctx, args): Promise<ThreadQueueAcceptance | null> => {
    const prepared = await prepareAcceptance(ctx, args);
    if (!prepared) return null;
    const { thread, message } = await queuedMessage(ctx, args);
    const now = Date.now();
    await ctx.db.patch(message._id, {
      state: "accepted",
      acceptedAt: message.acceptedAt ?? now,
      updatedAt: now,
      error: null,
    });
    await ctx.db.patch(thread._id, {
      state: "accepted",
      acceptedAt: thread.acceptedAt ?? now,
      updatedAt: now,
      error: null,
    });
    return { ...prepared, state: "accepted" };
  },
});
export const acknowledge = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    const { actor, thread, message } = await queuedMessage(ctx, args);
    checkFence(actor, message, args.revision);
    if (message.state === "delivered") return null;
    if (message.state !== "accepted")
      throw backendError(
        "invalid-command-state",
        "Only durably accepted work may be acknowledged.",
      );
    await ctx.db.patch(message._id, { state: "delivered", updatedAt: Date.now(), error: null });
    await ctx.db.patch(thread._id, { queuedCount: Math.max(0, thread.queuedCount - 1) });
    await refreshThread(ctx, thread);
    return null;
  },
});
export const reportBlocked = mutation({
  args: {
    ...fenceArgs,
    error: v.string(),
    phase: v.union(v.literal("preflight"), v.literal("delivery")),
    rejection: v.optional(v.union(v.literal("command"), v.literal("initial-message"))),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      throw backendError("permission-denied", "Only an environment can report delivery failures.");
    const thread = await threadById(ctx, actor.company._id, args.threadId);
    const message = await messageById(ctx, actor.company._id, args.commandId);
    if (
      !thread ||
      !message ||
      thread.environmentId !== actor.registration.environmentId ||
      message.threadId !== thread.threadId ||
      message.revision !== args.revision
    )
      return null;
    if (args.phase === "preflight" && (message.acceptedAt !== null || message.state !== "queued"))
      return null;
    if (
      args.phase === "delivery" &&
      (message.acceptedAt === null || (message.state !== "accepted" && message.state !== "queued"))
    )
      return null;
    await ctx.db.patch(message._id, {
      state: "blocked",
      error: args.error.slice(0, 2000),
      ...(args.phase === "delivery" && args.rejection ? { rejection: args.rejection } : {}),
      updatedAt: Date.now(),
    });
    await refreshThread(ctx, thread);
    return null;
  },
});

function requireRevision(message: { revision: number }, revision: number) {
  if (message.revision !== revision)
    throw backendError(
      "stale-command-claim",
      "This queued work changed on another device. Refresh before changing it.",
    );
}
function requireEditable(message: Doc<"threadQueueMessages">) {
  if (message.acceptedAt !== null || message.state === "delivered" || message.state === "accepted")
    throw backendError("already-accepted", "The environment has already accepted this message.");
}
export const edit = mutation({
  args: { ...fenceArgs, text: v.string() },
  handler: async (ctx, args) => {
    const { actor, thread, message } = await queuedMessage(ctx, args);
    member(actor);
    requirePermission(actor, "remoteAgents.control");
    requireRevision(message, args.revision);
    requireEditable(message);
    const original = message.submission as ThreadQueueSubmission;
    const submission: ThreadQueueSubmission =
      original.kind === "launch"
        ? {
            ...original,
            input: {
              ...original.input,
              initialMessage: { ...submissionMessage(original), text: args.text },
            },
          }
        : { ...original, input: { ...original.input, text: args.text } };
    validate(() => decodeQueueSubmission(submission, thread.threadId));
    await ctx.db.patch(message._id, {
      submission,
      revision: message.revision + 1,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(thread._id, { updatedAt: Date.now() });
    return null;
  },
});
export const cancel = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    const { actor, thread, message } = await queuedMessage(ctx, args);
    member(actor);
    requirePermission(actor, "remoteAgents.control");
    requireRevision(message, args.revision);
    requireEditable(message);
    if (message.state === "canceled") return null;
    if ((message.submission as ThreadQueueSubmission).kind === "launch" && thread.launch !== null) {
      if (thread.acceptedAt !== null)
        throw backendError("already-accepted", "The environment has already accepted this thread.");
      const rows = await ctx.db
        .query("threadQueueMessages")
        .withIndex("by_company_thread_and_sequence", (q) =>
          q.eq("companyId", thread.companyId).eq("threadId", thread.threadId),
        )
        .collect();
      for (const row of rows) {
        requireEditable(row);
        await ctx.db.patch(row._id, {
          state: "canceled",
          revision: row.revision + 1,
          updatedAt: Date.now(),
        });
      }
      await ctx.db.patch(thread._id, {
        state: "canceled",
        queuedCount: 0,
        error: null,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(message._id, {
        state: "canceled",
        revision: message.revision + 1,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(thread._id, { queuedCount: Math.max(0, thread.queuedCount - 1) });
      await refreshThread(ctx, thread);
    }
    return null;
  },
});
export const retry = mutation({
  args: fenceArgs,
  handler: async (ctx, args) => {
    const { actor, thread, message } = await queuedMessage(ctx, args);
    member(actor);
    requirePermission(actor, "remoteAgents.control");
    requireRevision(message, args.revision);
    if (message.state === "queued" || message.state === "accepted") return null;
    if (message.state !== "blocked" && message.state !== "canceled")
      throw backendError("invalid-command-state", "Delivered messages cannot be retried.");
    if (
      thread.state === "canceled" &&
      (message.submission as ThreadQueueSubmission).kind !== "launch"
    )
      throw backendError(
        "invalid-command-state",
        "Retry the thread's first message before its follow-ups.",
      );
    if (message.state === "canceled" && thread.queuedCount >= THREAD_QUEUE_MAX_MESSAGES)
      throw invalid(
        "This thread has too many pending messages. Deliver or cancel some before retrying.",
      );
    // Keep the original revision after uncertain delivery: the environment retries its stable command.
    await ctx.db.patch(message._id, {
      state: "queued",
      error: null,
      updatedAt: Date.now(),
      ...(message.state === "canceled" ? { sequence: thread.nextSequence } : {}),
      ...(message.rejection
        ? {
            deliveryAttempt: (message.deliveryAttempt ?? 0) + 1,
            revision: message.revision + 1,
            retryReusesThread:
              message.retryReusesThread === true || message.rejection === "initial-message",
            rejection: null,
          }
        : {}),
    });
    if (message.state === "canceled")
      await ctx.db.patch(thread._id, {
        queuedCount: thread.queuedCount + 1,
        nextSequence: thread.nextSequence + 1,
      });
    await refreshThread(ctx, thread);
    return null;
  },
});
export const reassign = mutation({
  args: {
    ...identityArgs,
    revision: v.number(),
    environmentId: v.string(),
    localProjectId: v.union(v.string(), v.null()),
    workspaceStrategy: v.optional(v.any()),
    modelSelection: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ThreadQueueThread> => {
    const { actor, thread } = await ownedThread(ctx, args);
    member(actor);
    requirePermission(actor, "remoteAgents.control");
    requireRevision(thread, args.revision);
    if (!thread.launch || thread.acceptedAt !== null || (await publishedThread(ctx, thread)))
      throw backendError(
        "already-accepted",
        "Only threads that have never been accepted can move to another environment.",
      );
    const cloudProjectId = await target(ctx, actor, args.environmentId, args.localProjectId);
    if (thread.cloudProjectId !== cloudProjectId)
      throw invalid("Choose a directory bound to the same cloud project.");
    const original = thread.launch as NonNullable<ThreadQueueThread["launch"]>;
    const modelSelection = (args.modelSelection ?? original.modelSelection) as ModelSelection;
    validate(() => validateModelSelection(modelSelection));
    const capability = await ctx.db
      .query("environmentProviderCapabilities")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", args.environmentId),
      )
      .unique();
    const provider = capability?.providers.find(
      (row) =>
        row.instanceId === modelSelection.instanceId &&
        row.enabled &&
        row.available &&
        row.modelIds.includes(modelSelection.model),
    );
    if (!provider)
      throw backendError(
        "provider-unavailable",
        "Select an available provider and model on the replacement environment.",
      );
    const workspaceStrategy = (args.workspaceStrategy ??
      original.workspaceStrategy) as OrchestrationV2ThreadLaunchWorkspaceStrategy;
    if (
      args.environmentId !== thread.environmentId &&
      workspaceStrategy.type === "existing_worktree"
    )
      throw invalid(
        "An existing worktree path cannot be transferred between environments. Choose the project root or a new worktree.",
      );
    const launch = {
      ...original,
      projectId: args.localProjectId as typeof original.projectId,
      modelSelection,
      workspaceStrategy,
    };
    const rows = await ctx.db
      .query("threadQueueMessages")
      .withIndex("by_company_thread_and_sequence", (q) =>
        q.eq("companyId", thread.companyId).eq("threadId", thread.threadId),
      )
      .collect();
    for (const row of rows) {
      requireEditable(row);
      const submission = row.submission as ThreadQueueSubmission;
      const updated: ThreadQueueSubmission =
        submission.kind === "launch"
          ? {
              kind: "launch",
              input: { ...launch, initialMessage: submission.input.initialMessage },
            }
          : { ...submission, input: { ...submission.input, modelSelection } };
      validate(() => decodeQueueSubmission(updated, thread.threadId));
      await ctx.db.patch(row._id, {
        submission: updated,
        revision: row.revision + 1,
        state: row.state === "blocked" ? "queued" : row.state,
        error: null,
        updatedAt: Date.now(),
      });
    }
    await ctx.db.patch(thread._id, {
      environmentId: args.environmentId,
      localProjectId: args.localProjectId,
      launch,
      revision: thread.revision + 1,
      error: null,
      updatedAt: Date.now(),
    });
    if (thread.state !== "canceled") await refreshThread(ctx, thread);
    return wireThread(ctx, (await ctx.db.get(thread._id))!);
  },
});

/** Registered destinations and last published capabilities remain discoverable while hosts are offline. */
export const destinations = query({
  args: { companyId: domainIdArg, threadId: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<import("@spiritdevs/contracts/threadQueue").ThreadQueueDestination[]> => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    member(actor);
    const thread = args.threadId ? await threadById(ctx, actor.company._id, args.threadId) : null;
    if (args.threadId && !thread)
      throw backendError("entity-not-found", "Queued thread not found.");
    if (thread) await authorizeThread(ctx, actor, thread);
    const registrations = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_state", (q) =>
        q.eq("companyId", actor.company._id).eq("state", "active"),
      )
      .collect();
    const bindings = await ctx.db
      .query("environmentBindings")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    const projects = await ctx.db
      .query("cloudProjects")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    const capabilityRows = await ctx.db
      .query("environmentProviderCapabilities")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    return registrations.map((registration) => {
      const capabilities = capabilityRows.find(
        (row) => row.environmentId === registration.environmentId,
      );
      return {
        environmentId: registration.environmentId,
        durableThreadQueue: registration.descriptor?.capabilities?.durableThreadQueue === true,
        label:
          typeof registration.descriptor?.label === "string"
            ? registration.descriptor.label
            : registration.environmentId,
        projects: bindings
          .filter(
            (binding) =>
              binding.environmentId === registration.environmentId &&
              binding.status === "active" &&
              (!thread || binding.cloudProjectId === thread.cloudProjectId),
          )
          .flatMap((binding) => {
            const project = projects.find(
              (row) =>
                row._id === binding.cloudProjectId &&
                row.deletedAt === null &&
                row.archivedAt === null,
            );
            return project
              ? [
                  {
                    localProjectId: binding.localProjectId,
                    title: project.name,
                    workspaceRoot: binding.localWorkspaceRoot,
                    cloudProjectId: project.id,
                  },
                ]
              : [];
          }),
        providers: (capabilities?.providers ?? []).map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driverKind,
          displayName: provider.instanceId,
          modelIds: provider.modelIds,
          enabled: provider.enabled,
          available: provider.available,
        })),
      };
    });
  },
});
