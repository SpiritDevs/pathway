// @effect-diagnostics globalDate:off -- Convex supplies transaction time.
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { appendChatMessage, canDirectOrchestrator } from "../aiOrchestrators.ts";
import { backendError } from "./errors.ts";
import { mintDomainId } from "./domainIds.ts";
import { membershipAuthorization } from "./identity.ts";
import { hasRecordPermission } from "../../src/permissions.ts";
import { inheritAllowanceScopes } from "../providerAllowanceBudgets.ts";

/** A contact's directory card and project scope are visible to every human in this audience. */
export async function contactVisibleToAudience(
  ctx: QueryCtx,
  contact: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
) {
  if (contact.status === "deleted" || contact.status === "archived") return false;
  for (const subject of chat.participantSubjects) {
    if (subject !== contact.ownerSubject && !contact.shared) return false;
    if (!contact.companyId) continue;
    if (subject !== contact.ownerSubject && !chat.companyIds.includes(contact.companyId))
      return false;
    const company = await ctx.db
      .query("companies")
      .withIndex("by_domain_id", (q) => q.eq("id", contact.companyId!))
      .unique();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
      .unique();
    if (!company || company.lifecycleState !== "active" || !user) return false;
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_company_and_user", (q) =>
        q.eq("companyId", company._id).eq("userId", user._id),
      )
      .unique();
    if (member?.state !== "active") return false;
    if (contact.projectId) {
      const project = await ctx.db
        .query("cloudProjects")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company._id).eq("id", contact.projectId!),
        )
        .unique();
      const owner = await ctx.db
        .query("companyOwners")
        .withIndex("by_company_and_membership", (q) =>
          q.eq("companyId", company._id).eq("membershipId", member._id),
        )
        .unique();
      const { permissions } = await membershipAuthorization(ctx, member, !!owner);
      if (
        !project ||
        project.deletedAt !== null ||
        project.archivedAt !== null ||
        !hasRecordPermission(permissions, "projects.read", project.teamIds)
      )
        return false;
    }
  }
  return true;
}

export async function collaborationDirectory(
  ctx: QueryCtx,
  chat: Doc<"aiOrchestratorChats">,
  companyId: string,
) {
  const owned = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_owner", (q) => q.eq("ownerSubject", chat.ownerSubject))
    .take(200);
  const shared = await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_company", (q) => q.eq("companyId", companyId).eq("shared", true))
    .take(100);
  const visible = [];
  for (const contact of new Map([...owned, ...shared].map((row) => [row.id, row])).values()) {
    if (
      canDirectOrchestrator(contact, chat.ownerSubject) &&
      (await contactVisibleToAudience(ctx, contact, chat))
    )
      visible.push(contact);
    if (visible.length === 60) break;
  }
  return visible;
}

/** Creates a continuing group with the existing human audience, without copying any other chat. */
export async function startCollaboration(
  ctx: MutationCtx,
  input: {
    source: Doc<"aiOrchestratorChats">;
    orchestrator: Doc<"aiOrchestrators">;
    companyId: string;
    chainDepth: number;
    title: string;
    orchestratorIds: readonly string[];
    text: string;
  },
) {
  const fail = (message: string): never => {
    throw backendError("orchestrator-collaboration", message);
  };
  const ids = [...new Set([input.orchestrator.id, ...input.orchestratorIds])];
  if (!input.orchestrator.capabilities.includes("orchestrators.message") || input.chainDepth >= 8)
    return fail(
      "This orchestrator cannot start another collaboration without a new user instruction.",
    );
  if (
    ids.length < 2 ||
    ids.length > 12 ||
    !input.title.trim() ||
    input.title.length > 120 ||
    !input.text.trim() ||
    input.text.length > 16000
  )
    return fail("Choose a short collaboration title, two to twelve contacts, and a message.");
  const directory = await collaborationDirectory(ctx, input.source, input.companyId);
  if (ids.some((id) => !directory.some((contact) => contact.id === id)))
    return fail("Every participant needs access to the chosen contacts and their projects.");
  const contacts = directory.filter((contact) => ids.includes(contact.id));
  const existing = await ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_owner", (q) => q.eq("ownerSubject", input.source.ownerSubject))
    .take(200);
  const sameMembers = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id) => right.includes(id));
  let chat = existing.find(
    (row) =>
      !row.archived &&
      row.kind === "group" &&
      sameMembers(row.orchestratorIds, ids) &&
      sameMembers(row.participantSubjects, input.source.participantSubjects),
  );
  if (!chat) {
    const now = Date.now(),
      id = mintDomainId(now);
    const rowId = await ctx.db.insert("aiOrchestratorChats", {
      id,
      title: input.title.trim(),
      kind: "group",
      ownerSubject: input.source.ownerSubject,
      orchestratorIds: ids,
      leadId: input.orchestrator.id,
      participantSubjects: input.source.participantSubjects,
      companyIds: [
        ...new Set([
          ...input.source.companyIds,
          ...contacts.flatMap((c) => (c.companyId ? [c.companyId] : [])),
        ]),
      ],
      archived: false,
      lastSequence: 0,
      lastMessage: "",
      summary: "",
      summaryThroughSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const subject of input.source.participantSubjects)
      await ctx.db.insert("aiOrchestratorChatMembers", {
        chatId: id,
        subject,
        fromSequence: 0,
        readSequence: 0,
        updatedAt: now,
      });
    chat = (await ctx.db.get(rowId))!;
  }
  await inheritAllowanceScopes(ctx, input.companyId, [{ kind: "chat", chatId: input.source.id }], {
    kind: "chat",
    chatId: chat.id,
  });
  const now = Date.now(),
    messageId = mintDomainId(now);
  await appendChatMessage(ctx, chat, {
    id: messageId,
    senderKind: "orchestrator",
    senderId: input.orchestrator.id,
    senderName: input.orchestrator.name,
    text: input.text.trim(),
    status: "queued",
    replyToId: null,
  });
  for (const target of contacts.filter((contact) => contact.id !== input.orchestrator.id)) {
    await ctx.db.insert("aiOrchestratorJobs", {
      id: mintDomainId(now),
      orchestratorId: target.id,
      chatId: chat.id,
      messageId,
      companyId: target.companyId ?? input.companyId,
      status: "queued",
      environmentId: null,
      generation: 0,
      leaseExpiresAt: 0,
      modelIndex: 0,
      error: "",
      chainDepth: input.chainDepth + 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { chatId: chat.id, title: chat.title, orchestratorIds: ids };
}
