/**
 * Resolves the caller into a company-scoped actor with effective permissions.
 *
 * Two identities reach a company function: a Clerk human, who must hold an active membership, and
 * a Pathway environment presenting a relay-minted `pathway-convex` token, whose authorization comes
 * from its Convex registration rather than from anything in the token.
 *
 * @module lib/identity
 */
import type { UserIdentity } from "convex/server";

import {
  isRegisteredProofKey,
  serviceRoleScopes,
  tokenProofKeyThumbprint,
} from "../../src/environmentRegistrations.ts";
import {
  isPermissionKey,
  resolveEffectivePermissions,
  type EffectivePermissions,
  type PermissionKey,
  type RoleAssignment,
  type RoleDefinition,
} from "../../src/permissions.ts";
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { backendError } from "./errors.ts";

export interface MemberActor {
  readonly kind: "member";
  readonly user: Doc<"users">;
  readonly membership: Doc<"memberships">;
  readonly company: Doc<"companies">;
  readonly isOwner: boolean;
  readonly permissions: EffectivePermissions;
}

export interface EnvironmentActor {
  readonly kind: "environment";
  readonly registration: Doc<"environmentRegistrations">;
  readonly company: Doc<"companies">;
  readonly permissions: EffectivePermissions;
}

export type CompanyActor = MemberActor | EnvironmentActor;

function relayIssuer(): string | undefined {
  return process.env.PATHWAY_RELAY_JWT_ISSUER;
}

/** True when the token came from the relay's `pathway-convex` audience rather than from Clerk. */
export function isEnvironmentIdentity(identity: UserIdentity): boolean {
  const issuer = relayIssuer();
  return issuer !== undefined && identity.issuer === issuer;
}

export async function requireIdentity(ctx: QueryCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw backendError("not-authenticated", "This request requires an authenticated identity.");
  }
  return identity;
}

export async function currentUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null || isEnvironmentIdentity(identity)) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_subject", (q) => q.eq("clerkSubject", identity.subject))
    .unique();
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (user === null) {
    throw backendError("user-not-provisioned", "No Pathway user exists for this identity yet.");
  }
  return user;
}

async function requireCompanyByDomainId(
  ctx: QueryCtx,
  companyId: string,
): Promise<Doc<"companies">> {
  const company = await ctx.db
    .query("companies")
    .withIndex("by_domain_id", (q) => q.eq("id", companyId))
    .unique();
  if (company === null) {
    throw backendError("company-not-found", `No company ${companyId}.`);
  }
  if (company.lifecycleState !== "active") {
    throw backendError(
      "company-unavailable",
      "This company is scheduled for deletion and cannot be accessed.",
    );
  }
  return company;
}

function toRoleDefinition(role: Doc<"roles">): RoleDefinition {
  return { roleId: role._id, permissions: role.permissions.filter(isPermissionKey) };
}

/** Loads the roles a membership is assigned and unions them into effective permissions. */
async function membershipPermissions(
  ctx: QueryCtx,
  membership: Doc<"memberships">,
  isOwner: boolean,
): Promise<EffectivePermissions> {
  const assignmentDocs = await ctx.db
    .query("roleAssignments")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .collect();

  const roles: RoleDefinition[] = [];
  const assignments: RoleAssignment[] = [];
  const seenRoles = new Set<string>();

  for (const assignment of assignmentDocs) {
    if (!seenRoles.has(assignment.roleId)) {
      seenRoles.add(assignment.roleId);
      const role = await ctx.db.get(assignment.roleId);
      if (role !== null) roles.push(toRoleDefinition(role));
    }
    assignments.push({
      roleId: assignment.roleId,
      scope:
        assignment.scope === "company" || assignment.teamId === null
          ? { kind: "company" }
          : { kind: "team", teamId: assignment.teamId },
    });
  }

  return resolveEffectivePermissions({ isOwner, roles, assignments });
}

/**
 * The single authorization entry point for company-scoped functions. Membership state matters:
 * `locked` and `left` memberships resolve to no actor at all rather than to an actor with no
 * permissions, so a locked member cannot be told what they are missing.
 */
export async function requireCompanyActor(ctx: QueryCtx, companyId: string): Promise<CompanyActor> {
  const identity = await requireIdentity(ctx);
  const company = await requireCompanyByDomainId(ctx, companyId);

  if (isEnvironmentIdentity(identity)) {
    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", company._id).eq("environmentId", identity.subject),
      )
      .unique();
    if (registration === null || registration.state !== "active") {
      throw backendError(
        "environment-not-registered",
        "This environment is not registered with the company.",
      );
    }

    // The relay authenticates the environment and records the key it proved possession of in
    // `cnf.jkt`. Convex re-checks that key against the one the company registered: a valid relay
    // token bound to any other key is somebody else's environment, whatever its subject claims.
    if (
      !isRegisteredProofKey({
        tokenThumbprint: tokenProofKeyThumbprint(identity),
        registeredThumbprint: registration.publicKeyThumbprint,
      })
    ) {
      throw backendError(
        "environment-key-mismatch",
        "This token is not bound to the key this environment registered.",
      );
    }

    const roles: RoleDefinition[] = [];
    const assignments: RoleAssignment[] = [];
    // The registration's `teamIds` bound what its service roles reach: an environment registered
    // for specific teams gets team-scoped grants, and only a registration with no teams is
    // company-wide.
    const scopes = serviceRoleScopes(registration.teamIds);
    for (const roleDomainId of registration.serviceRoleIds) {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", company._id).eq("id", roleDomainId),
        )
        .unique();
      if (role === null) continue;
      roles.push(toRoleDefinition(role));
      for (const scope of scopes) assignments.push({ roleId: role._id, scope });
    }

    return {
      kind: "environment",
      registration,
      company,
      permissions: resolveEffectivePermissions({ isOwner: false, roles, assignments }),
    };
  }

  const user = await requireUser(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_company_and_user", (q) => q.eq("companyId", company._id).eq("userId", user._id))
    .unique();
  if (membership === null || membership.state !== "active") {
    throw backendError("not-a-member", "You are not an active member of this company.");
  }

  const owner = await ctx.db
    .query("companyOwners")
    .withIndex("by_company_and_membership", (q) =>
      q.eq("companyId", company._id).eq("membershipId", membership._id),
    )
    .unique();
  const isOwner = owner !== null;

  return {
    kind: "member",
    user,
    membership,
    company,
    isOwner,
    permissions: await membershipPermissions(ctx, membership, isOwner),
  };
}

export function requirePermission(actor: CompanyActor, permission: PermissionKey): void {
  if (actor.permissions.isOwner || actor.permissions.company.has(permission)) return;
  throw backendError("permission-denied", `Missing permission ${permission}.`);
}

/** Record-level variant: any team the record is attached to may grant the permission. */
export function requireRecordPermission(
  actor: CompanyActor,
  permission: PermissionKey,
  teamIds: readonly string[],
): void {
  if (actor.permissions.isOwner || actor.permissions.company.has(permission)) return;
  for (const teamId of teamIds) {
    if (actor.permissions.teams.get(teamId)?.has(permission) === true) return;
  }
  throw backendError("permission-denied", `Missing permission ${permission}.`);
}

/** The audit-facing identity of whoever is acting, in the shape the change feed stores. */
export function actorRecord(
  actor: CompanyActor,
):
  | { readonly kind: "member"; readonly membershipId: string }
  | { readonly kind: "environment"; readonly environmentId: string } {
  return actor.kind === "member"
    ? { kind: "member", membershipId: actor.membership.id }
    : { kind: "environment", environmentId: actor.registration.environmentId };
}
