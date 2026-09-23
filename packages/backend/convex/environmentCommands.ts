import { readEnvironmentPresence, patchEnvironmentPresence } from "./lib/environmentRuntime.ts";
// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock directly.
/**
 * Remote dispatch through Convex command records — layer 2 of cross-machine agent control.
 *
 * This channel exists for the case where the two machines can never reach each other directly. A
 * command for an offline environment stays pending, visible, and cancellable until it is claimed
 * or expires, and expiry is recorded rather than silent. Live steering does not come through here:
 * transcripts and file contents never travel in a command record.
 *
 * @module environmentCommands
 */
import { v } from "convex/values";

import {
  decodeEnvironmentCommandArgs,
  decodeEnvironmentCommandResult,
  ENVIRONMENT_COMMAND_ARGS_MAX_BYTES,
  ENVIRONMENT_COMMAND_CLAIM_TTL_MS,
  ENVIRONMENT_COMMAND_MAX_CLAIM_TTL_MS,
  ENVIRONMENT_COMMAND_MAX_TTL_MS,
  environmentCommandPermission,
  isCancellableEnvironmentCommand,
} from "../src/environmentCommands.ts";
import { ENVIRONMENT_REGISTRATION_HEARTBEAT_INTERVAL_MS } from "../src/environmentRegistrations.ts";
import { canonicalJson } from "../src/canonicalJson.ts";
import type { SyncActor } from "../src/sync/protocol.ts";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { appendCompanyChanges, encodeEnvironmentCommand } from "./lib/companyApply.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  requireCompanyActor,
  requirePermission,
  type CompanyActor,
  type EnvironmentActor,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";
import {
  orchestratorCommandAllowed,
  orchestratorCommandPaused,
} from "./lib/aiOrchestratorAuthority.ts";
import { scheduleOrchestratorWorkRefresh } from "./lib/aiOrchestratorWorkRefresh.ts";

const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;
const CLAIM_DEFAULT_LIMIT = 10;
const CLAIM_MAX_LIMIT = 25;
const EXPIRE_DEFAULT_LIMIT = 50;
const EXPIRE_MAX_LIMIT = 200;
const terminalCommandStates = new Set(["succeeded", "failed", "canceled", "expired"]);

const commandKind = v.union(
  v.literal("startThread"),
  v.literal("sendMessage"),
  v.literal("interrupt"),
  v.literal("statusQuery"),
);

const commandState = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("expired"),
);

const commandActor = v.union(
  v.object({ kind: v.literal("member"), membershipId: domainIdArg }),
  v.object({
    kind: v.literal("agent"),
    provider: v.string(),
    onBehalfOfMembershipId: v.union(domainIdArg, v.null()),
  }),
  v.object({
    kind: v.literal("system"),
    source: v.union(
      v.literal("import"),
      v.literal("cycles"),
      v.literal("slack"),
      v.literal("automation"),
    ),
  }),
  v.object({ kind: v.literal("environment"), environmentId: v.string() }),
);

const commandRecord = v.object({
  id: domainIdArg,
  kind: commandKind,
  state: commandState,
  targetEnvironmentId: v.string(),
  cloudProjectId: v.union(domainIdArg, v.null()),
  bindingId: v.union(domainIdArg, v.null()),
  args: v.any(),
  issuedByMembershipId: domainIdArg,
  onBehalfOfActor: commandActor,
  claimedByEnvironmentId: v.union(v.string(), v.null()),
  claimGeneration: v.number(),
  claimExpiresAt: v.union(v.number(), v.null()),
  expiresAt: v.number(),
  result: v.union(v.any(), v.null()),
  error: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw backendError("invalid-arguments", "A row limit must be a positive integer.");
  }
  return Math.min(limit, maximum);
}

function claimTtl(value: number | undefined): number {
  const ttl = value ?? ENVIRONMENT_COMMAND_CLAIM_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > ENVIRONMENT_COMMAND_MAX_CLAIM_TTL_MS) {
    throw backendError(
      "invalid-arguments",
      `A claim TTL must be a positive integer no greater than ${ENVIRONMENT_COMMAND_MAX_CLAIM_TTL_MS}ms.`,
    );
  }
  return ttl;
}

async function commandById(
  ctx: QueryCtx,
  companyId: Doc<"companies">["_id"],
  commandId: string,
): Promise<Doc<"environmentCommands"> | null> {
  return await ctx.db
    .query("environmentCommands")
    .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", commandId))
    .unique();
}

