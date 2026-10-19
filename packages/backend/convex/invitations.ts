// @effect-diagnostics globalDate:off -- Convex actions are not Effect programs; the invitation clock is `Date.now()`.
/**
 * Company invitations.
 *
 * The plaintext token exists only inside the emailed link. Convex stores its SHA-256 hash, so
 * reading the database never yields something that can accept an invitation — and lookup is an
 * index read on the hash rather than a scan.
 *
 * Token generation and hashing run in actions rather than mutations, which keeps the transactional
 * half deterministic: a mutation only ever sees a hash. Every action here is therefore a thin
 * shell — hash, call the internal mutation, deliver — and every decision that has to be atomic
 * lives in the mutation it calls.
 *
 * Invitations are the one company record that never rides the change feed. They carry secret
 * material, they are addressed to somebody who is not yet a member, and there is nothing offline to
 * do with one; {@link list} is the whole read surface. What acceptance *creates* — the membership
 * and its team and role grants — is ordinary company-domain data and is appended through
 * `lib/companyApply` like every other administration write.
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
  isInvitationExpired,
  normalizeEmail,
  type InvitationAcceptanceRejection,
} from "../src/invitations.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { action, internalMutation, mutation, query } from "./_generated/server.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  appendCompanyChanges,
  encodeMembership,
  encodeRoleAssignment,
  encodeTeamMembership,
  teamMembershipDomainId,
  type CompanyChange,
} from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  requireCompanyActor,
  requireOrganizationWorkspace,
  requirePermission,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

/**
 * How long a deliberate resend has to wait behind the previous delivery attempt.
 *
 * The limit is on *attempts*, not successes: a mailer that is failing is exactly the one a frustrated
 * inviter would click through, and each click mints a fresh token that invalidates the last link.
 */
export const INVITATION_RESEND_MIN_INTERVAL_MS = 60_000;

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

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Everything the mailer needs to render one invitation email. */
export interface InvitationDelivery {
  readonly companyId: string;
  readonly companyName: string;
  readonly invitationId: string;
  /** Normalized recipient; the address acceptance is bound to. */
  readonly email: string;
  /**
   * The plaintext token. This object is the only place it exists after {@link create} returns — it
   * is never stored, never logged, and never handed back to the caller.
   */
  readonly token: string;
  readonly expiresAt: number;
  readonly deliveryAttempt: number;
  /** `company-invite/<invite-id>/<delivery-attempt>`; Resend deduplicates retries on it. */
  readonly idempotencyKey: string;
}

export type InvitationMailer = (delivery: InvitationDelivery) => Promise<void>;

/**
 * The default mailer, which refuses rather than pretends.
 *
 * No Resend integration exists in this repository yet, and the plan puts it in its own `"use node"`
 * module so this file can keep exporting mutations. Until that module installs itself through
 * {@link setInvitationMailer}, creating an invitation fails loudly at the delivery step: the row is
 * already written and resendable, and an inviter told "sent" about mail that was never sent would
 * wait forever for somebody who never got a link.
 */
const UNCONFIGURED_MAILER: InvitationMailer = async () => {
  throw backendError(
    "invitation-delivery-unconfigured",
    "This deployment has no invitation mailer installed.",
  );
};

let mailer: InvitationMailer = UNCONFIGURED_MAILER;

/**
 * Installs the mailer invitation delivery goes through, returning the one it replaced.
 *
 * The seam exists because delivery is the one part of this module that leaves the deployment: tests
 * install a recorder and assert on the token they would have emailed, and the future Resend module
 * installs the real sender. Passing `null` restores the default refusal.
 *
 * Module state in a Convex isolate is per-execution and must never carry data between requests; this
 * carries wiring, is written once at startup (or by a test), and read-only thereafter.
 */
export function setInvitationMailer(next: InvitationMailer | null): InvitationMailer {
  const previous = mailer;
  mailer = next ?? UNCONFIGURED_MAILER;
  return previous;
}

/**
 * Sends one invitation email and records the attempt either way.
 *
 * The record is written from the action, after the send, so `lastDeliveryAt` means "when delivery
 * was last attempted" and `lastDeliveryError` says how it went. A failure is surfaced to the caller
 * rather than swallowed — the invitation survives as `pending`, and {@link resend} mints it a new
 * token once the mailer works.
 */
