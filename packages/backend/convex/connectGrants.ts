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
import {
  AuthPeerReadGrantPermission,
  AuthPeerThreadAccessUnsupportedCode,
  AuthPeerSendGrantPermission,
} from "@spiritdevs/contracts";
import { v } from "convex/values";

import {
  checkConnectGrantValidity,
  connectGrantExpiresAt,
  generateConnectGrantToken,
  hashConnectGrantToken,
} from "../src/connectGrants.ts";
import { isRegisteredProofKey, tokenProofKeyThumbprint } from "../src/environmentRegistrations.ts";
import { hasCompanyPermission, isPermissionKey } from "../src/permissions.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server.js";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  isEnvironmentIdentity,
  membershipAuthorization,
  requireCompanyActor,
  requireIdentity,
  requirePermission,
} from "./lib/identity.ts";
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
    threadAccess: v.optional(v.union(v.literal("read"), v.literal("send"))),
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

const THREAD_ACCESS_PERMISSIONS = {
  read: AuthPeerReadGrantPermission,
  send: AuthPeerSendGrantPermission,
} as const;
const threadAccess = v.union(v.literal("read"), v.literal("send"));

/**
 * Whether the target honours the thread-access mint scopes. Older targets reject those mints, so a
 * thread grant for them is useless; anything but an explicit `true` counts as unsupported.
 */
function enforcesPeerThreadGrants(registration: Doc<"environmentRegistrations">): boolean {
  const descriptor: unknown = registration.descriptor;
  if (typeof descriptor !== "object" || descriptor === null) return false;
  const capabilities = (descriptor as Record<string, unknown>)["capabilities"];
  return (
    typeof capabilities === "object" &&
    capabilities !== null &&
    (capabilities as Record<string, unknown>)["peerThreadGrants"] === true
  );
}

const issuedThreadAccessGrant = v.union(
  v.object({ token: v.string(), environmentId: v.string() }),
  v.null(),
);

/**
 * Mints a single-use grant that lets the calling environment read, or send a message to, one
 * thread on the environment that published it. The grant acts as the account that linked the
 * caller, in any company where that account holds the access's permission: `environments.read` to
 * read, `remoteAgents.control` to send. `null` means no environment the account may reach
 * publishes the thread.
 */
export const issueThreadAccess = action({
  args: { threadId: v.string(), access: threadAccess },
  returns: issuedThreadAccessGrant,
  handler: async (ctx, args): Promise<{ token: string; environmentId: string } | null> => {
    const token = generateConnectGrantToken();
    const tokenHash = await hashConnectGrantToken(token);
    const environmentId: string | null = await ctx.runMutation(
      internal.connectGrants.recordThreadAccess,
      { ...args, tokenHash },
    );
    return environmentId === null ? null : { token, environmentId };
  },
});

/**
 * The one account that linked the calling environment through the relay. Registrations only
 * authenticate the caller's key; whoever created them may be a manager, not the environment's owner.
 */
async function environmentAccountUser(ctx: QueryCtx): Promise<{
  readonly environmentId: string;
  readonly userId: Id<"users">;
}> {
  const identity = await requireIdentity(ctx);
  if (!isEnvironmentIdentity(identity)) {
    throw backendError("permission-denied", "Only an environment may request thread access.");
  }
  const tokenThumbprint = tokenProofKeyThumbprint(identity);
  const registrations = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_environment", (q) => q.eq("environmentId", identity.subject))
    .collect();
  const authenticated = registrations.some(
    (registration) =>
      registration.state === "active" &&
      isRegisteredProofKey({
        tokenThumbprint,
        registeredThumbprint: registration.publicKeyThumbprint,
      }),
  );
  const links = authenticated
    ? await ctx.db
        .query("relayEnvironmentLinks")
        .withIndex("by_environment", (q) => q.eq("environmentId", identity.subject))
        .collect()
    : [];
  const [subject, ...others] = new Set(
    links.filter((link) => link.revokedAt === null).map((link) => link.userId),
  );
  const user =
    subject === undefined || others.length > 0
      ? null
      : await ctx.db
          .query("users")
          .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", subject))
          .unique();
  if (user === null) {
    throw backendError(
      "permission-denied",
      "This environment is not linked to exactly one Pathway account.",
    );
  }
  return { environmentId: identity.subject, userId: user._id };
}

/** Resolves the linked account to the same internal user id carried by company memberships. */
export const accountUser = query({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => (await environmentAccountUser(ctx)).userId,
});

