import { assignmentForExecution } from "./lib/aiOrchestratorAuthority.ts";
// @effect-diagnostics globalDate:off -- Convex's transaction clock fences quota observations.
import { v } from "convex/values";
import * as Schema from "effect/Schema";
import { ServerProviderUsageSnapshot } from "@spiritdevs/contracts";
import {
  allocateProviderAllowance,
  allowanceScopeKey,
  observeProviderAllowance,
  ALLOWANCE_MAX_READING_AGE_MS,
  type ProviderAllowanceScope,
} from "@spiritdevs/contracts/providerAllowanceBudget";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import {
  requireCompanyActor,
  requirePermission,
  membershipAuthorization,
  type CompanyActor,
} from "./lib/identity.ts";
import { backendError } from "./lib/errors.ts";
import { allowanceScope } from "./lib/providerAllowanceSchema.ts";
import { readableChat, findOrchestrator } from "./aiOrchestrators.ts";
import {
  eligibleOrchestratorEnvironment,
  orchestratorCommandAllowed,
} from "./lib/aiOrchestratorAuthority.ts";
import { hasRecordPermission } from "../src/permissions.ts";
import { quotesAllowanceInstruction } from "@spiritdevs/contracts/providerAllowance";

const fail = (message: string): never => {
  throw backendError("allowance-budget", message);
};
const decodeSnapshot = Schema.decodeUnknownSync(ServerProviderUsageSnapshot);
const allocationRequest = v.object({
  snapshot: v.any(),
  windowKey: v.string(),
  authorizedPercent: v.number(),
});
const budgetArgs = { companyId: v.string(), budgetId: v.string() };
const assignmentOrigin = v.optional(
  v.object({
    companyId: v.string(),
    orchestratorId: v.string(),
    commandId: v.string(),
    execution: v.optional(
      v.object({ threadId: v.string(), runId: v.string(), messageId: v.string() }),
    ),
  }),
);

async function findBudget(ctx: QueryCtx, id: string) {
  return await ctx.db
    .query("providerAllowanceBudgets")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
}
function publicBudget({ _id, _creationTime, ...budget }: Doc<"providerAllowanceBudgets">) {
  return budget;
}

async function scopeAccess(
  ctx: QueryCtx,
  actor: CompanyActor,
  scope: ProviderAllowanceScope,
  manage: boolean,
) {
  if (scope.kind === "chat") {
    if (actor.kind === "member") {
      const { chat } = await readableChat(ctx, scope.chatId);
      if (manage && chat.ownerSubject !== actor.user.clerkSubject)
        return fail("Only this conversation's owner can allocate its allowance.");
      if (chat.companyIds.length && !chat.companyIds.includes(actor.company.id))
        return fail("Choose a workspace in this conversation.");
    } else {
      const chat = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", scope.chatId))
        .unique();
      if (!chat || chat.archived) return fail("This allowance conversation is unavailable.");
      let eligible = false;
      for (const id of chat.orchestratorIds) {
        const orchestrator = await findOrchestrator(ctx, id);
        if (
          orchestrator &&
          (await eligibleOrchestratorEnvironment(ctx, orchestrator, actor.registration))
        ) {
          eligible = true;
          break;
        }
      }
      if (!eligible) return fail("This environment cannot access the allowance conversation.");
    }
  } else {
    if (actor.kind === "environment" && actor.registration.environmentId !== scope.environmentId)
      return fail("An environment can only supervise its own thread bindings.");
    const thread = await ctx.db
      .query("agentThreads")
      .withIndex("by_company_and_environment_and_thread", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("environmentId", scope.environmentId)
          .eq("threadId", scope.threadId),
      )
      .unique();
    // A new local descendant can precede its cloud shell; only its authenticated environment may check it.
    if (!thread && actor.kind === "member")
      return fail("Wait for this thread to sync before allocating an allowance.");
    if (thread?.cloudProjectId) {
      const project = await ctx.db.get(thread.cloudProjectId);
      if (
        !project ||
        project.deletedAt !== null ||
        !hasRecordPermission(actor.permissions, "projects.read", project.teamIds)
      )
        return fail("This thread's project is not accessible.");
    }
    if (manage) requirePermission(actor, "remoteAgents.control");
  }
}

