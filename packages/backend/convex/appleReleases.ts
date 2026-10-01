// @effect-diagnostics globalDate:off -- Convex transactions supply the authoritative lease clock.
import { v, type Infer } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { authorizeAppleTeam, authorizeAppleRuntimeCaller } from "./lib/appleIdentity.ts";
import { requireUser } from "./lib/identity.ts";
import { appleCaller } from "./lib/appleValidators.ts";
import { releaseTarget, releaseAction, releaseIntent } from "./lib/releaseValidators.ts";
import { backendError } from "./lib/errors.ts";
import { mintDomainId } from "./lib/domainIds.ts";

type Target = { companyId: string; accountId: string; teamId: string; appId: string };
const fail = (code: string, message: string): never => {
  throw backendError(code, message);
};
async function runtime(ctx: QueryCtx, args: Target & { caller: Infer<typeof appleCaller> }) {
  await authorizeAppleRuntimeCaller(ctx, { ...args, manage: true });
  const access = await authorizeAppleTeam(ctx, args);
  if (!access.actor || !access.team.connected)
    return fail(
      "permission-denied",
      "An authorized environment and connected Apple key are required.",
    );
  return { ...access, actor: access.actor };
}
async function policy(ctx: QueryCtx, teamId: Doc<"appleTeams">["_id"], appId: string) {
  return ctx.db
    .query("appleReleasePolicies")
    .withIndex("by_team_app", (q) => q.eq("teamId", teamId).eq("appId", appId))
    .unique();
}
export const settings = query({
  args: releaseTarget,
  returns: v.object({ enabled: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    const { team } = await authorizeAppleTeam(ctx, args);
    const p = await policy(ctx, team._id, args.appId);
    return { enabled: p?.enabled ?? false, revision: p?.revision ?? 0 };
  },
});
/** Human Cloud identity only; environment RPCs cannot turn publishing on. */
export const setEnabled = mutation({
  args: { ...releaseTarget, enabled: v.boolean(), expectedRevision: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const { team } = await authorizeAppleTeam(ctx, args, true);
    const p = await policy(ctx, team._id, args.appId);
    if ((p?.revision ?? 0) !== args.expectedRevision)
      return fail("entity-conflict", "Refresh publishing settings before changing them.");
    const values = {
      teamId: team._id,
      appId: args.appId,
      enabled: args.enabled,
      revision: (p?.revision ?? 0) + 1,
    };
    if (p) await ctx.db.replace(p._id, values);
    else await ctx.db.insert("appleReleasePolicies", values);
    return null;
  },
});
function present(row: Doc<"appleReleaseIntents">): Infer<typeof releaseIntent> {
  return {
    id: row.id,
    target: row.target,
    environmentId: row.environmentId,
    action: row.action,
    state: row.state,
    expiresAt: row.expiresAt,
  };
}
async function findIntent(ctx: QueryCtx, id: string) {
  const row = await ctx.db
    .query("appleReleaseIntents")
    .withIndex("by_domain_id", (q) => q.eq("id", id))
    .unique();
  if (!row) return fail("entity-not-found", "The release confirmation is unavailable.");
  return row;
}
export const prepare = mutation({
  args: { ...releaseTarget, caller: appleCaller, action: releaseAction },
  returns: releaseIntent,
  handler: async (ctx, args) => {
    const { account, team, actor } = await runtime(ctx, args);
    if (
      JSON.stringify(args.action).length > 12_000 ||
      (args.action.kind === "testflight" &&
        (args.action.whatsNew.length > 4000 || args.action.groupIds.length > 100))
    )
      return fail("invalid-arguments", "The release action is too large.");
    const p = await policy(ctx, team._id, args.appId);
    const id = mintDomainId(Date.now());
    const row = {
      id,
      target: {
        companyId: args.companyId,
        accountId: args.accountId,
        teamId: args.teamId,
        appId: args.appId,
      },
      environmentId: actor.registration.environmentId,
      action: args.action,
      state: "pending" as const,
      expiresAt: Date.now() + 15 * 60_000,
      accountRevision: account.revision,
      keyRevision: team.revision,
      policyRevision: p?.revision ?? 0,
      approvedBy: null,
    };
    await ctx.db.insert("appleReleaseIntents", row);
    return {
      id,
      target: row.target,
      environmentId: row.environmentId,
      action: row.action,
      state: row.state,
      expiresAt: row.expiresAt,
    };
  },
});
export const intent = query({
  args: { intentId: v.string() },
  returns: releaseIntent,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const row = await findIntent(ctx, args.intentId);
    await authorizeAppleTeam(ctx, row.target);
    return present(row);
  },
});
export const confirm = mutation({
  args: { intentId: v.string() },
  returns: releaseIntent,
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await findIntent(ctx, args.intentId);
    const { account, team } = await authorizeAppleTeam(ctx, row.target, true);
    const p = await policy(ctx, team._id, row.target.appId);
    if (!p?.enabled)
      return fail("publishing-disabled", "Enable publishing for this app before confirming.");
    if (
      row.state !== "pending" ||
      row.expiresAt <= Date.now() ||
      row.accountRevision !== account.revision ||
      row.keyRevision !== team.revision ||
      !team.connected
    )
      return fail("confirmation-required", "Prepare a new release confirmation.");
    await ctx.db.patch(row._id, {
      state: "approved",
      approvedBy: user._id,
      policyRevision: p.revision,
    });
    return present({ ...row, state: "approved" });
  },
});
export const cancel = mutation({
  args: { intentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const row = await findIntent(ctx, args.intentId);
    await authorizeAppleTeam(ctx, row.target, true);
    await ctx.db.patch(row._id, { state: "cancelled" });
    return null;
  },
});
async function executable(
  ctx: QueryCtx,
  args: Target & { caller: Infer<typeof appleCaller>; intentId: string },
  state: "approved" | "consumed",
) {
  const { account, team, actor } = await runtime(ctx, args);
  const row = await findIntent(ctx, args.intentId);
  const p = await policy(ctx, team._id, args.appId);
  if (!p?.enabled) return fail("publishing-disabled", "Publishing is disabled for this app.");
  if (
    row.state !== state ||
    row.expiresAt <= Date.now() ||
    row.environmentId !== actor.registration.environmentId ||
    Object.entries(row.target).some(([k, value]) => args[k as keyof Target] !== value) ||
    row.accountRevision !== account.revision ||
    row.keyRevision !== team.revision ||
    row.policyRevision !== p.revision ||
    !row.approvedBy
  )
    return fail(
      "confirmation-required",
      "A current client confirmation for this exact release is required.",
    );
  await authorizeAppleRuntimeCaller(ctx, {
    ...args,
    caller: { userId: row.approvedBy },
    manage: true,
  });
  return row;
}
export const consume = mutation({
  args: { ...releaseTarget, caller: appleCaller, intentId: v.string() },
  returns: releaseIntent,
  handler: async (ctx, args) => {
    const row = await executable(ctx, args, "approved");
    // Consumed before the first write. A failed/ambiguous upload cannot replay this approval.
    const expiresAt = Date.now() + 2 * 60 * 60_000;
    await ctx.db.patch(row._id, { state: "consumed", expiresAt });
    return present({ ...row, state: "consumed", expiresAt });
  },
});
export const checkExecution = query({
  args: { ...releaseTarget, caller: appleCaller, intentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await executable(ctx, args, "consumed");
    return null;
  },
});

