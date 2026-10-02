// @effect-diagnostics globalDate:off globalRandom:off -- Convex supplies deterministic transaction time and randomness.
import { defaultOrchestratorConfig } from "@spiritdevs/contracts/aiOrchestrator";
import { AVATAR_EYES, AVATAR_SHAPES } from "@spiritdevs/contracts/orchestratorAvatar";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { mintDomainId } from "./domainIds.ts";

export async function findPersonalAssistant(ctx: QueryCtx, ownerSubject: string) {
  return await ctx.db
    .query("aiOrchestrators")
    .withIndex("by_owner_kind", (q) => q.eq("ownerSubject", ownerSubject).eq("kind", "personal"))
    .filter((q) =>
      q.and(
        q.eq(q.field("shared"), false),
        q.eq(q.field("companyId"), null),
        q.or(q.eq(q.field("status"), "active"), q.eq(q.field("status"), "paused")),
      ),
    )
    .first();
}

/** A paused assistant still belongs to the account; provisioning must never resume it. */
export async function ensurePersonalAssistant(ctx: MutationCtx, ownerSubject: string) {
  const existing = await findPersonalAssistant(ctx, ownerSubject);
  if (existing) return existing;
  // Convex's seeded randomness is stable across transaction retries. Only new identities use it.
  const names = ["Robin", "Sage", "Pip", "Clover", "Milo", "Nova", "Ember", "Wren"];
  const colors = ["violet", "blue", "green", "amber", "pink"];
  const config = defaultOrchestratorConfig(names[Math.floor(Math.random() * names.length)]!);
  const now = Date.now();
  const key = await ctx.db.insert("aiOrchestrators", {
    ...config,
    color: colors[Math.floor(Math.random() * colors.length)]!,
    avatar: {
      shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!,
      eyes: AVATAR_EYES[Math.floor(Math.random() * AVATAR_EYES.length)]!,
    },
    models: [],
    workerModels: [],
    capabilities: [...config.capabilities],
    directorSubjects: [],
    managerSubjects: [],
    environmentIds: [],
    id: mintDomainId(now),
    ownerSubject,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return (await ctx.db.get(key))!;
}

/** Find the account's existing private home without reopening archived or stopping chats. */
export async function findPersonalConversation(
  ctx: QueryCtx,
  ownerSubject: string,
  assistantId: string,
) {
  const existing = ctx.db
    .query("aiOrchestratorChats")
    .withIndex("by_owner", (q) => q.eq("ownerSubject", ownerSubject))
    .filter((q) =>
      q.and(
        q.eq(q.field("kind"), "dm"),
        q.eq(q.field("leadId"), assistantId),
        q.eq(q.field("archived"), false),
        q.eq(q.field("lifecycle"), undefined),
        q.eq(q.field("companyIds"), []),
        q.eq(q.field("participantSubjects"), [ownerSubject]),
        q.eq(q.field("orchestratorIds"), [assistantId]),
      ),
    );
  for await (const chat of existing) {
    const member = await ctx.db
      .query("aiOrchestratorChatMembers")
      .withIndex("by_chat_subject", (q) => q.eq("chatId", chat.id).eq("subject", ownerSubject))
      .unique();
    if (member) return { chat, member };
  }
  return null;
}

/** Opening home creates only a conversation, never work or a resume command. */
export async function ensurePersonalConversation(ctx: MutationCtx, ownerSubject: string) {
  const assistant = await ensurePersonalAssistant(ctx, ownerSubject);
  const existing = await findPersonalConversation(ctx, ownerSubject, assistant.id);
  if (existing) return existing.chat.id;
  const now = Date.now(),
    id = mintDomainId(now);
  await ctx.db.insert("aiOrchestratorChats", {
    id,
    title: assistant.name,
    kind: "dm",
    ownerSubject,
    orchestratorIds: [assistant.id],
    leadId: assistant.id,
    participantSubjects: [ownerSubject],
    companyIds: [],
    archived: false,
    lastSequence: 0,
    lastMessage: "",
    lastVisibleSequence: 0,
    lastVisibleAt: now,
    summary: "",
    summaryThroughSequence: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("aiOrchestratorChatMembers", {
    chatId: id,
    subject: ownerSubject,
    fromSequence: 0,
    readSequence: 0,
    attentionReady: true,
    updatedAt: now,
  });
  return id;
}