async function ownerBudget(ctx: QueryCtx, args: { companyId: string; budgetId: string }) {
  const actor = await requireCompanyActor(ctx, args.companyId);
  const budget = await findBudget(ctx, args.budgetId);
  if (
    !budget ||
    budget.companyId !== args.companyId ||
    actor.kind !== "member" ||
    budget.ownerSubject !== actor.user.clerkSubject
  )
    return fail("Only the owner can change this allowance allocation.");
  for (const scope of budget.scopes) await scopeAccess(ctx, actor, scope, true);
  return { actor, budget };
}

function makeAllocations(
  requests: Array<{ snapshot: unknown; windowKey: string; authorizedPercent: number }>,
) {
  if (!requests.length || requests.length > 8) return fail("Choose one to eight account windows.");
  const unique = new Set<string>();
  return requests.map((request) => {
    const snapshot = decodeSnapshot(request.snapshot);
    const result = allocateProviderAllowance(
      snapshot,
      request.windowKey,
      request.authorizedPercent,
      Date.now(),
    );
    if (!result.allocation) return fail(result.error);
    const key = JSON.stringify([
      result.allocation.provider,
      result.allocation.accountKey,
      result.allocation.windowKey,
    ]);
    if (unique.has(key)) return fail("An account window can only be allocated once in a budget.");
    unique.add(key);
    return result.allocation;
  });
}

async function scheduledOwnerAuthorized(ctx: QueryCtx, budget: Doc<"providerAllowanceBudgets">) {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", budget.companyId))
    .unique();
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", budget.ownerSubject))
    .unique();
  if (!company || !user || company.lifecycleState !== "active") return false;
  const member = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", company._id).eq("userId", user._id))
    .unique();
  if (member?.state !== "active") return false;
  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", company._id).eq("membershipId", member._id),
    )
    .unique();
  const { permissions } = await membershipAuthorization(ctx, member, !!owner);
  for (const scope of budget.scopes) {
    if (scope.kind === "chat") {
      const chat = await ctx.db
        .query("aiOrchestratorChats")
        .withIndex("by_domain_id", (q) => q.eq("id", scope.chatId))
        .unique();
      if (!chat || chat.archived || chat.ownerSubject !== user.clerkSubject) return false;
    } else {
      if (!hasRecordPermission(permissions, "remoteAgents.control", [])) return false;
      const thread = await ctx.db
        .query("agentThreads")
        .withIndex("by_company_and_environment_and_thread", (q) =>
          q
            .eq("companyId", company._id)
            .eq("environmentId", scope.environmentId)
            .eq("threadId", scope.threadId),
        )
        .unique();
      if (thread?.cloudProjectId) {
        const project = await ctx.db.get(thread.cloudProjectId);
        if (
          !project ||
          project.deletedAt !== null ||
          !hasRecordPermission(permissions, "projects.read", project.teamIds)
        )
          return false;
      }
    }
  }
  return true;
}

