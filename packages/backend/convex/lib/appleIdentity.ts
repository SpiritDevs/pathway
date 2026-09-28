import type { QueryCtx } from "../_generated/server.js";
import {
  isEnvironmentIdentity,
  requireCompanyActor,
  requireIdentity,
  requirePermission,
  requireUser,
} from "./identity.ts";
import { backendError } from "./errors.ts";

export type AppleAccountAccess = { accountId: string; companyId?: string };
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
      const owner = await ctx.db.get(account.ownerUserId);
      const link =
        owner &&
        (await ctx.db
          .query("relayEnvironmentLinks")
          .withIndex("by_user_and_environment", (q) =>
            q
              .eq("userId", owner.clerkSubject)
              .eq("environmentId", actor.registration.environmentId),
          )
          .unique());
      if (!link || link.revokedAt !== null)
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