async function deliver(
  ctx: ActionCtx,
  invitationDocId: Id<"companyInvitations">,
  delivery: InvitationDelivery,
): Promise<void> {
  let failure: string | null = null;
  try {
    await mailer(delivery);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await ctx.runMutation(internal.invitations.recordDelivery, {
    invitationDocId,
    attemptedAt: Date.now(),
    error: failure,
  });
  if (failure !== null) {
    throw backendError(
      "invitation-delivery-failed",
      `The invitation was created but could not be emailed: ${failure}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The invitation named by its domain id inside one company.
 *
 * A scan of the company's invitations rather than an index read: `companyInvitations` is indexed by
 * token hash, by email, and by state, but not by domain id, and the list is the same one
 * {@link list} already collects for the invitation screen.
 */
async function requireInvitation(
  ctx: QueryCtx,
  companyDocId: Id<"companies">,
  invitationDomainId: string,
): Promise<Doc<"companyInvitations">> {
  const invitations = await ctx.db
    .query("companyInvitations")
    .withIndex("by_company", (q) => q.eq("companyId", companyDocId))
    .collect();
  const invitation = invitations.find((candidate) => candidate.id === invitationDomainId);
  if (invitation === undefined) {
    throw backendError("entity-not-found", "No such invitation in this company.");
  }
  return invitation;
}

/** Refusal copy, one per gate in {@link checkInvitationAcceptable}, keyed by the code clients branch on. */
const REJECTION_MESSAGES: Record<InvitationAcceptanceRejection, string> = {
  "invitation-not-found": "This invitation link is not valid.",
  "invitation-expired": "This invitation has expired. Ask for a new one.",
  "invitation-consumed": "This invitation has already been accepted.",
  "invitation-revoked": "This invitation was revoked.",
  "invitation-email-mismatch": "This invitation was sent to a different email address.",
  "invitation-email-unverified":
    "Verify your email address with your identity provider before accepting this invitation.",
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(invitationSummary),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "members.read");
    const invitations = await ctx.db
      .query("companyInvitations")
      .withIndex("by_company", (q) => q.eq("companyId", actor.company._id))
      .collect();
    // Field by field, never the row: `tokenHash` is the one column in this table that must not leave
    // the deployment, and a spread would ship it the first time somebody adds a field here.
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

// ---------------------------------------------------------------------------
// Creating and delivering
// ---------------------------------------------------------------------------

/**
 * Creates an invitation and mails it. Returns nothing token-shaped: the link is the delivery, and
 * an inviter who never received the mail resends rather than reading the token back out.
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
  handler: async (ctx, args): Promise<{ id: string; expiresAt: number }> => {
    const email = normalizeEmail(args.email);
    if (email.length === 0) {
      throw backendError("invalid-arguments", "An invitation needs an email address.");
    }

    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const expiresAt = invitationExpiresAt(Date.now());

    // Authorization, validation, and the write all happen inside `record`: an action holds no
    // transaction, so anything checked out here could be stale by the time the row lands.
    const recorded = await ctx.runMutation(internal.invitations.record, {
      companyId: args.companyId,
      id: args.id,
      email,
      tokenHash,
      expiresAt,
      teamIds: args.teamIds,
      roleIds: args.roleIds,
    });

    await deliver(ctx, recorded.invitationDocId, {
      companyId: args.companyId,
      companyName: recorded.companyName,
      invitationId: args.id,
      email,
      token,
      expiresAt,
      deliveryAttempt: recorded.deliveryAttempt,
      idempotencyKey: invitationDeliveryIdempotencyKey(args.id, recorded.deliveryAttempt),
    });

    return { id: args.id, expiresAt };
  },
});

/**
 * Writes the invitation row. Internal because the plaintext token must never be an argument a
 * client can supply, and the hash must never be one it can read.
 *
 * The inviter is re-derived from the caller's token rather than passed in. It is the same rule the
 * sync protocol follows for `actor` — an asserted identity is attribution, a derived one is
 * authorization — and it is the only way a permission check and the write it guards land in one
 * transaction.
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
  },
  returns: v.object({
    invitationDocId: v.id("companyInvitations"),
    companyName: v.string(),
    deliveryAttempt: v.number(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "members.invite");
    if (args.roleIds.length > 0) requirePermission(actor, "roles.manage");
    if (args.teamIds.length > 0) requirePermission(actor, "teams.manage");
    if (actor.kind !== "member") {
      // The table records an inviting membership, and an environment has none. Nor should it: an
      // invitation is a person vouching for a person.
      throw backendError("invalid-arguments", "An environment identity cannot invite members.");
    }

    const email = normalizeEmail(args.email);
    if (email.length === 0) {
      throw backendError("invalid-arguments", "An invitation needs an email address.");
    }

    const company = actor.company;
    const now = Date.now();

    const existing = await ctx.db
      .query("companyInvitations")
      .withIndex("by_company", (q) => q.eq("companyId", company._id))
      .collect();
    // The domain id comes from the client, and an action the client retried after a lost response
    // would arrive with the same one. Refusing keeps one id to one invitation; the retry is told so
    // rather than quietly minting a second token for the same seat.
    if (existing.some((invitation) => invitation.id === args.id)) {
      throw backendError("invitation-exists", `Invitation ${args.id} already exists.`);
    }
    // One live invitation per address, for the same reason: two valid tokens for one seat, one of
    // which any later resend silently invalidates.
    if (
      existing.some(
        (invitation) =>
          invitation.email === email &&
          invitation.state === "pending" &&
          !isInvitationExpired(invitation.expiresAt, now),
      )
    ) {
      throw backendError(
        "invitation-exists",
        "That address already has a pending invitation. Resend or revoke it instead.",
      );
    }

    // Somebody who is already here does not need a link; the message would read as a mistake and
    // acceptance would be a no-op.
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingUser !== null) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_company_and_user", (q) =>
          q.eq("companyId", company._id).eq("userId", existingUser._id),
        )
        .unique();
      if (membership !== null && membership.state === "active") {
        throw backendError("already-a-member", "That person is already a member of this company.");
      }
    }

    // The intended grants must resolve *now*: an invitation naming a team nobody can find is a
    // promise the inviter cannot see is broken until somebody accepts it.
    for (const teamId of args.teamIds) {
      const team = await ctx.db
        .query("teams")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company._id).eq("id", teamId),
        )
        .unique();
      if (team === null) {
        throw backendError("entity-not-found", `No team ${teamId} in this company.`);
      }
    }
    for (const roleId of args.roleIds) {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company._id).eq("id", roleId),
        )
        .unique();
      if (role === null) {
        throw backendError("entity-not-found", `No role ${roleId} in this company.`);
      }
    }

    const invitationDocId = await ctx.db.insert("companyInvitations", {
      id: args.id,
      companyId: company._id,
      email,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      teamIds: [...args.teamIds],
      roleIds: [...args.roleIds],
      invitedByMembershipId: actor.membership._id,
      state: "pending",
      // The first send is attempt one, so the Resend idempotency key of a delivery matches the
      // number the invitation screen shows next to it.
      deliveryAttempt: 1,
      lastDeliveryAt: null,
      lastDeliveryError: null,
      acceptedAt: null,
      acceptedMembershipId: null,
      createdAt: now,
      updatedAt: now,
    });

    return { invitationDocId, companyName: company.name, deliveryAttempt: 1 };
  },
});

/**
 * Records the outcome of one delivery attempt. Internal, and deliberately unauthorized: it is only
 * ever reached from the action that just made the attempt, and it records what happened rather than
 * deciding anything.
 */
export const recordDelivery = internalMutation({
  args: {
    invitationDocId: v.id("companyInvitations"),
    attemptedAt: v.number(),
    error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationDocId);
    if (invitation === null) return null;
    await ctx.db.patch(args.invitationDocId, {
      lastDeliveryAt: args.attemptedAt,
      lastDeliveryError: args.error,
      updatedAt: args.attemptedAt,
    });
    return null;
  },
});

/**
 * Rotates the token behind an existing invitation and bumps its delivery attempt.
 *
 * A resend cannot re-send the original link: the deployment holds a hash, not a token, so the only
 * thing it can put in a second email is a new secret. Rotating is also the better behaviour —
 * whatever inbox the first link reached stops being able to accept — and it comes with a fresh
 * seven days, because a new link that expires tomorrow is not much of a resend.
 */
export const reissue = internalMutation({
  args: {
    companyId: domainIdArg,
    invitationId: domainIdArg,
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.object({
    invitationDocId: v.id("companyInvitations"),
    companyName: v.string(),
    email: v.string(),
    deliveryAttempt: v.number(),
  }),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "members.invite");

    const invitation = await requireInvitation(ctx, actor.company._id, args.invitationId);
    if (invitation.state === "revoked") {
      throw backendError("invitation-revoked", REJECTION_MESSAGES["invitation-revoked"]);
    }
    if (invitation.state === "accepted") {
      throw backendError("invitation-consumed", REJECTION_MESSAGES["invitation-consumed"]);
    }

    const now = Date.now();
    if (
      invitation.lastDeliveryAt !== null &&
      now - invitation.lastDeliveryAt < INVITATION_RESEND_MIN_INTERVAL_MS
    ) {
      throw backendError(
        "rate-limited",
        "This invitation was just sent. Wait a minute before sending it again.",
      );
    }

    const deliveryAttempt = invitation.deliveryAttempt + 1;
    await ctx.db.patch(invitation._id, {
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      // An invitation that lapsed comes back with the new link rather than staying dead.
      state: "pending",
      deliveryAttempt,
      updatedAt: now,
    });

    return {
      invitationDocId: invitation._id,
      companyName: actor.company.name,
      email: invitation.email,
      deliveryAttempt,
    };
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
  handler: async (ctx, args): Promise<null> => {
    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    const expiresAt = invitationExpiresAt(Date.now());

    const reissued = await ctx.runMutation(internal.invitations.reissue, {
      companyId: args.companyId,
      invitationId: args.invitationId,
      tokenHash,
      expiresAt,
    });

    await deliver(ctx, reissued.invitationDocId, {
      companyId: args.companyId,
      companyName: reissued.companyName,
      invitationId: args.invitationId,
      email: reissued.email,
      token,
      expiresAt,
      deliveryAttempt: reissued.deliveryAttempt,
      idempotencyKey: invitationDeliveryIdempotencyKey(args.invitationId, reissued.deliveryAttempt),
    });

    return null;
  },
});

export const revoke = mutation({
  args: { companyId: domainIdArg, invitationId: domainIdArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requireOrganizationWorkspace(actor);
    requirePermission(actor, "members.invite");

    const invitation = await requireInvitation(ctx, actor.company._id, args.invitationId);
    // Revoking twice is the same answer as revoking once; a second click is not an error.
    if (invitation.state === "revoked") return null;
    if (invitation.state === "accepted") {
      // Revocation withdraws a link. Removing somebody who already joined is a membership decision,
      // and pretending otherwise would leave an active member behind a revoked invitation.
      throw backendError("invitation-consumed", REJECTION_MESSAGES["invitation-consumed"]);
    }

    // The token hash stays so a late click is told the invitation was revoked rather than that it
    // never existed.
    await ctx.db.patch(invitation._id, { state: "revoked", updatedAt: Date.now() });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * Accepts an invitation for the signed-in Clerk identity.
 *
 * An action because it hashes the token: the mutation below only ever sees the hash. The email
 * match is on the identity's *verified* address, so a link forwarded to somebody else is useless.
 */
export const accept = action({
  args: { token: v.string() },
  returns: v.object({ companyId: domainIdArg }),
  handler: async (ctx, args): Promise<{ companyId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw backendError("not-authenticated", "Accepting an invitation requires signing in.");
    }
    const tokenHash = await hashInvitationToken(args.token);
    return await ctx.runMutation(internal.invitations.consume, {
      tokenHash,
      clerkSubject: identity.subject,
      // Absent claims read as "no verified address", which the gate refuses. An environment token
      // carries neither, so it falls out here rather than needing a rule of its own.
      email: identity.email ?? "",
      emailVerified: identity.emailVerified === true,
      displayName: identity.name ?? "",
    });
  },
});

/**
 * The transactional half of acceptance: create or reactivate the membership, apply the intended
 * team and role assignments, consume the token, and bump the authorization epoch — all or nothing,
 * so a double-click cannot produce two memberships.
 *
 * Everything the invitee gains is a company-domain record, so it all goes out through one
 * {@link appendCompanyChanges} run: the membership first, then its team and role grants, with the
 * single epoch bump that tells every replica of this company to reseed. One run, one bump — a
 * second call would mean two reseeds for one join, and a bump without the rows would mean clients
 * reseeding into a company that has not learned about the new member yet.
 *
 * The rows are attributed to the joining membership. Acceptance is the invitee's act; the inviter's
 * part is already recorded as `invitedByMembershipId` on the membership itself.
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
    const now = Date.now();
    const invitation = await ctx.db
      .query("companyInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();

    const rejection = checkInvitationAcceptable(
      invitation === null
        ? null
        : { state: invitation.state, email: invitation.email, expiresAt: invitation.expiresAt },
      { email: args.email, emailVerified: args.emailVerified },
      now,
    );
    // An expired invitation is *not* marked expired here: this transaction is about to throw, and a
    // rolled-back patch is no patch at all. The state column is a delivery-side label; the gate
    // above is what decides, and it compares timestamps.
    if (rejection !== null) throw backendError(rejection, REJECTION_MESSAGES[rejection]);
    if (invitation === null) {
      throw backendError("invitation-not-found", REJECTION_MESSAGES["invitation-not-found"]);
    }

    const company = await ctx.db.get(invitation.companyId);
    if (company === null) {
      throw backendError("company-not-found", "The inviting company no longer exists.");
    }
    if (company.lifecycleState !== "active") {
      throw backendError(
        "company-unavailable",
        "This company is scheduled for deletion and cannot be joined.",
      );
    }
    if ((company.workspaceKind ?? "organization") !== "organization") {
      throw backendError(
        "organization-required",
        "Upgrade this personal workspace to an organization to accept invitations.",
      );
    }

    const email = normalizeEmail(args.email);
    const displayName = args.displayName.trim() || (email.split("@")[0] ?? "").trim() || "Member";
    const userDocId = await upsertUser(ctx, {
      clerkSubject: args.clerkSubject,
      email,
      displayName,
      now,
    });

    const inviter = await ctx.db.get(invitation.invitedByMembershipId);
    const membership = await joinCompany(ctx, {
      companyDocId: company._id,
      userDocId,
      email,
      displayName,
      invitedByMembershipId: inviter?.id ?? null,
      now,
    });

    const changes: CompanyChange[] = [
      {
        entityKind: "membership",
        entityId: membership.id,
        changeKind: "upsert",
        versionDocId: membership._id,
        payload: encodeMembership(membership),
      },
      ...(await grantTeams(ctx, {
        company,
        membership,
        teamIds: invitation.teamIds,
        now,
      })),
      ...(await grantRoles(ctx, {
        company,
        membership,
        roleIds: invitation.roleIds,
        now,
      })),
    ];

    // Consuming the token is part of the same transaction as the membership it created: if anything
    // above threw, the invitation is still pending and nobody joined.
    await ctx.db.patch(invitation._id, {
      state: "accepted",
      acceptedAt: now,
      acceptedMembershipId: membership._id,
      updatedAt: now,
    });

    await appendCompanyChanges(ctx, {
      companyId: company._id,
      actor: { kind: "member", membershipId: membership.id },
      changes,
      bumpEpoch: true,
    });

    return { companyId: company.id };
  },
});

/** The `users` row behind a Clerk subject, created on first acceptance and refreshed on later ones. */
async function upsertUser(
  ctx: MutationCtx,
  input: {
    readonly clerkSubject: string;
    readonly email: string;
    readonly displayName: string;
    readonly now: number;
  },
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", input.clerkSubject))
    .unique();
  if (existing === null) {
    return await ctx.db.insert("users", {
      clerkSubject: input.clerkSubject,
      email: input.email,
      displayName: input.displayName,
      // The identity's picture is provisioning's business; acceptance only needs the person to exist.
      imageUrl: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  if (existing.email !== input.email || existing.displayName !== input.displayName) {
    await ctx.db.patch(existing._id, {
      email: input.email,
      displayName: input.displayName,
      updatedAt: input.now,
    });
  }
  return existing._id;
}

/**
 * The membership the invitee ends up with: a new one, or the one they already had brought back.
 *
 * Reactivation is why memberships are never deleted. Somebody who left keeps their id, so their
 * comments and assignments still resolve to them when they return, rather than to a stranger with
 * the same name. A `locked` membership is the one state an invitation cannot override — locking is
 * an administrative decision, and a link is not the way to undo one.
 */
async function joinCompany(
  ctx: MutationCtx,
  input: {
    readonly companyDocId: Id<"companies">;
    readonly userDocId: Id<"users">;
    readonly email: string;
    readonly displayName: string;
    readonly invitedByMembershipId: string | null;
    readonly now: number;
  },
): Promise<Doc<"memberships">> {
  const existing = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) =>
      q.eq("companyId", input.companyDocId).eq("userId", input.userDocId),
    )
    .unique();

  if (existing === null) {
    const membershipDocId = await ctx.db.insert("memberships", {
      id: mintDomainId(input.now),
      companyId: input.companyDocId,
      userId: input.userDocId,
      state: "active",
      displayNameSnapshot: input.displayName,
      emailSnapshot: input.email,
      invitedByMembershipId: input.invitedByMembershipId,
      joinedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
    const membership = await ctx.db.get(membershipDocId);
    if (membership === null) {
      throw backendError("entity-not-found", "The membership insert did not persist.");
    }
    return membership;
  }

  if (existing.state === "locked") {
    throw backendError(
      "membership-locked",
      "This membership is locked. An administrator has to unlock it before you can rejoin.",
    );
  }

  await ctx.db.patch(existing._id, {
    state: "active",
    displayNameSnapshot: input.displayName,
    emailSnapshot: input.email,
    // Rejoining is a new tenure; an already-active member keeps the date they actually joined.
    joinedAt: existing.state === "left" ? input.now : existing.joinedAt,
    updatedAt: input.now,
  });
  const membership = await ctx.db.get(existing._id);
  if (membership === null) {
    throw backendError("entity-not-found", "The membership patch did not persist.");
  }
  return membership;
}

/**
 * Adds the invitee to the teams the invitation named, skipping the ones that have since gone.
 *
 * Unlike {@link record}, which refuses to write an invitation naming a team that does not exist,
 * acceptance tolerates an org chart that moved on: a team deleted or archived in the days since the
 * link was sent is the company's decision, and refusing to let somebody in over it would strand the
 * invitee with a link that can never work.
 */
async function grantTeams(
  ctx: MutationCtx,
  input: {
    readonly company: Doc<"companies">;
    readonly membership: Doc<"memberships">;
    readonly teamIds: readonly string[];
    readonly now: number;
  },
): Promise<CompanyChange[]> {
  const changes: CompanyChange[] = [];
  for (const teamDomainId of input.teamIds) {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", input.company._id).eq("id", teamDomainId),
      )
      .unique();
    if (team === null || team.archivedAt !== null) continue;

    const already = await ctx.db
      .query("teamMemberships")
      .withIndex("by_team_and_membership", (q) =>
        q.eq("teamId", team._id).eq("membershipId", input.membership._id),
      )
      .unique();
    if (already !== null) continue;

    const entityId = teamMembershipDomainId(team.id, input.membership.id);
    const docId = await ctx.db.insert("teamMemberships", {
      companyId: input.company._id,
      id: entityId,
      teamId: team._id,
      membershipId: input.membership._id,
      createdAt: input.now,
    });
    const doc = await ctx.db.get(docId);
    if (doc === null) {
      throw backendError("entity-not-found", "The team membership insert did not persist.");
    }
    changes.push({
      entityKind: "teamMembership",
      entityId,
      changeKind: "upsert",
      versionDocId: docId,
      payload: await encodeTeamMembership(ctx, doc),
    });
  }
  return changes;
}

/**
 * Grants the roles the invitation named, at company scope.
 *
 * Company scope rather than team: an invitation's roles are what the person may do in the company,
 * and its teams are where they belong. A team-scoped grant is a separate administrative act with its
 * own mutation, and inferring one from the pair would silently narrow an intended company role.
 */
async function grantRoles(
  ctx: MutationCtx,
  input: {
    readonly company: Doc<"companies">;
    readonly membership: Doc<"memberships">;
    readonly roleIds: readonly string[];
    readonly now: number;
  },
): Promise<CompanyChange[]> {
  const changes: CompanyChange[] = [];
  const assignments = await ctx.db
    .query("roleAssignments")
    .withIndex("by_membership_and_scope", (q) =>
      q.eq("membershipId", input.membership._id).eq("scope", "company"),
    )
    .collect();
  // Read once and tracked as it grows, so an invitation naming the same role twice — or naming one
  // a reactivated membership already holds — produces exactly one assignment.
  const granted = new Set<Id<"roles">>(assignments.map((assignment) => assignment.roleId));

  for (const roleDomainId of input.roleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_company_and_domain_id", (q) =>
        q.eq("companyId", input.company._id).eq("id", roleDomainId),
      )
      .unique();
    if (role === null) continue;
    if (granted.has(role._id)) continue;
    granted.add(role._id);

    const entityId = mintDomainId(input.now);
    const docId = await ctx.db.insert("roleAssignments", {
      id: entityId,
      companyId: input.company._id,
      membershipId: input.membership._id,
      roleId: role._id,
      scope: "company",
      teamId: null,
      createdAt: input.now,
    });
    const doc = await ctx.db.get(docId);
    if (doc === null) {
      throw backendError("entity-not-found", "The role assignment insert did not persist.");
    }
    changes.push({
      entityKind: "roleAssignment",
      entityId,
      changeKind: "upsert",
      versionDocId: docId,
      payload: await encodeRoleAssignment(ctx, doc),
    });
  }
  return changes;
}
