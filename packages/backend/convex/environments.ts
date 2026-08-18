// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * Company environment registry and discovery.
 *
 * A relay token proves which environment and proof key are calling, but deliberately carries no
 * company grant. A member holding `environments.manage` therefore creates the company binding and
 * chooses its service roles/team scope; after that, the key-matched environment may publish only
 * its own descriptor and reachability state. This keeps a valid credential for one environment
 * from claiming an arbitrary company.
 *
 * @module environments
 */
import { v } from "convex/values";

import { isRegisteredProofKey, tokenProofKeyThumbprint } from "../src/environmentRegistrations.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { appendCompanyChanges, encodeEnvironmentRegistration } from "./lib/companyApply.ts";
import { mintDomainId } from "./lib/domainIds.ts";
import { backendError } from "./lib/errors.ts";
import {
  actorRecord,
  isEnvironmentIdentity,
  requireCompanyActor,
  requireIdentity,
  requirePermission,
} from "./lib/identity.ts";
import { domainIdArg } from "./lib/validators.ts";

const relayLinkState = v.union(
  v.literal("unlinked"),
  v.literal("linked"),
  v.literal("degraded"),
  v.literal("revoked"),
);

/** Hand-mirrored `ExecutionEnvironmentDescriptor` from `contracts/environment`. */
const executionEnvironmentDescriptor = v.object({
  environmentId: v.string(),
  label: v.string(),
  platform: v.object({
    os: v.union(
      v.literal("darwin"),
      v.literal("linux"),
      v.literal("windows"),
      v.literal("unknown"),
    ),
    arch: v.union(v.literal("arm64"), v.literal("x64"), v.literal("other")),
  }),
  serverVersion: v.string(),
  capabilities: v.object({
    repositoryIdentity: v.boolean(),
    connectionProbe: v.optional(v.boolean()),
    pullRequests: v.optional(v.boolean()),
    pushAutoSettlement: v.optional(v.boolean()),
    threadSettlement: v.optional(v.boolean()),
    threadSnooze: v.optional(v.boolean()),
    threadPinning: v.optional(v.boolean()),
    threadPinReorder: v.optional(v.boolean()),
    threadTitleRegeneration: v.optional(v.boolean()),
    threadVisitedTracking: v.optional(v.boolean()),
    serverSelfUpdate: v.optional(
      v.union(v.literal("boot-service"), v.literal("respawn"), v.literal("desktop-managed")),
    ),
    serverSelfUpdateProgress: v.optional(v.boolean()),
  }),
});