/** Authorization and storage half of {@link issueThreadAccess}. */
export const recordThreadAccess = internalMutation({
  args: { threadId: v.string(), access: threadAccess, tokenHash: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const caller = await environmentAccountUser(ctx);
    const permission = THREAD_ACCESS_PERMISSIONS[args.access];
    let unsupportedTarget = false;
    const published = await ctx.db
      .query("agentThreads")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    for (const row of published.toSorted((left, right) => right.updatedAt - left.updatedAt)) {
      if (row.environmentId === caller.environmentId) continue;
      const member = await activeMember(ctx, row.companyId, caller.userId);
      if (member === null) continue;
      const registration = await activeRegistration(ctx, row.companyId, row.environmentId);
      if (registration === null) continue;
      if (!enforcesPeerThreadGrants(registration)) {
        unsupportedTarget = true;
        continue;
      }
      if (!hasCompanyPermission(member.permissions, permission)) continue;
      const membership = member.membership;

      const issuedAt = Date.now();
      await ctx.db.insert("connectGrants", {
        id: mintDomainId(issuedAt),
        companyId: row.companyId,
        environmentId: row.environmentId,
        targetRegistrationId: registration._id,
        grantedMembershipId: membership._id,
        permission,
        tokenHash: args.tokenHash,
        issuedAt,
        expiresAt: connectGrantExpiresAt(issuedAt),
        consumedAt: null,
        consumer: null,
        threadAccess: args.access,
      });
      return row.environmentId;
    }
    if (unsupportedTarget)
      throw backendError(
        AuthPeerThreadAccessUnsupportedCode,
        "The environment holding this thread runs a Pathway version that cannot limit remote thread access. Update Pathway there to reach it remotely.",
      );
    return null;
  },
});

/** The account's active membership in an active company, with its effective permissions. */
async function activeMember(ctx: QueryCtx, companyId: Id<"companies">, userId: Id<"users">) {
  const company = await ctx.db.get(companyId);
  if (company?.lifecycleState !== "active") return null;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .unique();
  if (membership?.state !== "active") return null;
  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membership._id),
    )
    .unique();
  const { permissions } = await membershipAuthorization(ctx, membership, owner !== null);
  return { membership, permissions };
}

async function activeRegistration(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  environmentId: string,
) {
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
  return registration?.state === "active" ? registration : null;
}

/** Starting a thread elsewhere is a dispatch that the started thread's sender then controls. */
const LAUNCH_PERMISSIONS = ["remoteAgents.dispatch", AuthPeerSendGrantPermission] as const;

/**
 * An active project checkout on another environment that the calling environment's account may
 * start threads in. `null` when any part of that chain is missing or unauthorized.
 */
async function launchTarget(
  ctx: QueryCtx,
  caller: { readonly environmentId: string; readonly userId: Id<"users"> },
  binding: Doc<"environmentBindings">,
) {
  if (binding.status !== "active" || binding.environmentId === caller.environmentId) return null;
  const member = await activeMember(ctx, binding.companyId, caller.userId);
  if (
    member === null ||
    !LAUNCH_PERMISSIONS.every((permission) => hasCompanyPermission(member.permissions, permission))
  )
    return null;
  const registration = await activeRegistration(ctx, binding.companyId, binding.environmentId);
  const project = await ctx.db.get(binding.cloudProjectId);
  if (registration === null || project === null || project.deletedAt !== null) return null;
  if (project.archivedAt !== null) return null;
  return { binding, registration, project, membership: member.membership };
}

function descriptorLabel(registration: Doc<"environmentRegistrations">): string {
  const descriptor: unknown = registration.descriptor;
  const label =
    typeof descriptor === "object" && descriptor !== null
      ? (descriptor as Record<string, unknown>)["label"]
      : undefined;
  return typeof label === "string" && label.length > 0 ? label : registration.environmentId;
}

/**
 * Every other environment, with its projects, where the calling environment's account may start
 * a thread through {@link issueProjectLaunch}. `updateRequired` marks environments running a
 * Pathway too old to accept a narrowed launch grant.
 */