async function commandResult(ctx: QueryCtx, row: Doc<"environmentCommands">) {
  const project = row.cloudProjectId === null ? null : await ctx.db.get(row.cloudProjectId);
  const membership = await ctx.db.get(row.issuedByMembershipId);
  if (row.cloudProjectId !== null && project === null) {
    throw backendError("entity-not-found", "The command's cloud project is missing.");
  }
  if (membership === null) {
    throw backendError("entity-not-found", "The command's issuing membership is missing.");
  }
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    targetEnvironmentId: row.targetEnvironmentId,
    cloudProjectId: project?.id ?? null,
    bindingId: row.bindingId,
    args: row.args,
    issuedByMembershipId: membership.id,
    onBehalfOfActor: row.onBehalfOfActor,
    claimedByEnvironmentId: row.claimedByEnvironmentId,
    claimGeneration: row.claimGeneration,
    claimExpiresAt: row.claimExpiresAt,
    expiresAt: row.expiresAt,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function appendCommandChanges(
  ctx: MutationCtx,
  actor: CompanyActor,
  rows: readonly Doc<"environmentCommands">[],
): Promise<void> {
  await appendCommandRecords(ctx, actor.company._id, actorRecord(actor), rows);
}

async function appendCommandRecords(
  ctx: MutationCtx,
  companyId: Doc<"environmentCommands">["companyId"],
  actor: SyncActor,
  rows: readonly Doc<"environmentCommands">[],
): Promise<void> {
  if (rows.length === 0) return;
  // An orchestrator's dispatch outcome decides its assignment's status.
  await scheduleOrchestratorWorkRefresh(
    ctx,
    rows.flatMap((row) =>
      row.orchestratorId && terminalCommandStates.has(row.state) ? [row.orchestratorId] : [],
    ),
  );
  const changes = [];
  for (const row of rows) {
    changes.push({
      entityKind: "environmentCommand" as const,
      entityId: row.id,
      changeKind: "upsert" as const,
      versionDocId: row._id,
      payload: await encodeEnvironmentCommand(ctx, row),
    });
  }
  await appendCompanyChanges(ctx, { companyId, actor, changes });
}

/** Records the command-level TTL lapsing; expiry is published, never silent. */
async function expireCommand(
  ctx: MutationCtx,
  row: Doc<"environmentCommands">,
  now: number,
): Promise<Doc<"environmentCommands">> {
  const patch = { state: "expired" as const, claimExpiresAt: null, updatedAt: now };
  await ctx.db.patch(row._id, patch);
  return { ...row, ...patch };
}

function sameCommandIdentity(
  existing: Doc<"environmentCommands">,
  input: { readonly kind: string; readonly targetEnvironmentId: string; readonly args: unknown },
): boolean {
  return (
    existing.kind === input.kind &&
    existing.targetEnvironmentId === input.targetEnvironmentId &&
    canonicalJson(existing.args) === canonicalJson(input.args)
  );
}

function requireLiveOwnedClaim(
  row: Doc<"environmentCommands">,
  actor: EnvironmentActor,
  generation: number,
  now: number,
): void {
  if (row.state !== "claimed") {
    throw backendError("invalid-command-state", "The command is not currently claimed.");
  }
  if (row.claimedByEnvironmentId !== actor.registration.environmentId) {
    throw backendError("permission-denied", "The command is claimed by another environment.");
  }
  if (row.claimGeneration !== generation) {
    throw backendError("stale-command-claim", "The command claim generation is stale.");
  }
  if (row.expiresAt <= now) {
    throw backendError("command-expired", "The command has passed its expiry time.");
  }
  if (row.claimExpiresAt === null || row.claimExpiresAt <= now) {
    throw backendError("command-claim-expired", "The command claim has expired.");
  }
}

/**
 * Issues a command at another environment.
 *
 * Requires dispatch permission *plus* the orchestration-equivalent permission for what the command
 * does — dispatching a "send message" must not be a way around not being allowed to send one.
 */
export const issue = mutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    targetEnvironmentId: v.string(),
    cloudProjectId: v.union(domainIdArg, v.null()),
    kind: commandKind,
    args: v.any(),
    ttlMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "remoteAgents.dispatch");
    if (actor.kind !== "member") {
      throw backendError("invalid-arguments", "Commands are issued by a member, not a service.");
    }
    if (
      new TextEncoder().encode(JSON.stringify(args.args ?? null)).length >
      ENVIRONMENT_COMMAND_ARGS_MAX_BYTES
    ) {
      throw backendError("invalid-arguments", "Command arguments exceed the payload ceiling.");
    }
    if (args.ttlMs <= 0) {
      throw backendError("invalid-arguments", "A command needs a positive TTL.");
    }
    if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs > ENVIRONMENT_COMMAND_MAX_TTL_MS) {
      throw backendError(
        "invalid-arguments",
        `A command TTL must be an integer no greater than ${ENVIRONMENT_COMMAND_MAX_TTL_MS}ms.`,
      );
    }

    const decoded = decodeEnvironmentCommandArgs(args.args);
    if (!decoded.ok) throw backendError("invalid-arguments", decoded.message);
    if (decoded.value.kind !== args.kind) {
      throw backendError(
        "invalid-arguments",
        "The command kind must match the command arguments kind.",
      );
    }
    requirePermission(actor, environmentCommandPermission(args.kind));

    const targetEnvironmentId = args.targetEnvironmentId.trim();
    if (targetEnvironmentId.length === 0 || targetEnvironmentId !== args.targetEnvironmentId) {
      throw backendError(
        "invalid-arguments",
        "An environment id must be a non-empty, trimmed string.",
      );
    }
    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", targetEnvironmentId),
      )
      .unique();
    if (registration === null || registration.state !== "active") {
      throw backendError(
        "environment-not-registered",
        "The target environment is not actively registered with this company.",
      );
    }

    const existing = await commandById(ctx, actor.company._id, args.id);
    if (existing !== null) {
      if (
        sameCommandIdentity(existing, {
          kind: args.kind,
          targetEnvironmentId,
          args: decoded.value,
        })
      ) {
        return null;
      }
      throw backendError(
        "entity-conflict",
        "A different environment command already uses this id.",
      );
    }

    let cloudProjectDocId: Doc<"cloudProjects">["_id"] | null = null;
    if (args.cloudProjectId !== null) {
      const project = await ctx.db
        .query("cloudProjects")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", actor.company._id).eq("id", args.cloudProjectId as string),
        )
        .unique();
      if (project === null || project.deletedAt !== null) {
        throw backendError("entity-not-found", "The command's cloud project is missing.");
      }
      cloudProjectDocId = project._id;
    }

    const now = Date.now();
    const commandDocId = await ctx.db.insert("environmentCommands", {
      id: args.id,
      companyId: actor.company._id,
      targetEnvironmentId,
      cloudProjectId: cloudProjectDocId,
      bindingId: null,
      kind: args.kind,
      args: decoded.value,
      issuedByMembershipId: actor.membership._id,
      onBehalfOfActor: actorRecord(actor),
      state: "pending",
      claimedByEnvironmentId: null,
      claimGeneration: 0,
      claimExpiresAt: null,
      expiresAt: now + args.ttlMs,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const command = await ctx.db.get(commandDocId);
    if (command === null) throw new Error("The inserted command vanished inside its transaction.");
    await appendCommandChanges(ctx, actor, [command]);
    return null;
  },
});

