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
  const personalBoundaries = new Map<string, Promise<number | null>>();
  return (work: Doc<"aiOrchestratorWork">) => {
    if (!work.companyId) return Promise.resolve(false);
    // Personal assignments are shared only with their original human audience.
    if (work.projectId === null) {
      const companyId = work.companyId;
      if (!personalBoundaries.has(work.chatId))
        personalBoundaries.set(
          work.chatId,
          (async () => {
            const source =
              work.chatId === chat.id
                ? chat
                : await ctx.db
                    .query("aiOrchestratorChats")
                    .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
                    .unique();
            if (
              !source ||
              !chat.participantSubjects.every((subject) =>
                source.participantSubjects.includes(subject),
              )
            )
              return null;
            return sharedHistoryBoundary(ctx, source, chat);
          })(),
        );
      if (!audiences.has(companyId))
        audiences.set(companyId, audienceProjectPermissions(ctx, chat, companyId));
      return (async () => {
        const boundary = await personalBoundaries.get(work.chatId)!;
        return (
          boundary !== null &&
          (work.sourceSequence ?? 0) >= boundary &&
          (await audiences.get(companyId)!) !== null
        );
      })();
    }
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
    // Sharing a fact does not survive losing access to its source conversation.
    if (memory.sourceChatId) {
      const source = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", memory.sourceChatId!))
        .unique();
      if (
        !source ||
        source.lifecycle === "deleted" ||
        source.lifecycle === "deleting" ||
        !source.orchestratorIds.includes(memory.orchestratorId) ||
        !source.participantSubjects.includes(memory.ownerSubject)
      )
        return false;
      const boundary = await sharedHistoryBoundary(ctx, source, source);
      if (boundary === null || (memory.sourceSequence ?? 0) < boundary) return false;
    }
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
            const origin = await ctx.db
              .query("aiOrchestrators")
              .withIndex("by_domain_id", (q) => q.eq("id", memory.orchestratorId))
              .unique();
            return source && origin
              ? await conversationRetrievalBoundary(ctx, origin, source, chat)
              : null;
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
      if (
        contact.projectId &&
        memory.sharedProjectId &&
        (contact.projectId !== memory.sharedProjectId ||
          contact.companyId !== memory.sharedCompanyId)
      )
        return false;
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

/** Follow-up results share the original assignment's mailbox and authority. */
export async function resolveWorkAssignments(ctx: QueryCtx, rows: Doc<"aiOrchestratorWork">[]) {
  const assignments = new Map<
    string,
    { assignment: Doc<"aiOrchestratorWork">; latest: Doc<"aiOrchestratorWork"> }
  >();
  for (const latest of rows) {
    const id = latest.controlWorkId ?? latest.id;
    if (assignments.has(id)) continue;
    const assignment = latest.controlWorkId
      ? await ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_domain_id", (q) => q.eq("id", id))
          .unique()
      : latest;
    if (assignment && assignment.chatId === latest.chatId)
      assignments.set(id, { assignment, latest });
  }
  return [...assignments.values()];
}

/** Page before matching so old conversations remain reachable without an unbounded scan. */
export async function discoverConversations(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  destination: Doc<"aiOrchestratorChats">,
  query: string,
  cursor?: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || query.length > 200)
    throw new Error("Use a search phrase of 1–200 characters.");
  const page = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_owner", (q) => q.eq("ownerSubject", destination.ownerSubject))
    .paginate({ numItems: 25, cursor: cursor ?? null });
  const matches = [];
  for (const source of page.page) {
    const boundary = await conversationRetrievalBoundary(ctx, orchestrator, source, destination);
    if (boundary === null) continue;
    const recent = await ctx.db
      .query("aiOrchestratorMessages")
      .withIndex("by_chat_sequence", (q) => q.eq("chatId", source.id).gte("sequence", boundary))
      .order("desc")
      .take(20);
    const messages = await withoutForgottenSources(ctx, orchestrator, recent);
    // A title/summary can predate a new participant's history boundary.
    const title = boundary === 0 ? source.title : "Conversation";
    const searchable = `${title}\n${messages.map((m) => m.text).join("\n")}`.toLocaleLowerCase();
    if (!terms.every((term) => searchable.includes(term))) continue;
    matches.push({
      chatId: source.id,
      title,
      archived: source.archived,
      messages: boundedConversationMessages(messages, undefined, 1500),
    });
  }
  return { matches, nextCursor: page.isDone ? null : page.continueCursor, complete: page.isDone };
}

/** Apply the same source, audience and project restrictions to discovery and direct reads. */
export async function conversationRetrievalBoundary(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  source: Doc<"aiOrchestratorChats">,
  destination: Doc<"aiOrchestratorChats">,
) {
  if (
    source.lifecycle === "deleting" ||
    source.lifecycle === "deleted" ||
    !source.orchestratorIds.includes(orchestrator.id) ||
    !source.participantSubjects.includes(orchestrator.ownerSubject)
  )
    return null;
  if ((await sharedHistoryBoundary(ctx, source, source)) === null) return null;
  for (const id of new Set([...source.orchestratorIds, ...destination.orchestratorIds])) {
    const contact = await ctx.db
      .query("aiOrchestrators")
      .withIndex("by_domain_id", (q) => q.eq("id", id))
      .unique();
    if (!contact || contact.status === "deleted") return null;
    if (contact.projectId && contact.companyId) {
      const company = await ctx.db
        .query("companies")
        .withIndex("by_domain_id", (q) => q.eq("id", contact.companyId!))
        .unique();
      if (!company) return null;
      const project = await ctx.db
        .query("cloudProjects")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company._id).eq("id", contact.projectId!),
        )
        .unique();
      const readers = await audienceProjectPermissions(ctx, destination, contact.companyId);
      if (
        !project ||
        project.deletedAt !== null ||
        !readers ||
        !readers.every((reader) => hasRecordPermission(reader, "projects.read", project.teamIds))
      )
        return null;
    }
    if (
      orchestrator.projectId &&
      (contact.projectId !== orchestrator.projectId || contact.companyId !== orchestrator.companyId)
    )
      return null;
  }
  return sharedHistoryBoundary(ctx, source, destination);
}

/** Query tombstones by exact source, independent of memory/prompt window sizes. */
export async function withoutForgottenSources(
  ctx: QueryCtx,
  orchestrator: Doc<"aiOrchestrators">,
  messages: ReadonlyArray<Doc<"aiOrchestratorMessages">>,
) {
  const retained = [];
  for (const message of messages) {
    const exclusions = await ctx.db
      .query("aiOrchestratorMemory")
      .withIndex("by_source_forgotten", (q) =>
        q
          .eq("sourceChatId", message.chatId)
          .eq("forgotten", true)
          .eq("sourceSequence", message.sequence),
      )
      .take(81);
    const forgotten =
      exclusions.length > 80 ||
      exclusions.some(
        (memory) =>
          memory.orchestratorId === orchestrator.id ||
          (memory.ownerSubject === orchestrator.ownerSubject &&
            (memory.scope === "personal" ||
              (memory.scope === "project" &&
                memory.sharedProjectId === orchestrator.projectId &&
                memory.sharedCompanyId === orchestrator.companyId))),
      );
    if (!forgotten) retained.push(message);
  }
  return retained;
}