export const launchTargets = query({
  args: {},
  returns: v.array(
    v.object({
      environmentId: v.string(),
      label: v.string(),
      lastSeenAt: v.union(v.number(), v.null()),
      updateRequired: v.boolean(),
      projects: v.array(
        v.object({ localProjectId: v.string(), name: v.string(), workspaceRoot: v.string() }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const caller = await environmentAccountUser(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", caller.userId))
      .collect();
    const environments = new Map<
      string,
      {
        environmentId: string;
        label: string;
        lastSeenAt: number | null;
        updateRequired: boolean;
        projects: Array<{ localProjectId: string; name: string; workspaceRoot: string }>;
      }
    >();
    for (const membership of memberships) {
      const bindings = await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_status_environment", (q) =>
          q.eq("companyId", membership.companyId).eq("status", "active"),
        )
        .collect();
      for (const binding of bindings) {
        const target = await launchTarget(ctx, caller, binding);
        if (target === null) continue;
        const environment = environments.get(binding.environmentId) ?? {
          environmentId: binding.environmentId,
          label: descriptorLabel(target.registration),
          lastSeenAt: target.registration.lastSeenAt,
          updateRequired: !enforcesPeerThreadGrants(target.registration),
          projects: [],
        };
        if (
          !environment.projects.some((project) => project.localProjectId === binding.localProjectId)
        )
          environment.projects.push({
            localProjectId: binding.localProjectId,
            name: target.project.name,
            workspaceRoot: binding.localWorkspaceRoot,
          });
        environments.set(binding.environmentId, environment);
      }
    }
    return [...environments.values()]
      .map((environment) => ({
        ...environment,
        projects: environment.projects.toSorted((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  },
});

/**
 * Mints a single-use grant that lets the calling environment start a thread in one project on
 * another environment, acting as the account that linked the caller. The grant carries send
 * access, which the target already narrows to read and operate scopes. `null` means the account
 * cannot start threads in that project.
 */
export const issueProjectLaunch = action({
  args: { environmentId: v.string(), localProjectId: v.string() },
  returns: v.union(v.object({ token: v.string() }), v.null()),
  handler: async (ctx, args): Promise<{ token: string } | null> => {
    const token = generateConnectGrantToken();
    const tokenHash = await hashConnectGrantToken(token);
    const recorded: boolean = await ctx.runMutation(internal.connectGrants.recordProjectLaunch, {
      ...args,
      tokenHash,
    });
    return recorded ? { token } : null;
  },
});

/** Authorization and storage half of {@link issueProjectLaunch}. */
export const recordProjectLaunch = internalMutation({
  args: { environmentId: v.string(), localProjectId: v.string(), tokenHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const caller = await environmentAccountUser(ctx);
    const bindings = await ctx.db
      .query("environmentBindings")
      .withIndex("by_environment_local_project", (q) =>
        q.eq("environmentId", args.environmentId).eq("localProjectId", args.localProjectId),
      )
      .collect();
    let unsupportedTarget = false;
    for (const binding of bindings) {
      const target = await launchTarget(ctx, caller, binding);
      if (target === null) continue;
      if (!enforcesPeerThreadGrants(target.registration)) {
        unsupportedTarget = true;
        continue;
      }
      const issuedAt = Date.now();
      await ctx.db.insert("connectGrants", {
        id: mintDomainId(issuedAt),
        companyId: binding.companyId,
        environmentId: binding.environmentId,
        targetRegistrationId: target.registration._id,
        grantedMembershipId: target.membership._id,
        permission: AuthPeerSendGrantPermission,
        tokenHash: args.tokenHash,
        issuedAt,
        expiresAt: connectGrantExpiresAt(issuedAt),
        consumedAt: null,
        consumer: null,
        threadAccess: "send",
      });
      return true;
    }
    if (unsupportedTarget)
      throw backendError(
        AuthPeerThreadAccessUnsupportedCode,
        "That environment runs a Pathway version that cannot limit remote access. Update Pathway there to start threads on it remotely.",
      );
    return false;
  },
});

/**
 * Validates and consumes one hashed grant for the relay control plane. Any token, expiry, or live
 * authorization failure returns the same refusal so this surface cannot be used as an oracle.
 */
export const validate = mutation({
  args: {
    tokenHash: v.string(),
    /**
     * Asserted by relays that sign peer thread-access mints with the read or send mint scope, which
     * older targets reject. Thread grants are refused without it, so an older relay can never carry
     * one to a target as an ordinary full-access connect.
     */
    signsThreadAccessMintScopes: v.optional(v.literal(true)),
  },
  returns: validationResult,
  handler: async (ctx, args) => {
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
    // Thread grants need a relay that signs the thread-access mint scopes, which older targets
    // reject. The capability check also catches a target downgraded since issue.
    if (
      grant.threadAccess !== undefined &&
      (args.signsThreadAccessMintScopes !== true ||
        registration === null ||
        !enforcesPeerThreadGrants(registration))
    )
      return REFUSED;

    await ctx.db.patch(grant._id, { consumedAt: now, consumer: relay.subject });
    return {
      status: "accepted" as const,
      environmentId: grant.environmentId,
      membershipId: membership.id,
      permission: grant.permission,
      expiresAt: grant.expiresAt,
      ...(grant.threadAccess === undefined ? {} : { threadAccess: grant.threadAccess }),
    };
  },
});