/** Commands a client can see: everything in the company it may read environments for. */
export const list = query({
  args: {
    companyId: domainIdArg,
    state: v.optional(commandState),
    limit: v.optional(v.number()),
  },
  returns: v.array(commandRecord),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.read");
    const limit = boundedLimit(args.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    const rows =
      args.state === undefined
        ? await ctx.db
            .query("environmentCommands")
            .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
            .order("asc")
            .take(limit)
        : await ctx.db
            .query("environmentCommands")
            .withIndex("by_company_and_state", (q) =>
              q
                .eq("companyId", actor.company._id)
                .eq("state", args.state as Doc<"environmentCommands">["state"]),
            )
            .order("asc")
            .take(limit);
    return await Promise.all(rows.map((row) => commandResult(ctx, row)));
  },
});

async function refreshCommandPresence(
  ctx: MutationCtx,
  registration: Doc<"environmentRegistrations">,
  now: number,
) {
  const presence = await readEnvironmentPresence(ctx, registration);
  if (
    presence.lastSeenAt === null ||
    now - presence.lastSeenAt >= ENVIRONMENT_REGISTRATION_HEARTBEAT_INTERVAL_MS
  ) {
    await patchEnvironmentPresence(ctx, registration, { lastSeenAt: now });
    // Presence is operational state, kept outside the replicated company feed.
  }
}

/** Renew presence without loading pending commands on idle servers. */
export const heartbeat = mutation({
  args: { companyId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment")
      throw backendError("permission-denied", "Only environments may heartbeat command workers.");
    await refreshCommandPresence(ctx, actor.registration, Date.now());
    return null;
  },
});

