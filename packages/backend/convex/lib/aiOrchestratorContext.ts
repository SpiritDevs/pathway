import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { orchestratorOwnerScope } from "./aiOrchestratorAuthority.ts";
import { hasRecordPermission } from "../../src/permissions.ts";
import type { EffectivePermissions } from "../../src/permissions.ts";
import { membershipAuthorization } from "./identity.ts";

/** Resolve each human once per workspace before including project facts in a group response. */
export async function audienceProjectPermissions(
  ctx: QueryCtx,
  chat: Doc<"aiOrchestratorChats">,
  companyId: string,
) {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyId))
    .unique();
  if (!company || company.lifecycleState !== "active") return null;
  const permissions: EffectivePermissions[] = [];
  for (const subject of chat.participantSubjects) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
      .unique();
    if (!user) return null;
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_user", (q) =>
        q.eq("companyId", company._id).eq("userId", user._id),
      )
      .unique();
    if (member?.state !== "active") return null;
    const owner = await ctx.db
      .query("companyOwners")
      .withIndex("by_company_and_membership", (q) =>
        q.eq("companyId", company._id).eq("membershipId", member._id),
      )
      .unique();
    permissions.push((await membershipAuthorization(ctx, member, !!owner)).permissions);
  }
  return permissions;
}

export function workVisibilityForConversation(ctx: QueryCtx, chat: Doc<"aiOrchestratorChats">) {
  const visibility = new Map<string, Promise<boolean>>();
  const audiences = new Map<string, ReturnType<typeof audienceProjectPermissions>>();
  return (work: Doc<"aiOrchestratorWork">) => {
    if (!work.companyId) return Promise.resolve(false);
    // Personal assignments are shared only with their original human audience.
    if (work.projectId === null)
      return (async () => {
        const source = await ctx.db
          .query("aiOrchestratorChats")
          .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
          .unique();
        if (
          !source ||
          !chat.participantSubjects.every((subject) => source.participantSubjects.includes(subject))
        )
          return false;
        const boundary = await sharedHistoryBoundary(ctx, source, chat);
        return (
          boundary !== null &&
          (work.sourceSequence ?? 0) >= boundary &&
          (await audienceProjectPermissions(ctx, chat, work.companyId!)) !== null
        );
      })();
    const companyId = work.companyId,
      key = `${companyId}:${work.projectId}`;
    if (!visibility.has(key))
      visibility.set(
        key,
        (async () => {
          const company = await ctx.db
            .query("companies")
            .withIndex("by_domain_id", (q) => q.eq("id", companyId))
            .unique();
          if (!company) return false;
          const project = await ctx.db
            .query("cloudProjects")
            .withIndex("by_company_and_domain_id", (q) =>
              q.eq("companyId", company._id).eq("id", work.projectId!),
            )
            .unique();
          if (!project || project.deletedAt !== null) return false;
          if (!audiences.has(companyId))
            audiences.set(companyId, audienceProjectPermissions(ctx, chat, companyId));
          const readers = await audiences.get(companyId)!;
          return (
            !!readers &&
            readers.every((reader) => hasRecordPermission(reader, "projects.read", project.teamIds))
          );
        })(),
      );
    return visibility.get(key)!;
  };
}

/** Retrieved context must be readable by the audience that will receive the answer. */
export async function sharedHistoryBoundary(
  ctx: QueryCtx,
  source: Doc<"aiOrchestratorChats">,
  destination: Doc<"aiOrchestratorChats">,
) {
  if (destination.orchestratorIds.some((id) => !source.orchestratorIds.includes(id))) return null;
  let boundary = Math.max(
    0,
    ...(source.orchestratorHistory ?? [])
      .filter((entry) => destination.orchestratorIds.includes(entry.orchestratorId))
      .map((entry) => entry.fromSequence),
  );
  for (const subject of destination.participantSubjects) {
    const member = await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", source.id).eq("subject", subject))
      .unique();
    if (!member) return null;
    boundary = Math.max(boundary, member.fromSequence);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
      .unique();
    if (!user) return null;
    for (const id of source.companyIds) {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", id))
        .unique();
      if (!company || company.lifecycleState !== "active") return null;
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_user", (q) =>
          q.eq("companyId", company._id).eq("userId", user._id),
        )
        .unique();
      if (membership?.state !== "active") return null;
    }
  }
  return boundary;
}

