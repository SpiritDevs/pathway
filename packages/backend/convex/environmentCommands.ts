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

import { mutation, query } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

/** Same ceiling as one sync operation's arguments. */
const COMMAND_ARGS_MAX_BYTES = 512 * 1024;

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

const commandRecord = v.object({
  id: domainIdArg,
  kind: commandKind,
  state: commandState,
  targetEnvironmentId: v.string(),
  cloudProjectId: v.union(domainIdArg, v.null()),
  args: v.any(),
  claimedByEnvironmentId: v.union(v.string(), v.null()),
  claimGeneration: v.number(),
  expiresAt: v.number(),
  result: v.union(v.any(), v.null()),
  error: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/**
 * Issues a command at another environment.
 *
 * Requires dispatch permission *plus* the orchestration-equivalent permission for what the command
 * does — dispatching a "send message" must not be a way around not being allowed to send one.
 *
 * TODO(phase 8): insert the command, append the `environmentCommand` change so other clients see
 * it pending, and schedule the expiry sweep.
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "remoteAgents.dispatch");
    if (actor.kind !== "member") {
      throw backendError("invalid-arguments", "Commands are issued by a member, not a service.");
    }
    if (
      new TextEncoder().encode(JSON.stringify(args.args ?? null)).length > COMMAND_ARGS_MAX_BYTES
    ) {
      throw backendError("invalid-arguments", "Command arguments exceed the payload ceiling.");
    }
    if (args.ttlMs <= 0) {
      throw backendError("invalid-arguments", "A command needs a positive TTL.");
    }
    return notImplemented("environmentCommands.issue");
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.read");
    void args;
    return notImplemented("environmentCommands.list");
  },
});

/**
 * An environment claims its own pending work.
 *
 * The claim is transactional and idempotent, carries a generation, and is renewable — the same
 * machinery the integration coordinator lease uses. Losing a claim stops side effects immediately,
 * which is why the generation travels with every subsequent write.
 *
 * TODO(phase 8): select pending commands for this environment under the row limit, mark them
 * claimed with a fresh generation and claim deadline, and return them.
 */
export const claim = mutation({
  args: {
    companyId: domainIdArg,
    limit: v.optional(v.number()),
    claimTtlMs: v.optional(v.number()),
  },
  returns: v.array(commandRecord),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only an environment may claim commands.");
    }
    void args;
    return notImplemented("environmentCommands.claim");
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only an environment may renew a claim.");
    }
    void args;
    return notImplemented("environmentCommands.renewClaim");
  },
});

/**
 * Reports a terminal outcome. Status transitions and any created thread link sync back through the
 * normal change feed, so the issuing client observes them without a second channel.
 */
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
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError("invalid-arguments", "Only the claiming environment may report status.");
    }
    void args;
    return notImplemented("environmentCommands.reportStatus");
  },
});

/** Cancels a command that has not been claimed yet. */
export const cancel = mutation({
  args: { companyId: domainIdArg, commandId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "remoteAgents.dispatch");
    void args;
    return notImplemented("environmentCommands.cancel");
  },
});

/**
 * Moves commands past their TTL to `expired`.
 *
 * TODO(phase 8): run from a cron over `by_state_and_expiry` in bounded batches and append the
 * resulting changes — an expiry a client never sees is indistinguishable from a lost command.
 */
export const expireOverdue = mutation({
  args: { companyId: domainIdArg, limit: v.optional(v.number()) },
  returns: v.object({ expired: v.number() }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.manage");
    void args;
    return notImplemented("environmentCommands.expireOverdue");
  },
});