/** A one-shot human schedule takes a fresh baseline only after all selected accounts are readable. */
async function applyScheduledResume(
  ctx: MutationCtx,
  budget: Doc<"providerAllowanceBudgets">,
  snapshot: typeof ServerProviderUsageSnapshot.Type | null,
) {
  const schedule = budget.scheduledResume;
  const now = Date.now();
  if (!schedule || schedule.at > now) return null;
  if (now > schedule.expiresAt || !(await scheduledOwnerAuthorized(ctx, budget))) {
    const detail =
      now > schedule.expiresAt
        ? "The scheduled resume was missed by more than one hour. Work remains held for your instruction."
        : "The scheduled resume was cancelled because its owner or assignment access changed.";
    const update = {
      scheduledResume: undefined,
      status: "paused" as const,
      detail,
      revision: budget.revision + 1,
      updatedAt: now,
    };
    await ctx.db.patch(budget._id, update);
    return publicBudget((await ctx.db.get(budget._id))!);
  }
  const observations = schedule.observations.filter(
    (a) =>
      now - a.observedAt < ALLOWANCE_MAX_READING_AGE_MS &&
      a.resetsAt > now &&
      !(snapshot && a.provider === snapshot.provider && a.accountKey === snapshot.accountKey),
  );
  if (snapshot)
    for (const request of schedule.allocations) {
      if (request.provider !== snapshot.provider || request.accountKey !== snapshot.accountKey)
        continue;
      const result = allocateProviderAllowance(
        snapshot,
        request.windowKey,
        request.authorizedPercent,
        now,
      );
      if (result.allocation && result.allocation.observedAt >= schedule.at)
        observations.push(result.allocation);
    }
  if (
    schedule.allocations.every((request) =>
      observations.some(
        (a) =>
          a.provider === request.provider &&
          a.accountKey === request.accountKey &&
          a.windowKey === request.windowKey,
      ),
    )
  ) {
    await ctx.db.insert("providerAllowanceHistory", {
      budgetId: budget.id,
      revision: budget.revision,
      allocations: budget.allocations,
      changedBy: budget.ownerSubject,
      createdAt: now,
    });
    const update = {
      allocations: observations,
      scheduledResume: undefined,
      status: "active" as const,
      revision: budget.revision + 1,
      detail: "Resumed with the one-time allowance you scheduled, from fresh account readings.",
      updatedAt: now,
    };
    await ctx.db.patch(budget._id, update);
    return publicBudget((await ctx.db.get(budget._id))!);
  }
  const update = {
    scheduledResume: { ...schedule, observations },
    detail: "Scheduled resume is waiting for fresh readings from every authorized account.",
    updatedAt: now,
  };
  await ctx.db.patch(budget._id, update);
  return publicBudget({ ...budget, ...update });
}

export const scheduleResume = mutation({
  args: {
    ...budgetArgs,
    revision: v.number(),
    at: v.number(),
    timeZone: v.string(),
    allocations: v.array(allocationRequest),
  },
  handler: async (ctx, args) => {
    const { budget } = await ownerBudget(ctx, args);
    if (budget.revision !== args.revision || budget.status === "closed")
      return fail("Review the current active limit before scheduling a resume.");
    const now = Date.now();
    if (!Number.isFinite(args.at) || args.at <= now || args.at > now + 366 * 86400000)
      return fail("Choose a future time within the next year.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: args.timeZone }).format(now);
    } catch {
      return fail("Choose a valid timezone.");
    }
    const allocations = makeAllocations(args.allocations).map(
      ({ provider, accountKey, windowKey, windowLabel, authorizedPercent }) => ({
        provider,
        accountKey,
        windowKey,
        windowLabel,
        authorizedPercent,
      }),
    );
    await ctx.db.patch(budget._id, {
      status: "paused",
      revision: budget.revision + 1,
      scheduledResume: {
        at: args.at,
        timeZone: args.timeZone,
        expiresAt: args.at + 3600000,
        allocations,
        observations: [],
      },
      detail:
        "Paused until your scheduled one-time allocation. A delay beyond one hour leaves work held.",
      updatedAt: now,
    });
  },
});

export const cancelScheduledResume = mutation({
  args: budgetArgs,
  handler: async (ctx, args) => {
    const { budget } = await ownerBudget(ctx, args);
    await ctx.db.patch(budget._id, {
      scheduledResume: undefined,
      revision: budget.revision + 1,
      detail: "Scheduled resume cancelled. The current allowance and hold are retained.",
      updatedAt: Date.now(),
    });
  },
});