/**
 * An environment claims its own pending work.
 *
 * A lapsed lease is claimed under a new generation before side effects resume. Returning a live
 * claim unchanged makes retrying a lost claim response idempotent without weakening that fence.
 */
export const claim = mutation({
  args: {
    companyId: domainIdArg,
    limit: v.optional(v.number()),
    claimTtlMs: v.optional(v.number()),
    /** Servers with a dedicated heartbeat send `false`; older servers kept presence alive here. */
    refreshPresence: v.optional(v.boolean()),
  },
  returns: v.array(commandRecord),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only an environment may claim commands.");
    }
    const limit = boundedLimit(args.limit, CLAIM_DEFAULT_LIMIT, CLAIM_MAX_LIMIT);
    const ttl = claimTtl(args.claimTtlMs);
    const now = Date.now();
    const environmentId = actor.registration.environmentId;
    if (args.refreshPresence !== false) {
      await refreshCommandPresence(ctx, actor.registration, now);
    }
    const pending = await ctx.db
      .query("environmentCommands")
      .withIndex("by_company_target_state", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("targetEnvironmentId", environmentId)
          .eq("state", "pending"),
      )
      .take(limit);
    const claimed = await ctx.db
      .query("environmentCommands")
      .withIndex("by_company_target_state", (q) =>
        q
          .eq("companyId", actor.company._id)
          .eq("targetEnvironmentId", environmentId)
          .eq("state", "claimed"),
      )
      .take(limit);

    const changed: Doc<"environmentCommands">[] = [];
    const returned: Doc<"environmentCommands">[] = [];
    const live: Doc<"environmentCommands">[] = [];
    for (const row of [...pending, ...claimed]) {
      if (row.state === "claimed" && row.claimedByEnvironmentId !== environmentId) continue;
      // Expired rows sort first and would otherwise hold every newer command behind them.
      if (row.expiresAt <= now) changed.push(await expireCommand(ctx, row, now));
      else live.push(row);
    }
    const selected = live
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit);
    for (const row of selected) {
      if (await orchestratorCommandPaused(ctx, row)) continue;
      if (!(await orchestratorCommandAllowed(ctx, row))) {
        const patch = {
          state: "canceled" as const,
          error: "Orchestrator permission or scope changed.",
          updatedAt: now,
        };
        await ctx.db.patch(row._id, patch);
        changed.push({ ...row, ...patch });
        continue;
      }
      if (row.state === "claimed" && row.claimExpiresAt !== null && row.claimExpiresAt > now) {
        returned.push(row);
        continue;
      }
      const patch = {
        state: "claimed" as const,
        claimedByEnvironmentId: environmentId,
        claimGeneration: row.claimGeneration + 1,
        claimExpiresAt: Math.min(now + ttl, row.expiresAt),
        updatedAt: now,
      };
      await ctx.db.patch(row._id, patch);
      const next = { ...row, ...patch };
      changed.push(next);
      returned.push(next);
    }
    await appendCommandChanges(ctx, actor, changed);
    return await Promise.all(returned.map((row) => commandResult(ctx, row)));
  },
});

/** Extends a live claim. A claimant whose generation is stale is refused rather than renewed. */
export const renewClaim = mutation({
  args: {
    companyId: domainIdArg,
    commandId: domainIdArg,
    claimGeneration: v.number(),
    claimTtlMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only an environment may renew a claim.");
    }
    const row = await commandById(ctx, actor.company._id, args.commandId);
    if (row === null) throw backendError("entity-not-found", "The environment command is missing.");
    const now = Date.now();
    requireLiveOwnedClaim(row, actor, args.claimGeneration, now);
    if (!(await orchestratorCommandAllowed(ctx, row)))
      throw backendError("permission-denied", "Orchestrator permission or scope changed.");
    await ctx.db.patch(row._id, {
      claimExpiresAt: Math.min(now + claimTtl(args.claimTtlMs), row.expiresAt),
      updatedAt: now,
    });
    // Lease time is target-local coordination, not a lifecycle transition replicas need to fold.
    // Omitting a feed row also prevents a healthy worker's renew loop from churning every client.
    return null;
  },
});