const registrationResult = v.object({
  id: domainIdArg,
  environmentId: v.string(),
  publicKeyThumbprint: v.string(),
  descriptor: executionEnvironmentDescriptor,
  relayLinkState,
  managedEndpointAvailable: v.boolean(),
  lastSeenAt: v.union(v.number(), v.null()),
  serviceRoleIds: v.array(domainIdArg),
  teamIds: v.array(domainIdArg),
  state: v.union(v.literal("active"), v.literal("revoked")),
  registeredByMembershipId: v.union(domainIdArg, v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const REGISTER_ARGS = {
  companyId: domainIdArg,
  environmentId: v.string(),
  publicKeyThumbprint: v.optional(v.string()),
  descriptor: executionEnvironmentDescriptor,
  relayLinkState,
  managedEndpointAvailable: v.boolean(),
  /** Administration-only. An environment may not rewrite the grants that authorize itself. */
  serviceRoleIds: v.optional(v.array(domainIdArg)),
  teamIds: v.optional(v.array(domainIdArg)),
};

const REGISTRY_MAX_ROWS = 2_000;

type Descriptor = {
  readonly environmentId: string;
  readonly label: string;
  readonly platform: { readonly os: string; readonly arch: string };
  readonly serverVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
};

function requireTrimmed(value: string, what: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw backendError("invalid-arguments", `${what} must be a non-empty, trimmed string.`);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Stable projection of every descriptor field, independent of object key insertion order. */
function descriptorKey(value: Descriptor): string {
  const capabilities = value.capabilities;
  return JSON.stringify([
    value.environmentId,
    value.label,
    value.platform.os,
    value.platform.arch,
    value.serverVersion,
    capabilities["repositoryIdentity"],
    capabilities["connectionProbe"],
    capabilities["pullRequests"],
    capabilities["pushAutoSettlement"],
    capabilities["threadSettlement"],
    capabilities["threadSnooze"],
    capabilities["threadPinning"],
    capabilities["threadPinReorder"],
    capabilities["threadTitleRegeneration"],
    capabilities["threadVisitedTracking"],
    capabilities["serverSelfUpdate"],
    capabilities["serverSelfUpdateProgress"],
  ]);
}

function sameDescriptor(left: unknown, right: Descriptor): boolean {
  if (typeof left !== "object" || left === null) return false;
  const candidate = left as Partial<Descriptor>;
  if (
    typeof candidate.environmentId !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.serverVersion !== "string" ||
    typeof candidate.platform !== "object" ||
    candidate.platform === null ||
    typeof candidate.capabilities !== "object" ||
    candidate.capabilities === null
  ) {
    return false;
  }
  return descriptorKey(candidate as Descriptor) === descriptorKey(right);
}

function registrationByEnvironment(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  environmentId: string,
): Promise<Doc<"environmentRegistrations"> | null> {
  return ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", companyId).eq("environmentId", environmentId),
    )
    .unique();
}

async function requireManagedReferences(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  serviceRoleIds: readonly string[],
  teamIds: readonly string[],
): Promise<void> {
  if (
    new Set(serviceRoleIds).size !== serviceRoleIds.length ||
    new Set(teamIds).size !== teamIds.length
  ) {
    throw backendError("invalid-arguments", "Registration role and team ids must be unique.");
  }
  for (const roleId of serviceRoleIds) {
    const role = await ctx.db
      .query("roles")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", roleId))
      .unique();
    if (role === null) throw backendError("entity-not-found", `No role ${roleId} in this company.`);
  }
  for (const teamId of teamIds) {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_company_and_domain_id", (q) => q.eq("companyId", companyId).eq("id", teamId))
      .unique();
    if (team === null) throw backendError("entity-not-found", `No team ${teamId} in this company.`);
  }
}

async function activeRegistrationResult(ctx: QueryCtx, row: Doc<"environmentRegistrations">) {
  return await encodeEnvironmentRegistration(ctx, row);
}

export const list = query({
  args: { companyId: domainIdArg },
  returns: v.array(registrationResult),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.read");
    const rows = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_state", (q) =>
        q.eq("companyId", actor.company._id).eq("state", "active"),
      )
      .take(REGISTRY_MAX_ROWS);
    return await Promise.all(rows.map((row) => activeRegistrationResult(ctx, row)));
  },
});

export const get = query({
  args: { companyId: domainIdArg, environmentId: v.string() },
  returns: v.union(registrationResult, v.null()),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.read");
    const row = await registrationByEnvironment(ctx, actor.company._id, args.environmentId);
    return row === null || row.state !== "active" ? null : await activeRegistrationResult(ctx, row);
  },
});

/**
 * Discovers every active company registration owned by the authenticated environment identity.
 *
 * Unlike company-scoped reads, this is the bootstrap boundary that tells an environment which
 * company replicas to start. Each row is still proof-key-bound independently: sharing an
 * environment id does not reveal a company whose registration names a different key.
 */
export const listRegisteredCompanies = query({
  args: {},
  returns: v.array(domainIdArg),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    if (!isEnvironmentIdentity(identity)) {
      throw backendError(
        "permission-denied",
        "Only an environment can discover its company registrations.",
      );
    }

    const tokenThumbprint = tokenProofKeyThumbprint(identity);
    const rows = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_environment", (q) => q.eq("environmentId", identity.subject))
      .take(REGISTRY_MAX_ROWS + 1);
    if (rows.length > REGISTRY_MAX_ROWS) {
      throw backendError(
        "registry-too-large",
        `This environment has more than ${REGISTRY_MAX_ROWS} company registrations.`,
      );
    }
    const companyIds: string[] = [];
    for (const row of rows) {
      if (
        row.state !== "active" ||
        !isRegisteredProofKey({
          tokenThumbprint,
          registeredThumbprint: row.publicKeyThumbprint,
        })
      ) {
        continue;
      }
      const company = await ctx.db.get(row.companyId);
      if (company === null || company.lifecycleState !== "active") continue;
      companyIds.push(company.id);
    }
    return companyIds.sort((left, right) => left.localeCompare(right));
  },
});

/**
 * Creates/administers a company binding as a manager, or publishes an existing environment's own
 * discovery record after the standard relay issuer + registered proof-key check.
 */