/** A conversational allocation only adds a guard. It cannot renew, remove, or relax an existing one. */
export async function allocateFromInstruction(
  ctx: MutationCtx,
  input: {
    companyId: string;
    ownerSubject: string;
    scope: ProviderAllowanceScope;
    messageId: string;
    text: string;
    quote: string;
    title: string;
    snapshot: unknown;
    windowKey: string;
    authorizedPercent: number;
  },
) {
  if (!quotesAllowanceInstruction(input.text, input.quote, input.authorizedPercent))
    return fail("Quote the numeric allowance from the current user's instruction.");
  if (!input.title.trim() || input.title.length > 120)
    return fail("Choose a short allowance title.");
  const scopeKey = allowanceScopeKey(input.scope);
  const id = `instruction:${scopeKey}:${input.messageId}`;
  const snapshot = decodeSnapshot(input.snapshot);
  const creationIntent = JSON.stringify([
    input.companyId,
    input.ownerSubject,
    input.windowKey,
    snapshot.provider,
    snapshot.accountKey,
    input.authorizedPercent,
    input.quote,
  ]);
  const prior = await findBudget(ctx, id);
  if (prior) {
    if (prior.creationIntent !== creationIntent)
      return fail(
        "This instruction already established a different allowance. A new user instruction is required.",
      );
    return publicBudget(prior);
  }
  const bindings = await ctx.db
    .query("providerAllowanceBindings")
    .withIndex("by_scope", (q) => q.eq("companyId", input.companyId).eq("scopeKey", scopeKey))
    .take(16);
  if (bindings.length >= 16) return fail("This assignment already has sixteen allowance guards.");
  const budget = {
    id,
    companyId: input.companyId,
    ownerSubject: input.ownerSubject,
    title: input.title.trim(),
    scopes: [input.scope],
    allocations: makeAllocations([input]),
    status: "active" as const,
    revision: 1,
    detail:
      "Allocated from your message. All account consumption counts; other assignment limits still apply.",
    creationIntent,
    sourceInstruction: { messageId: input.messageId, quote: input.quote },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await ctx.db.insert("providerAllowanceBudgets", budget);
  await ctx.db.insert("providerAllowanceBindings", {
    companyId: input.companyId,
    budgetId: id,
    scopeKey,
  });
  return budget;
}

/** The local runtime attests the current message after checking its human author and active run. */
export const allocateForThread = mutation({
  args: {
    companyId: v.string(),
    threadId: v.string(),
    messageId: v.string(),
    text: v.string(),
    quote: v.string(),
    title: v.string(),
    snapshot: v.any(),
    windowKey: v.string(),
    authorizedPercent: v.number(),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment" || !actor.registration.registeredByMembershipId)
      return fail("A registered environment must attest the allowance instruction.");
    if (args.text.length > 32000 || args.quote.length > 4000 || args.messageId.length > 256)
      return fail("The allowance instruction is too large.");
    const member = await ctx.db.get(actor.registration.registeredByMembershipId);
    const user = member?.state === "active" ? await ctx.db.get(member.userId) : null;
    if (!user) return fail("The environment's owner is no longer active in this workspace.");
    const scope = {
      kind: "thread" as const,
      environmentId: actor.registration.environmentId,
      threadId: args.threadId,
    };
    await scopeAccess(ctx, actor, scope, true);
    return await allocateFromInstruction(ctx, { ...args, scope, ownerSubject: user.clerkSubject });
  },
});

export const create = mutation({
  args: {
    ...budgetArgs,
    title: v.string(),
    scopes: v.array(allowanceScope),
    allocations: v.array(allocationRequest),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      return fail("A user must authorize the initial allowance allocation.");
    if (
      !args.budgetId ||
      !args.title.trim() ||
      args.title.length > 120 ||
      !args.scopes.length ||
      args.scopes.length > 16
    )
      return fail("Choose a title and one to sixteen assignment scopes.");
    const prior = await findBudget(ctx, args.budgetId);
    if (prior) {
      if (prior.ownerSubject !== actor.user.clerkSubject || prior.companyId !== args.companyId)
        return fail("Budget identifier is already in use.");
      const requested = args.allocations
        .map((request) => {
          const snapshot = decodeSnapshot(request.snapshot);
          return JSON.stringify([
            snapshot.provider,
            snapshot.accountKey,
            request.windowKey,
            request.authorizedPercent,
          ]);
        })
        .sort();
      const original = prior.allocations
        .map((allocation) =>
          JSON.stringify([
            allocation.provider,
            allocation.accountKey,
            allocation.windowKey,
            allocation.authorizedPercent,
          ]),
        )
        .sort();
      // Observations and inherited descendants can change after an accepted creation retry.
      if (
        prior.title !== args.title.trim() ||
        args.scopes.some(
          (scope) =>
            !prior.scopes.some((saved) => allowanceScopeKey(saved) === allowanceScopeKey(scope)),
        ) ||
        JSON.stringify(requested) !== JSON.stringify(original)
      )
        return fail("Budget identifier is already in use for another allocation.");
      return publicBudget(prior);
    }
    const scopeKeys = new Set<string>();
    for (const scope of args.scopes) {
      await scopeAccess(ctx, actor, scope, true);
      const key = allowanceScopeKey(scope);
      if (scopeKeys.has(key)) return fail("Choose each assignment scope once.");
      scopeKeys.add(key);
      const bindings = await ctx.db
        .query("providerAllowanceBindings")
        .withIndex("by_scope", (q) => q.eq("companyId", args.companyId).eq("scopeKey", key))
        .take(17);
      if (bindings.length >= 16)
        return fail("This assignment already has sixteen allowance guards.");
    }
    const now = Date.now();
    const budget = {
      id: args.budgetId,
      companyId: args.companyId,
      title: args.title.trim(),
      ownerSubject: actor.user.clerkSubject,
      scopes: args.scopes,
      allocations: makeAllocations(args.allocations),
      status: "active" as const,
      revision: 1,
      detail: "All observed account consumption counts toward this allocation.",
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert("providerAllowanceBudgets", budget);
    for (const scopeKey of scopeKeys)
      await ctx.db.insert("providerAllowanceBindings", {
        companyId: args.companyId,
        budgetId: budget.id,
        scopeKey,
      });
    return budget;
  },
});

export const list = query({
  args: { companyId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member")
      return fail("Use assignment scopes to inspect a runtime allowance.");
    return (
      await ctx.db
        .query("providerAllowanceBudgets")
        .withIndex("by_company_owner", (q) =>
          q.eq("companyId", args.companyId).eq("ownerSubject", actor.user.clerkSubject),
        )
        .take(100)
    ).map(publicBudget);
  },
});

/** Scope lookup is bounded and reused by admission, running-turn supervision, and coordinator claims. */
export async function budgetsForScopes(
  ctx: QueryCtx,
  companyId: string,
  scopes: readonly ProviderAllowanceScope[],
) {
  const ids = new Set<string>();
  for (const scope of scopes) {
    for (const row of await ctx.db
      .query("providerAllowanceBindings")
      .withIndex("by_scope", (q) =>
        q.eq("companyId", companyId).eq("scopeKey", allowanceScopeKey(scope)),
      )
      .take(16))
      ids.add(row.budgetId);
  }
  const budgets = [];
  for (const id of ids) {
    const budget = await findBudget(ctx, id);
    if (budget && budget.status !== "closed") budgets.push(budget);
  }
  return budgets;
}

/** Coordination may expand an assignment, but cannot remove its originating account guards. */
export async function inheritAllowanceScopes(
  ctx: MutationCtx,
  companyId: string,
  from: readonly ProviderAllowanceScope[],
  target: ProviderAllowanceScope,
) {
  const scopeKey = allowanceScopeKey(target);
  const existing = await ctx.db
    .query("providerAllowanceBindings")
    .withIndex("by_scope", (q) => q.eq("companyId", companyId).eq("scopeKey", scopeKey))
    .take(17);
  const budgets = (await budgetsForScopes(ctx, companyId, from)).filter(
    (b) => !existing.some((e) => e.budgetId === b.id),
  );
  if (existing.length + budgets.length > 16)
    return fail("This assignment has too many allowance guards.");
  for (const budget of budgets) {
    if (budget.scopes.length >= 32)
      return fail("This allocation already covers thirty-two assignment scopes.");
    await ctx.db.insert("providerAllowanceBindings", { companyId, budgetId: budget.id, scopeKey });
    await ctx.db.patch(budget._id, { scopes: [...budget.scopes, target], updatedAt: Date.now() });
  }
}

async function assignmentScopes(
  ctx: QueryCtx,
  actor: CompanyActor,
  scopes: ProviderAllowanceScope[],
  origin?: {
    companyId: string;
    orchestratorId: string;
    commandId: string;
    execution?: { threadId: string; runId: string; messageId: string };
  },
) {
  if (!origin) return scopes;
  if (actor.kind !== "environment" || origin.companyId !== actor.company.id)
    return fail("Invalid allowance assignment origin.");
  const work = await assignmentForExecution(ctx, origin, actor.registration.environmentId);
  if (
    !work ||
    work.companyId !== origin.companyId ||
    work.orchestratorId !== origin.orchestratorId ||
    work.environmentId !== actor.registration.environmentId
  )
    return fail("This environment does not own the allowance assignment.");
  const command = await ctx.db
    .query("environmentCommands")
    .withIndex("by_company_and_domain_id", (q) =>
      q.eq("companyId", actor.company._id).eq("id", origin.commandId),
    )
    .unique();
  if (work.stopRequested || !command || !(await orchestratorCommandAllowed(ctx, command, work)))
    return fail("This assignment was stopped or its orchestrator permission changed.");
  return [...scopes, { kind: "chat" as const, chatId: work.chatId }];
}

export const forScopes = query({
  args: { companyId: v.string(), scopes: v.array(allowanceScope), origin: assignmentOrigin },
  handler: async (ctx, args) => {
    if (args.scopes.length > 32)
      return fail("The assignment ancestry exceeds the supported depth.");
    const actor = await requireCompanyActor(ctx, args.companyId);
    const scopes = await assignmentScopes(ctx, actor, args.scopes, args.origin);
    const budgets = await budgetsForScopes(ctx, args.companyId, scopes);
    if (!budgets.length) return [];
    for (const scope of scopes) await scopeAccess(ctx, actor, scope, false);
    return budgets.map(publicBudget);
  },
});

/** Bind before launching a child, including durable commands waiting on another environment. */
export const inherit = mutation({
  args: {
    companyId: v.string(),
    scopes: v.array(allowanceScope),
    origin: assignmentOrigin,
    target: v.object({
      kind: v.literal("thread"),
      environmentId: v.string(),
      threadId: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment" || !args.scopes.length || args.scopes.length > 32)
      return fail("An executing environment must supply the originating assignment.");
    const scopes = await assignmentScopes(ctx, actor, args.scopes, args.origin);
    if (!(await budgetsForScopes(ctx, args.companyId, scopes)).length) return;
    for (const scope of scopes) await scopeAccess(ctx, actor, scope, false);
    const target = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", args.target.environmentId),
      )
      .unique();
    if (!target || target.state !== "active")
      return fail(
        "Register the destination environment in this workspace before sharing an allowance.",
      );
    await inheritAllowanceScopes(ctx, args.companyId, scopes, args.target);
  },
});

export const observe = mutation({
  args: {
    ...budgetArgs,
    revision: v.number(),
    scopes: v.array(allowanceScope),
    origin: assignmentOrigin,
    snapshot: v.union(v.any(), v.null()),
  },
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      return fail("Allowance observations must come from an authenticated environment.");
    if (!args.scopes.length || args.scopes.length > 32)
      return fail("Choose the executing assignment scopes.");
    const scopes = await assignmentScopes(ctx, actor, args.scopes, args.origin);
    for (const scope of scopes) await scopeAccess(ctx, actor, scope, false);
    const budget = (await budgetsForScopes(ctx, args.companyId, scopes)).find(
      (budget) => budget.id === args.budgetId,
    );
    if (!budget) return fail("This assignment has no such allowance allocation.");
    if (budget.revision !== args.revision) return publicBudget(budget);
    const snapshot = args.snapshot === null ? null : decodeSnapshot(args.snapshot);
    const scheduled = await applyScheduledResume(ctx, budget, snapshot);
    if (scheduled) return scheduled;
    // An observation for one fallback account must not invalidate another account's last reading.
    const allocations = budget.allocations.map((allocation) =>
      snapshot &&
      (allocation.provider !== snapshot.provider || allocation.accountKey !== snapshot.accountKey)
        ? allocation
        : observeProviderAllowance(allocation, snapshot, Date.now()),
    );
    if (JSON.stringify(allocations) === JSON.stringify(budget.allocations))
      return publicBudget(budget);
    const updatedAt = Date.now();
    await ctx.db.patch(budget._id, { allocations, updatedAt });
    return publicBudget({ ...budget, allocations, updatedAt });
  },
});

export const pause = mutation({
  args: budgetArgs,
  handler: async (ctx, args) => {
    const { budget } = await ownerBudget(ctx, args);
    await ctx.db.patch(budget._id, {
      status: "paused",
      scheduledResume: undefined,
      revision: budget.revision + 1,
      detail: "Paused by the user. Queued work and partial results are retained.",
      updatedAt: Date.now(),
    });
  },
});
export const close = mutation({
  args: budgetArgs,
  handler: async (ctx, args) => {
    const { budget } = await ownerBudget(ctx, args);
    await ctx.db.patch(budget._id, {
      status: "closed",
      scheduledResume: undefined,
      revision: budget.revision + 1,
      detail: "The user removed this limit. Other assignment limits still apply.",
      updatedAt: Date.now(),
    });
    for (const binding of await ctx.db
      .query("providerAllowanceBindings")
      .withIndex("by_budget", (q) => q.eq("budgetId", budget.id))
      .collect())
      await ctx.db.delete(binding._id);
  },
});
export const resume = mutation({
  args: { ...budgetArgs, revision: v.number(), allocations: v.array(allocationRequest) },
  handler: async (ctx, args) => {
    const { actor, budget } = await ownerBudget(ctx, args);
    if (budget.revision !== args.revision)
      return fail("The allowance changed. Review its current allocation before resuming.");
    const allocations = makeAllocations(args.allocations);
    if (budget.status === "closed")
      for (const scope of budget.scopes) {
        const bindings = await ctx.db
          .query("providerAllowanceBindings")
          .withIndex("by_scope", (q) =>
            q.eq("companyId", budget.companyId).eq("scopeKey", allowanceScopeKey(scope)),
          )
          .take(16);
        if (bindings.length >= 16)
          return fail("This assignment already has sixteen allowance guards.");
        await ctx.db.insert("providerAllowanceBindings", {
          companyId: budget.companyId,
          budgetId: budget.id,
          scopeKey: allowanceScopeKey(scope),
        });
      }
    await ctx.db.insert("providerAllowanceHistory", {
      budgetId: budget.id,
      revision: budget.revision,
      allocations: budget.allocations,
      changedBy: actor.user.clerkSubject,
      createdAt: Date.now(),
    });
    await ctx.db.patch(budget._id, {
      allocations,
      status: "active",
      scheduledResume: undefined,
      revision: budget.revision + 1,
      detail: "The user authorized a new allocation from the current observed baseline.",
      updatedAt: Date.now(),
    });
  },
});