/** Reports a terminal outcome under the claim generation that authorized its side effects. */
export const reportStatus = mutation({
  args: {
    companyId: domainIdArg,
    commandId: domainIdArg,
    claimGeneration: v.number(),
    state: v.union(v.literal("succeeded"), v.literal("failed")),
    result: v.union(v.any(), v.null()),
    error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only the claiming environment may report status.");
    }
    const row = await commandById(ctx, actor.company._id, args.commandId);
    if (row === null) throw backendError("entity-not-found", "The environment command is missing.");
    const now = Date.now();
    requireLiveOwnedClaim(row, actor, args.claimGeneration, now);
    if ((args.state === "failed") !== (args.error !== null)) {
      throw backendError(
        "invalid-arguments",
        "A failed command needs an error, and a succeeded command must not have one.",
      );
    }
    let result = null;
    if (args.result !== null) {
      const decoded = decodeEnvironmentCommandResult(args.result);
      if (!decoded.ok) throw backendError("invalid-arguments", decoded.message);
      if (decoded.value.kind !== row.kind) {
        throw backendError(
          "invalid-arguments",
          "The command result kind must match the command kind.",
        );
      }
      result = decoded.value;
    }
    const patch = {
      state: args.state,
      result,
      error: args.error,
      claimExpiresAt: null,
      updatedAt: now,
    };
    await ctx.db.patch(row._id, patch);
    await appendCommandChanges(ctx, actor, [{ ...row, ...patch }]);
    return null;
  },
});

/** Cancels a command that has not been claimed yet. */
export const cancel = mutation({
  args: { companyId: domainIdArg, commandId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "remoteAgents.dispatch");
    if (actor.kind !== "member") {
      throw backendError("invalid-arguments", "Only a company member may cancel a command.");
    }
    const row = await commandById(ctx, actor.company._id, args.commandId);
    if (row === null) throw backendError("entity-not-found", "The environment command is missing.");
    if (row.state === "canceled") return null;
    if (!isCancellableEnvironmentCommand(row.state)) {
      throw backendError("invalid-command-state", "Only a pending command may be canceled.");
    }
    const patch = { state: "canceled" as const, claimExpiresAt: null, updatedAt: Date.now() };
    await ctx.db.patch(row._id, patch);
    await appendCommandChanges(ctx, actor, [{ ...row, ...patch }]);
    return null;
  },
});

/**
 * Moves commands past their command-level TTL to `expired` in a bounded company-scoped batch.
 *
 * Claims expire what they read and `expireOverdueSweep` runs on a cron; this lets a manager force
 * the same transition for one company.
 */
export const expireOverdue = mutation({
  args: { companyId: domainIdArg, limit: v.optional(v.number()) },
  returns: v.object({ expired: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.manage");
    const limit = boundedLimit(args.limit, EXPIRE_DEFAULT_LIMIT, EXPIRE_MAX_LIMIT);
    const now = Date.now();
    const pending = await ctx.db
      .query("environmentCommands")
      .withIndex("by_state_and_expiry", (q) => q.eq("state", "pending").lte("expiresAt", now))
      .filter((q) => q.eq(q.field("companyId"), actor.company._id))
      .take(limit);
    const claimed = await ctx.db
      .query("environmentCommands")
      .withIndex("by_state_and_expiry", (q) => q.eq("state", "claimed").lte("expiresAt", now))
      .filter((q) => q.eq(q.field("companyId"), actor.company._id))
      .take(limit);
    const rows = [...pending, ...claimed]
      .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
      .slice(0, limit);
    const expired: Doc<"environmentCommands">[] = [];
    for (const row of rows) expired.push(await expireCommand(ctx, row, now));
    await appendCommandChanges(ctx, actor, expired);
    return { expired: expired.length };
  },
});

/**
 * Cron backstop for environments that stay offline: their own claims expire what they read, but a
 * target that never polls again would otherwise keep lapsed commands pending forever.
 */
export const expireOverdueSweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const overdue = await Promise.all(
      (["pending", "claimed"] as const).map((state) =>
        ctx.db
          .query("environmentCommands")
          .withIndex("by_state_and_expiry", (q) => q.eq("state", state).lte("expiresAt", now))
          .take(EXPIRE_MAX_LIMIT),
      ),
    );
    const byCompany = new Map<
      Doc<"environmentCommands">["companyId"],
      Doc<"environmentCommands">[]
    >();
    for (const row of overdue.flat()) {
      const expired = await expireCommand(ctx, row, now);
      byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), expired]);
    }
    for (const [companyId, rows] of byCompany) {
      await appendCommandRecords(ctx, companyId, { kind: "system", source: "automation" }, rows);
    }
    return null;
  },
});