export const register = mutation({
  args: REGISTER_ARGS,
  returns: v.null(),
  handler: async (ctx, args) => {
    const environmentId = requireTrimmed(args.environmentId, "An environment id");
    requireTrimmed(args.descriptor.label, "An environment label");
    requireTrimmed(args.descriptor.serverVersion, "A server version");
    if (args.descriptor.environmentId !== environmentId) {
      throw backendError(
        "invalid-arguments",
        "The descriptor must name the registered environment.",
      );
    }

    const identity = await requireIdentity(ctx);
    const actor = await requireCompanyActor(ctx, args.companyId);
    const environmentSelf = isEnvironmentIdentity(identity);
    let existing = await registrationByEnvironment(ctx, actor.company._id, environmentId);

    if (environmentSelf) {
      if (actor.kind !== "environment" || actor.registration.environmentId !== environmentId) {
        throw backendError(
          "permission-denied",
          "An environment may only publish its own registration.",
        );
      }
      existing = actor.registration;
      if (
        args.publicKeyThumbprint !== undefined &&
        !isRegisteredProofKey({
          tokenThumbprint: tokenProofKeyThumbprint(identity),
          registeredThumbprint: requireTrimmed(args.publicKeyThumbprint, "A proof-key thumbprint"),
        })
      ) {
        throw backendError(
          "environment-key-mismatch",
          "This token is not bound to the submitted registration key.",
        );
      }
      if (
        (args.serviceRoleIds !== undefined &&
          !sameStrings(args.serviceRoleIds, existing.serviceRoleIds)) ||
        (args.teamIds !== undefined && !sameStrings(args.teamIds, existing.teamIds))
      ) {
        throw backendError("permission-denied", "An environment cannot change its own grants.");
      }
    } else {
      requirePermission(actor, "environments.manage");
    }

    const now = Date.now();
    if (existing === null) {
      if (actor.kind !== "member") {
        throw backendError(
          "environment-not-registered",
          "A manager must create this registration first.",
        );
      }
      const publicKeyThumbprint = requireTrimmed(
        args.publicKeyThumbprint ?? "",
        "A proof-key thumbprint",
      );
      const serviceRoleIds = args.serviceRoleIds ?? [];
      const teamIds = args.teamIds ?? [];
      await requireManagedReferences(ctx, actor.company._id, serviceRoleIds, teamIds);
      const registrationDocId = await ctx.db.insert("environmentRegistrations", {
        id: mintDomainId(now),
        companyId: actor.company._id,
        environmentId,
        publicKeyThumbprint,
        descriptor: args.descriptor,
        relayLinkState: args.relayLinkState,
        managedEndpointAvailable: args.managedEndpointAvailable,
        lastSeenAt: now,
        serviceRoleIds: [...serviceRoleIds],
        teamIds: [...teamIds],
        state: "active",
        registeredByMembershipId: actor.membership._id,
        createdAt: now,
        updatedAt: now,
      });
      const registration = await ctx.db.get(registrationDocId);
      if (registration === null)
        throw backendError("entity-not-found", "The registration vanished.");
      await appendCompanyChanges(ctx, {
        companyId: actor.company._id,
        actor: actorRecord(actor),
        changes: [
          {
            entityKind: "environmentRegistration",
            entityId: registration.id,
            changeKind: "upsert",
            versionDocId: registrationDocId,
            payload: await encodeEnvironmentRegistration(ctx, registration),
          },
        ],
        // A new service identity can authorize as soon as this row exists.
        bumpEpoch: true,
      });
      return null;
    }

    const publicKeyThumbprint =
      actor.kind === "member" && args.publicKeyThumbprint !== undefined
        ? requireTrimmed(args.publicKeyThumbprint, "A proof-key thumbprint")
        : existing.publicKeyThumbprint;
    const serviceRoleIds =
      actor.kind === "member"
        ? (args.serviceRoleIds ?? existing.serviceRoleIds)
        : existing.serviceRoleIds;
    const teamIds = actor.kind === "member" ? (args.teamIds ?? existing.teamIds) : existing.teamIds;
    if (actor.kind === "member") {
      await requireManagedReferences(ctx, actor.company._id, serviceRoleIds, teamIds);
    }
    const publishedChanged =
      !sameDescriptor(existing.descriptor, args.descriptor) ||
      existing.relayLinkState !== args.relayLinkState ||
      existing.managedEndpointAvailable !== args.managedEndpointAvailable ||
      existing.publicKeyThumbprint !== publicKeyThumbprint ||
      !sameStrings(existing.serviceRoleIds, serviceRoleIds) ||
      !sameStrings(existing.teamIds, teamIds) ||
      existing.state !== "active";
    const authorizationChanged =
      existing.publicKeyThumbprint !== publicKeyThumbprint ||
      !sameStrings(existing.serviceRoleIds, serviceRoleIds) ||
      !sameStrings(existing.teamIds, teamIds) ||
      existing.state !== "active";
    const patch = {
      publicKeyThumbprint,
      descriptor: args.descriptor,
      relayLinkState: args.relayLinkState,
      managedEndpointAvailable: args.managedEndpointAvailable,
      lastSeenAt: now,
      serviceRoleIds: [...serviceRoleIds],
      teamIds: [...teamIds],
      state: "active" as const,
      ...(publishedChanged ? { updatedAt: now } : {}),
    };
    await ctx.db.patch(existing._id, patch);
    if (!publishedChanged) return null;
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "environmentRegistration",
          entityId: existing.id,
          changeKind: "upsert",
          versionDocId: existing._id,
          payload: await encodeEnvironmentRegistration(ctx, { ...existing, ...patch }),
        },
      ],
      bumpEpoch: authorizationChanged,
    });
    return null;
  },
});

