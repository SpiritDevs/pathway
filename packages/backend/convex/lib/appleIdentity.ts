import type { Infer } from "cyndrbase/values";
import { appleCaller } from "./appleValidators.ts";
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import {
  isEnvironmentIdentity,
  requireCompanyActor,
  requireCompanyMember,
  requireIdentity,
  requirePermission,
  requireUser,
} from "./identity.ts";
import { backendError } from "./errors.ts";

export type AppleAccountAccess = { accountId: string; companyId?: string };
/** Also read by status subscriptions so unlinking invalidates personal-account health. */
export async function hasAppleOwnerLink(
  ctx: QueryCtx,
  account: Doc<"appleAccounts">,
  environmentId: string,
) {
  const owner = await ctx.db.get(account.ownerUserId);
  if (!owner) return false;
  const link = await ctx.db
    .query("relayEnvironmentLinks")
    .withIndex("by_user_and_environment", (q) =>
      q.eq("userId", owner.clerkSubject).eq("environmentId", environmentId),
    )
    .unique();
  return link !== null && link.revokedAt === null;
}

/** The host's registration grants custody, while the RPC caller grants account access. */
export async function authorizeAppleRuntimeCaller(
  ctx: QueryCtx,
  input: AppleAccountAccess & {
    companyId: string;
    caller: Infer<typeof appleCaller>;
    manage: boolean;
  },
) {
  const { account, actor } = await authorizeAppleAccount(ctx, input);
  if (!actor) throw backendError("permission-denied", "An environment identity is required.");
  const identity = input.caller;
  const userId = "userId" in identity ? ctx.db.normalizeId("users", identity.userId) : null;
  const caller =
    "clerkSubject" in identity
      ? await ctx.db
          .query("users")
          .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", identity.clerkSubject))
          .unique()
      : userId === null
        ? null
        : await ctx.db.get(userId);
  if (!caller) throw backendError("permission-denied", "The Apple caller is unknown.");
  if (account.companyId === null) {
    if (caller._id !== account.ownerUserId)
      throw backendError("permission-denied", "This Apple account is private to its owner.");
  } else {
    requirePermission(
      await requireCompanyMember(ctx, actor.company, caller),
      input.manage ? "integrations.manage" : "integrations.read",
    );
  }
}

/** Personal keys follow the owner's active relay link, never an arbitrary company membership. */
export async function authorizeAppleAccount(
  ctx: QueryCtx,
  input: AppleAccountAccess,
  manage = false,
) {
  const account = await ctx.db
    .query("appleAccounts")
    .withIndex("by_domain_id", (q) => q.eq("id", input.accountId))
    .unique();
  if (!account) throw backendError("entity-not-found", "The Apple account is unavailable.");
  const identity = await requireIdentity(ctx);
  if (isEnvironmentIdentity(identity)) {
    if (manage || !input.companyId)
      throw backendError("permission-denied", "A company member must manage Apple accounts.");
    const actor = await requireCompanyActor(ctx, input.companyId);
    if (actor.kind !== "environment")
      throw backendError("permission-denied", "An environment identity is required.");
    if (account.companyId !== null) {
      if (account.companyId !== actor.company._id)
        throw backendError("permission-denied", "The Apple account belongs to another company.");
    } else {
      if (!(await hasAppleOwnerLink(ctx, account, actor.registration.environmentId)))
        throw backendError(
          "permission-denied",
          "This environment is not linked to the Apple account owner.",
        );
    }
    return { account, actor };
  }
  const user = await requireUser(ctx);
  if (account.companyId === null) {
    if (account.ownerUserId !== user._id)
      throw backendError("permission-denied", "This Apple account is private to its owner.");
  } else {
    const company = await ctx.db.get(account.companyId);
    if (!company)
      throw backendError("company-not-found", "The Apple account's company is unavailable.");
    requirePermission(
      await requireCompanyActor(ctx, company.id),
      manage ? "integrations.manage" : "integrations.read",
    );
  }
  return { account, actor: null };
}
export async function authorizeAppleTeam(
  ctx: QueryCtx,
  input: AppleAccountAccess & { teamId: string },
  manage = false,
) {
  const access = await authorizeAppleAccount(ctx, input, manage);
  const team = await ctx.db
    .query("appleTeams")
    .withIndex("by_account_and_team", (q) =>
      q.eq("accountId", access.account._id).eq("teamId", input.teamId),
    )
    .unique();
  if (!team) throw backendError("entity-not-found", "The Apple Developer team is unavailable.");
  return { ...access, team };
}
