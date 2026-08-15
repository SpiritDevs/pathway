// @effect-diagnostics globalDate:off -- Convex functions use the transaction clock from `Date.now()`.
/**
 * Issues and atomically consumes short-lived environment connect grants.
 *
 * The plaintext token crosses the public action boundary once. Only its SHA-256 hash enters the
 * database, and the relay hashes the presented token before calling {@link validate}. Validation
 * is a mutation because lookup, live authorization checks, and single-use consumption must be one
 * transaction. Expiry is checked there as well; no cron or replicated cleanup state is required.
 *
 * Connect grants are transient authorization artifacts, not company-domain state. They never enter
 * the sync feed: a replica receives the registration, membership, and role changes needed for its
 * own independent permission check, but never bearer-token hashes or connection-attempt history.
 *
 * @module connectGrants
 */
import { v } from "convex/values";

import {
  checkConnectGrantValidity,
  connectGrantExpiresAt,
  generateConnectGrantToken,
  hashConnectGrantToken,
} from "../src/connectGrants.ts";
import { hasCompanyPermission, isPermissionKey } from "../src/permissions.ts";
import { internal } from "./_generated/api.js";
import { action, internalMutation, mutation } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import { membershipAuthorization, requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { requireRelayControlPlane } from "./lib/relayIdentity.ts";
import { domainIdArg } from "./lib/validators.ts";

export const CONNECT_GRANT_REFUSAL_CODE = "connect-grant-refused";

const issuedGrant = v.object({
  id: domainIdArg,
  token: v.string(),
  environmentId: v.string(),
  membershipId: domainIdArg,
  permission: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
});

const validationResult = v.union(
  v.object({
    status: v.literal("accepted"),
    environmentId: v.string(),
    membershipId: domainIdArg,
    permission: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    status: v.literal("refused"),
    code: v.literal(CONNECT_GRANT_REFUSAL_CODE),
  }),
);

interface IssuedGrant {
  readonly id: string;
  readonly token: string;
  readonly environmentId: string;
  readonly membershipId: string;
  readonly permission: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const REFUSED = { status: "refused", code: CONNECT_GRANT_REFUSAL_CODE } as const;

/**
 * Mints one opaque bearer token for the signed-in member. An action owns token generation and
 * hashing; the internal mutation below owns every authorization decision and the row insert.
 */
export const issue = action({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    permission: v.string(),
  },
  returns: issuedGrant,
  handler: async (ctx, args): Promise<IssuedGrant> => {
    requireCloudSyncEnabled();
    const token = generateConnectGrantToken();
    const tokenHash = await hashConnectGrantToken(token);
    const recorded = await ctx.runMutation(internal.connectGrants.record, {
      ...args,
      tokenHash,
    });
    return { ...recorded, token };
  },
});

/** Atomic authorization and storage half of {@link issue}. */
export const record = internalMutation({
  args: {
    companyId: domainIdArg,
    environmentId: v.string(),
    permission: v.string(),
    tokenHash: v.string(),
  },
  returns: v.object({
    id: domainIdArg,
    environmentId: v.string(),
    membershipId: domainIdArg,
    permission: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "member") {
      throw backendError("permission-denied", "Only a company member may issue a connect grant.");
    }
    if (!isPermissionKey(args.permission)) {
      throw backendError("invalid-arguments", "A connect grant must assert a known permission.");
    }
    requirePermission(actor, args.permission);

    const environmentId = args.environmentId.trim();
    if (environmentId.length === 0 || environmentId !== args.environmentId) {
      throw backendError(
        "invalid-arguments",
        "An environment id must be a non-empty, trimmed string.",
      );
    }
    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", actor.company._id).eq("environmentId", environmentId),
      )
      .unique();
    if (registration === null || registration.state !== "active") {
      throw backendError(
        "environment-not-registered",
        "The target environment is not actively registered with this company.",
      );
    }

    const issuedAt = Date.now();
    const id = mintDomainId(issuedAt);
    const expiresAt = connectGrantExpiresAt(issuedAt);
    await ctx.db.insert("connectGrants", {
      id,
      companyId: actor.company._id,
      environmentId,
      targetRegistrationId: registration._id,
      grantedMembershipId: actor.membership._id,
      permission: args.permission,
      tokenHash: args.tokenHash,
      issuedAt,
      expiresAt,
      consumedAt: null,
      consumer: null,
    });
    return {
      id,
      environmentId,
      membershipId: actor.membership.id,
      permission: args.permission,
      issuedAt,
      expiresAt,
    };
  },
});

/**
 * Validates and consumes one hashed grant for the relay control plane. Any token, expiry, or live
 * authorization failure returns the same refusal so this surface cannot be used as an oracle.
 */
export const validate = mutation({
  args: { tokenHash: v.string() },
  returns: validationResult,
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const relay = await requireRelayControlPlane(ctx);
    const grants = await ctx.db
      .query("connectGrants")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .take(2);
    if (grants.length !== 1) return REFUSED;
    const grant = grants[0]!;
    const now = Date.now();

    const [company, registration, membership] = await Promise.all([
      ctx.db.get(grant.companyId),
      ctx.db.get(grant.targetRegistrationId),
      ctx.db.get(grant.grantedMembershipId),
    ]);
    let permissionHeld = false;
    if (
      membership !== null &&
      membership.companyId === grant.companyId &&
      membership.state === "active" &&
      isPermissionKey(grant.permission)
    ) {
      const owner = await ctx.db
        .query("companyOwners")
        .withIndex("by_company_and_membership", (q) =>
          q.eq("companyId", grant.companyId).eq("membershipId", membership._id),
        )
        .unique();
      const authorization = await membershipAuthorization(ctx, membership, owner !== null);
      permissionHeld = hasCompanyPermission(authorization.permissions, grant.permission);
    }

    const registrationState =
      registration !== null &&
      registration.companyId === grant.companyId &&
      registration.environmentId === grant.environmentId
        ? registration.state
        : null;
    const invalid = checkConnectGrantValidity(
      {
        grant,
        companyActive: company?.lifecycleState === "active",
        registrationState,
        membership:
          membership !== null && membership.companyId === grant.companyId
            ? { state: membership.state, permissionHeld }
            : null,
      },
      now,
    );
    if (invalid !== null || membership === null) return REFUSED;

    await ctx.db.patch(grant._id, { consumedAt: now, consumer: relay.subject });
    return {
      status: "accepted" as const,
      environmentId: grant.environmentId,
      membershipId: membership.id,
      permission: grant.permission,
      expiresAt: grant.expiresAt,
    };
  },
});