export const heartbeat = mutation({
  args: {
    companyId: domainIdArg,
    relayLinkState,
    managedEndpointAvailable: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    if (actor.kind !== "environment") {
      throw backendError(
        "permission-denied",
        "Only an environment can heartbeat its registration.",
      );
    }
    const registration = actor.registration;
    const publishedChanged =
      registration.relayLinkState !== args.relayLinkState ||
      registration.managedEndpointAvailable !== args.managedEndpointAvailable;
    const now = Date.now();
    const patch = {
      relayLinkState: args.relayLinkState,
      managedEndpointAvailable: args.managedEndpointAvailable,
      lastSeenAt: now,
      ...(publishedChanged ? { updatedAt: now } : {}),
    };
    await ctx.db.patch(registration._id, patch);

    // `lastSeenAt` is freshness metadata read directly by discovery queries. Appending every beat
    // would advance the company-wide feed forever while no durable registry choice changed, so a
    // heartbeat emits only when link state or endpoint availability changes.
    if (publishedChanged) {
      await appendCompanyChanges(ctx, {
        companyId: actor.company._id,
        actor: actorRecord(actor),
        changes: [
          {
            entityKind: "environmentRegistration",
            entityId: registration.id,
            changeKind: "upsert",
            versionDocId: registration._id,
            payload: await encodeEnvironmentRegistration(ctx, { ...registration, ...patch }),
          },
        ],
      });
    }
    return null;
  },
});

export const deactivate = mutation({
  args: { companyId: domainIdArg, environmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireCompanyActor(ctx, args.companyId);
    requirePermission(actor, "environments.manage");
    const registration = await registrationByEnvironment(
      ctx,
      actor.company._id,
      requireTrimmed(args.environmentId, "An environment id"),
    );
    if (registration === null) {
      throw backendError(
        "entity-not-found",
        `No environment ${args.environmentId} in this company.`,
      );
    }
    if (registration.state === "revoked") return null;
    const now = Date.now();
    await ctx.db.patch(registration._id, {
      state: "revoked",
      relayLinkState: "revoked",
      updatedAt: now,
    });
    const heldLeases = await ctx.db
      .query("slackCoordinatorLeases")
      .withIndex("by_holder_and_expiry", (q) =>
        q.eq("holderEnvironmentId", registration.environmentId),
      )
      .collect();
    for (const lease of heldLeases) {
      await ctx.db.patch(lease._id, {
        holderEnvironmentId: null,
        generation: lease.generation + 1,
        expiresAt: null,
        preferredHealthyHeartbeats: 0,
        updatedAt: now,
      });
    }
    for (const state of ["claimed", "running"] as const) {
      const jobs = await ctx.db
        .query("issueAutomationJobs")
        .withIndex("by_target_and_state", (q) =>
          q.eq("targetEnvironmentId", registration.environmentId).eq("state", state),
        )
        .collect();
      for (const job of jobs) {
        await ctx.db.patch(job._id, {
          state: "blocked",
          blockCode: "authorization-revoked",
          diagnostic: "The target environment registration was revoked.",
          claimHolderEnvironmentId: null,
          claimGeneration: job.claimGeneration + 1,
          claimExpiresAt: null,
          nextRetryAt: null,
          updatedAt: now,
        });
      }
    }
    await appendCompanyChanges(ctx, {
      companyId: actor.company._id,
      actor: actorRecord(actor),
      changes: [
        {
          entityKind: "environmentRegistration",
          entityId: registration.id,
          changeKind: "tombstone",
          versionDocId: registration._id,
          payload: null,
        },
      ],
      // Revocation changes whether the environment can resolve as a company actor.
      bumpEpoch: true,
    });
    return null;
  },
});