const numberArgs = { ...releaseTarget, caller: appleCaller, version: v.string() };
/** One short exclusive allocator lease per ASC app and marketing version, across accounts/keys. */
export const acquireBuildLease = mutation({
  args: numberArgs,
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const { actor } = await runtime(ctx, args);
    if (!/^\d+(?:\.\d+){0,2}$/u.test(args.version))
      return fail("invalid-arguments", "Use a numeric marketing version.");
    const row = await ctx.db
      .query("appleBuildCounters")
      .withIndex("by_app_version", (q) => q.eq("appId", args.appId).eq("version", args.version))
      .unique();
    if (row && row.expiresAt > Date.now())
      return fail(
        "release-busy",
        "Another environment is allocating a build number. Retry shortly.",
      );
    const token = mintDomainId(Date.now());
    const expiresAt = Date.now() + 30_000;
    const values = {
      appId: args.appId,
      version: args.version,
      lastNumber: row?.lastNumber ?? 0,
      environmentId: actor.registration.environmentId,
      token,
      expiresAt,
    };
    if (row) await ctx.db.replace(row._id, values);
    else await ctx.db.insert("appleBuildCounters", values);
    return { token, expiresAt };
  },
});
export const allocateBuildNumber = mutation({
  args: { ...numberArgs, token: v.string(), observedMaximum: v.number() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { actor } = await runtime(ctx, args);
    const row = await ctx.db
      .query("appleBuildCounters")
      .withIndex("by_app_version", (q) => q.eq("appId", args.appId).eq("version", args.version))
      .unique();
    if (
      !row ||
      row.token !== args.token ||
      row.environmentId !== actor.registration.environmentId ||
      row.expiresAt <= Date.now()
    )
      return fail(
        "stale-controller-lease",
        "The build-number lease expired. Prepare the archive again.",
      );
    const number = Math.max(row.lastNumber, args.observedMaximum) + 1;
    if (!Number.isSafeInteger(args.observedMaximum) || args.observedMaximum < 0 || number > 9999)
      return fail(
        "invalid-arguments",
        "The numeric build-number range is exhausted. Choose a new marketing version.",
      );
    await ctx.db.patch(row._id, { lastNumber: number, expiresAt: 0 });
    return String(number);
  },
});