/** Keep the triggering message intact, even when newer queued messages fill recent history. */
export function boundedConversationMessages(
  recent: ReadonlyArray<Doc<"aiOrchestratorMessages">>,
  trigger?: Doc<"aiOrchestratorMessages">,
  budget = 48000,
) {
  const selected = new Map<string, Doc<"aiOrchestratorMessages">>();
  let remaining = budget;
  if (trigger) {
    selected.set(trigger.id, trigger);
    remaining -= trigger.text.length;
  }
  for (const message of recent) {
    if (selected.has(message.id) || remaining <= 0) continue;
    const limit = Math.min(4000, remaining);
    const marker = "\n[Earlier text shortened]";
    if (message.text.length > limit && limit < marker.length) continue;
    const text =
      message.text.length <= limit
        ? message.text
        : `${message.text.slice(0, limit - marker.length)}${marker}`;
    selected.set(message.id, { ...message, text });
    remaining -= text.length;
  }
  return [...selected.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(
      ({
        id,
        senderId,
        senderKind,
        senderName,
        text,
        status,
        sequence,
        attachments,
        replyToId,
        worker,
      }) => ({
        replyToId,
        ...(worker ? { worker } : {}),
        ...(attachments?.length ? { attachments } : {}),
        id,
        senderId,
        senderKind,
        senderName,
        text,
        status,
        sequence,
      }),
    );
}

export function memoryVisibilityForConversation(ctx: QueryCtx, chat: Doc<"aiOrchestratorChats">) {
  const histories = new Map<string, Promise<number | null>>();
  const permissions = new Map<string, ReturnType<typeof audienceProjectPermissions>>();
  let contactsPromise: Promise<Array<Doc<"aiOrchestrators"> | null>> | undefined;
  return async (memory: Doc<"aiOrchestratorMemory">) => {
    // Explicitly shared facts carry their own audience; their source transcript remains private.
    if (memory.sourceChatId && memory.scope === "orchestrator") {
      if (!histories.has(memory.sourceChatId))
        histories.set(
          memory.sourceChatId,
          (async () => {
            const source = await ctx.db
              .query("aiOrchestratorChats")
              .withIndex("by_domain_id", (q) => q.eq("id", memory.sourceChatId!))
              .unique();
            return source ? await sharedHistoryBoundary(ctx, source, chat) : null;
          })(),
        );
      const boundary = await histories.get(memory.sourceChatId)!;
      return boundary !== null && (memory.sourceSequence ?? 0) >= boundary;
    }
    const contacts = await (contactsPromise ??= Promise.all(
      chat.orchestratorIds.map((id) =>
        ctx.db
          .query("aiOrchestrators")
          .withIndex("by_domain_id", (q) => q.eq("id", id))
          .unique(),
      ),
    ));
    if (!memory.sharedCompanyId) {
      return (
        chat.participantSubjects.every((subject) => subject === memory.ownerSubject) &&
        contacts.every(
          (contact) => contact && !contact.shared && contact.ownerSubject === memory.ownerSubject,
        )
      );
    }
    // Sharing an orchestrator later never exposes facts recorded while it was private.
    for (const contact of contacts) {
      if (!contact) return false;
      const scope = await orchestratorOwnerScope(ctx, contact, memory.sharedCompanyId);
      if (!scope) return false;
      if (memory.sharedProjectId) {
        const project = await ctx.db
          .query("cloudProjects")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", scope.company._id).eq("id", memory.sharedProjectId!),
          )
          .unique();
        if (
          !project ||
          project.deletedAt !== null ||
          project.archivedAt !== null ||
          !hasRecordPermission(scope.permissions, "projects.read", project.teamIds)
        )
          return false;
        if (!permissions.has(memory.sharedCompanyId))
          permissions.set(
            memory.sharedCompanyId,
            audienceProjectPermissions(ctx, chat, memory.sharedCompanyId),
          );
        const readers = await permissions.get(memory.sharedCompanyId)!;
        if (
          !readers ||
          !readers.every((reader) => hasRecordPermission(reader, "projects.read", project.teamIds))
        )
          return false;
      }
    }
    // A project fact is visible only in conversations that explicitly include its workspace.
    if (!chat.companyIds.includes(memory.sharedCompanyId)) return false;
    return (await sharedHistoryBoundary(ctx, chat, chat)) !== null;
  };
}

/** Keep recent attachment context available on follow-up turns, bounded like normal compose. */
export async function conversationReasoningAttachments(
  ctx: QueryCtx,
  chat: Doc<"aiOrchestratorChats">,
  trigger: Doc<"aiOrchestratorMessages">,
) {
  const boundary = await sharedHistoryBoundary(ctx, chat, chat);
  if (boundary === null) return [];
  const recent = await ctx.db
    .query("aiOrchestratorMessages")
    .withIndex("by_chat_sequence", (q) => q.eq("chatId", chat.id).gte("sequence", boundary))
    .order("desc")
    .take(40);
  const attachments = new Map<
    string,
    NonNullable<Doc<"aiOrchestratorMessages">["attachments"]>[number]
  >();
  for (const message of [trigger, ...recent]) {
    if (message.sequence < boundary) continue;
    for (const attachment of message.attachments ?? []) {
      if (attachments.size >= 8) break;
      attachments.set(attachment.id, attachment);
    }
  }
  return [...attachments.values()];
}
