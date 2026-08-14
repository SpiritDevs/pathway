// @effect-diagnostics globalDate:off -- Convex actions are not Effect programs; the invitation clock is `Date.now()`.
/**
 * Company invitations.
 *
 * The plaintext token exists only inside the emailed link. Convex stores its SHA-256 hash, so
 * reading the database never yields something that can accept an invitation — and lookup is an
 * index read on the hash rather than a scan.
 *
 * Token generation and hashing run in actions rather than mutations, which keeps the transactional
 * half deterministic: a mutation only ever sees a hash.
 *
 * @module invitations
 */
import { v } from "convex/values";

import {
  checkInvitationAcceptable,
  generateInvitationToken,
  hashInvitationToken,
  invitationDeliveryIdempotencyKey,
  invitationExpiresAt,
  normalizeEmail,
} from "../src/invitations.ts";
import { action, internalMutation, mutation, query } from "./_generated/server.js";
import { requireCloudSyncEnabled } from "./lib/capability.ts";
import { backendError, notImplemented } from "./lib/errors.ts";
import { requireCompanyActor, requirePermission } from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const invitationSummary = v.object({
  id: domainIdArg,
  email: v.string(),
  state: v.union(
    v.literal("pending"),
    v.literal("accepted"),
    v.literal("revoked"),
    v.literal("expired"),
  ),
  expiresAt: v.number(),
  teamIds: v.array(domainIdArg),
  roleIds: v.array(domainIdArg),
  deliveryAttempt: v.number(),
  lastDeliveryAt: v.union(v.number(), v.null()),
});

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(invitationSummary),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.read");
    const invitations = await ctx.db
      .query("companyInvitations")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    return invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      state: invitation.state,
      expiresAt: invitation.expiresAt,
      teamIds: invitation.teamIds,
      roleIds: invitation.roleIds,
      deliveryAttempt: invitation.deliveryAttempt,
      lastDeliveryAt: invitation.lastDeliveryAt,
    }));
  },
});

/**
 * Creates an invitation and mails it. Returns nothing token-shaped: the link is the delivery, and
 * an inviter who never received the mail resends rather than reading the token back out.
 *
 * TODO(phase 6): persist through `record`, then deliver through Resend with
 * {@link invitationDeliveryIdempotencyKey} as the idempotency key. Resend delivery lands in its
 * own `"use node"` module so this file can keep exporting mutations.
 */
export const create = action({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    email: v.string(),
    teamIds: v.array(domainIdArg),
    roleIds: v.array(domainIdArg),
  },
  returns: v.object({ id: domainIdArg, expiresAt: v.number() }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const email = normalizeEmail(args.email);
    if (email.length === 0) {
      throw backendError("invalid-arguments", "An invitation needs an email address.");
    }

    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const expiresAt = invitationExpiresAt(Date.now());
    void ctx;
    void expiresAt;
    void tokenHash;
    void token;
    void invitationDeliveryIdempotencyKey;
    return notImplemented("invitations.create");
  },
});

/**
 * Writes the invitation row. Internal because the plaintext token must never be an argument a
 * client can supply, and the hash must never be one it can read.
 */
export const record = internalMutation({
  args: {
    companyId: domainIdArg,
    id: domainIdArg,
    email: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    teamIds: v.array(domainIdArg),
    roleIds: v.array(domainIdArg),
    invitedByMembershipId: domainIdArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    void ctx;
    void args;
    return notImplemented("invitations.record");
  },
});

/**
 * Re-sends an existing invitation under a fresh delivery attempt, which is what makes the Resend
 * idempotency key change: a retried delivery of one attempt never sends twice, a deliberate resend
 * always does.
 */
export const resend = action({
  args: { companyId: domainIdArg, invitationId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    void ctx;
    void args;
    return notImplemented("invitations.resend");
  },
});

export const revoke = mutation({
  args: { companyId: domainIdArg, invitationId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.invite");
    void args;
    // TODO(phase 6): move the invitation to `revoked`; the token hash stays so a late click is
    // told the invitation was revoked rather than that it never existed.
    return notImplemented("invitations.revoke");
  },
});

/**
 * Accepts an invitation for the signed-in Clerk identity.
 *
 * An action because it hashes the token: the mutation below only ever sees the hash. The email
 * match is on the identity's *verified* address, so a link forwarded to somebody else is useless.
 */
export const accept = action({
  args: { token: v.string() },
  returns: v.object({ companyId: domainIdArg }),
  handler: async (ctx, args) => {
    requireCloudSyncEnabled();
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw backendError("not-authenticated", "Accepting an invitation requires signing in.");
    }
    const tokenHash = await hashInvitationToken(args.token);
    void tokenHash;
    void checkInvitationAcceptable;
    return notImplemented("invitations.accept");
  },
});

/**
 * The transactional half of acceptance: create or reactivate the membership, apply the intended
 * team and role assignments, consume the token, and bump the authorization epoch — all or nothing,
 * so a double-click cannot produce two memberships.
 *
 * TODO(phase 6): implement. {@link checkInvitationAcceptable} already encodes the gate.
 */
export const consume = internalMutation({
  args: {
    tokenHash: v.string(),
    clerkSubject: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    displayName: v.string(),
  },
  returns: v.object({ companyId: domainIdArg }),
  handler: async (ctx, args) => {
    void ctx;
    void args;
    return notImplemented("invitations.consume");
  },
});
