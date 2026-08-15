// @effect-diagnostics globalDate:off -- Convex mutations are not Effect programs; the transaction clock is `Date.now()`.
/**
 * The company domain's half of the change feed: payload encoders plus the one writer every
 * administration mutation appends through.
 *
 * Company, membership, team, and role administration is **online-only** — there is no offline
 * write path and no operation kind for any of it. The records still ride the feed, because a
 * replica that cannot render its own member list offline is not much of a replica: the change feed
 * carries them as a permission-filtered read cache, seeded by `sync.bootstrap` and kept current by
 * `sync.listChanges`, exactly like the issue domain.
 *
 * The split of responsibility mirrors `lib/issueApply`: the encoders here are the single source of
 * truth for what one company entity looks like on the wire, shared by this writer and the
 * bootstrap seed, so a row delivered by a seed and the same row delivered by the feed are
 * byte-identical. What differs is the writer. Issue operations arrive in batches and hand their
 * changes back to `sync.applyOperations`, which assigns the version run once for the whole batch;
 * an administration mutation has no batch, so {@link appendCompanyChanges} does that job itself —
 * reserving its own contiguous run off the same company head, by the same rule.
 *
 * None of these tables carry a `deletedAt`: a membership departure is a state patch (attribution
 * outlives the person), a team archive is a timestamp, and environment deactivation is a soft
 * `revoked` row whose feed representation is a tombstone. The two rows that really are deleted —
 * `teamMemberships` and `roleAssignments` — become tombstones with no row left to stamp.
 *
 * @module lib/companyApply
 */
import { changeRetainUntil } from "../../src/sync/changeFeed.ts";
import { assignVersions } from "../../src/sync/operations.ts";
import type { SyncActor, SyncChangeKind, SyncEntityKind } from "../../src/sync/protocol.ts";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { backendError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Kinds and tables
// ---------------------------------------------------------------------------

/**
 * The change-feed kinds this module writes. `companyOwner` is deliberately absent: ownership is a
 * relation with no independent life, so owners are embedded in the `company` payload rather than
 * given a kind of their own — one row to deliver, and no window in which a replica holds an owner
 * whose company it has not seen. `companyInvitation` is absent too, for the opposite reason: an
 * invitation is never delivered offline at all, and stays a `invitations.list` query.
 */
export type CompanyEntityKind = Extract<
  SyncEntityKind,
  | "company"
  | "companySettings"
  | "membership"
  | "team"
  | "teamMembership"
  | "role"
  | "roleAssignment"
  | "cloudProject"
  | "environmentRegistration"
  | "environmentBinding"
  | "environmentCommand"
>;

/** The company-domain tables whose rows carry a `version` column this writer stamps. */
export type CompanyVersionedTable =
  | "companies"
  | "companySettings"
  | "memberships"
  | "teams"
  | "teamMemberships"
  | "roles"
  | "roleAssignments"
  | "cloudProjects"
  | "environmentRegistrations"
  | "environmentBindings"
  | "environmentCommands"
  | "issues"
  | "issueStatuses"
  | "issueLabels"
  | "issueMilestones"
  | "issueCycles"
  | "issueTodos"
  | "issueRelations"
  | "issueComments"
  | "issueAttachments"
  | "issueViews"
  | "issueAuditEvents"
  | "issueThreadLinks";

/**
 * The `version` a company row reads as. Optional in storage so the columns could be added to live
 * tables without a backfill, which means a row untouched since the company domain joined the feed
 * has none — and "never changed since the beginning of the feed" is exactly version zero.
 */
export function companyRowVersion(row: { readonly version?: number }): number {
  return row.version ?? 0;
}

/**
 * The domain id of a `teamMemberships` join row: the composite of the pair it joins, not a minted
 * id. Both halves are UUIDv7 domain ids, so neither can contain the separator and the composite is
 * unambiguous; two of them plus the colon is well under `SYNC_MAX_ID_CHARS`.
 *
 * Deriving rather than minting is what makes removal idempotent — a tombstone has to name the id
 * the upsert used, and re-adding a removed member is the same entity coming back rather than a
 * second one accumulating in every replica.
 *
 * Must stay byte-identical to `teamMembershipSyncEntityId` in `contracts/cloudSync`, which is the
 * client's half of the same agreement.
 */
export function teamMembershipDomainId(teamId: string, membershipId: string): string {
  return `${teamId}:${membershipId}`;
}

/**
 * The domain id of a company's settings row. Settings are a singleton per company, so they borrow
 * the company's identity instead of minting a second one that could only ever be in lock-step.
 */
export function companySettingsDomainId(company: Doc<"companies">): string {
  return company.id;
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

// Payloads carry domain identifiers only — the same rule `lib/issueApply` follows — so a reference
// stored as a Convex `_id` is resolved before it goes on the wire. A dangling one aborts the
// mutation rather than encoding a hole: these are foreign keys inside a single transaction, and a
// replica silently missing the team half of a team membership is worse than a refused write.

async function requireMembershipDomainId(ctx: QueryCtx, id: Id<"memberships">): Promise<string> {
  const doc = await ctx.db.get(id);
  if (doc === null) throw backendError("entity-not-found", "Referenced membership is missing.");
  return doc.id;
}

async function requireTeamDomainId(ctx: QueryCtx, id: Id<"teams">): Promise<string> {
  const doc = await ctx.db.get(id);
  if (doc === null) throw backendError("entity-not-found", "Referenced team is missing.");
  return doc.id;
}

async function requireRoleDomainId(ctx: QueryCtx, id: Id<"roles">): Promise<string> {
  const doc = await ctx.db.get(id);
  if (doc === null) throw backendError("entity-not-found", "Referenced role is missing.");
  return doc.id;
}

async function requireCloudProjectDomainId(
  ctx: QueryCtx,
  id: Id<"cloudProjects">,
): Promise<string> {
  const doc = await ctx.db.get(id);
  if (doc === null) throw backendError("entity-not-found", "Referenced cloud project is missing.");
  return doc.id;
}

// ---------------------------------------------------------------------------
// Payload encoders — the wire shape of one entity, shared by apply and bootstrap
// ---------------------------------------------------------------------------

// These mirror the `Sync*Payload` structs in `contracts/cloudSync`, hand-copied for the reason
// `src/sync/protocol.ts` is: a Convex deployment cannot take a workspace dependency. Four
// conventions come from there and hold for every kind below.
//
// - No `companyId`. A replica is one company by construction, so it would be the same value on
//   every row of every page.
// - No `version` and no `deletedAt`. The version rides the envelope, and a delete is a payloadless
//   `tombstone` rather than a flag inside a payload.
// - No Convex `_id` and no `_creationTime`; a reference stored as one is resolved to its domain id.
// - Nothing secret. Every field is already visible to a caller holding the matching read
//   permission, which is what `src/sync/visibility.ts` gates each kind on.

/**
 * The `company` payload, with its owners embedded.
 *
 * Three stored columns are deliberately absent, matching `SyncCompanyPayload`. `syncVersion` is the
 * head this very row is being appended to, so a copy inside it would be stale before it was
 * written. `authorizationEpoch` rides every `listChanges` and `bootstrap` response already, and a
 * second copy lagging by one change is exactly the disagreement that would stop a client reseeding
 * when it must. `nextIssueNumber` moves on every key lease, which would mean a company change per
 * lease for a counter no client reads.
 */
export async function encodeCompany(ctx: QueryCtx, company: Doc<"companies">): Promise<unknown> {
  const ownerRows = await ctx.db
    .query("companyOwners")
    .withIndex("by_company", (q) => q.eq("companyId", company._id))
    .collect();
  const owners: unknown[] = [];
  for (const owner of ownerRows) {
    owners.push({
      membershipId: await requireMembershipDomainId(ctx, owner.membershipId),
      grantedByMembershipId: owner.grantedByMembershipId,
      createdAt: owner.createdAt,
    });
  }
  return {
    id: company.id,
    name: company.name,
    issueKeyPrefix: company.issueKeyPrefix,
    lifecycleState: company.lifecycleState,
    deletionScheduledAt: company.deletionScheduledAt,
    purgeAfter: company.purgeAfter,
    owners,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

/** Takes the company so a settings row written before the id column existed can still name one. */
export function encodeCompanySettings(
  company: Doc<"companies">,
  doc: Doc<"companySettings">,
): unknown {
  return {
    id: doc.id ?? companySettingsDomainId(company),
    offlineAccessDays: doc.offlineAccessDays,
    updatedByMembershipId: doc.updatedByMembershipId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * `userId` is the one place a Convex `_id` reaches the wire, because `users` has no domain id and
 * `CloudUserId` in `contracts/company` is defined as exactly this — an opaque, server-assigned
 * handle stable for the life of the Clerk identity behind it. It names nobody on its own; the
 * readable half is the two snapshots, which any holder of `members.read` already sees.
 *
 * Ownership is not here. It lives in the `company` payload's `owners`, so there is one answer to
 * "is this member an owner" rather than two that can disagree.
 */
export function encodeMembership(doc: Doc<"memberships">): unknown {
  return {
    id: doc.id,
    userId: doc.userId,
    state: doc.state,
    displayNameSnapshot: doc.displayNameSnapshot,
    emailSnapshot: doc.emailSnapshot,
    invitedByMembershipId: doc.invitedByMembershipId,
    joinedAt: doc.joinedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function encodeTeam(doc: Doc<"teams">): unknown {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    archivedAt: doc.archivedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Cloud-project payload shared by import feed writes and bootstrap. */
export function encodeCloudProject(doc: Doc<"cloudProjects">): unknown {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    teamIds: doc.teamIds,
    defaultWorkflowOwner: doc.defaultWorkflowOwner,
    preferredBindingId: doc.preferredBindingId,
    archivedAt: doc.archivedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function encodeTeamMembership(
  ctx: QueryCtx,
  doc: Doc<"teamMemberships">,
): Promise<unknown> {
  const teamId = await requireTeamDomainId(ctx, doc.teamId);
  const membershipId = await requireMembershipDomainId(ctx, doc.membershipId);
  return {
    // Rows written before the id column existed derive theirs from the pair, which is what the
    // column would have held anyway.
    id: doc.id ?? teamMembershipDomainId(teamId, membershipId),
    teamId,
    membershipId,
    createdAt: doc.createdAt,
  };
}

/**
 * `permissions` goes out as the stored strings rather than a filtered list, for the reason the
 * `roles` table stores them open: a switch written by a newer deployment must survive a rollback
 * instead of being erased from the role. Clients drop the ones they do not know
 * (`grantedCompanyPermissions`), and an unknown switch grants nothing on either side.
 */
export function encodeRole(doc: Doc<"roles">): unknown {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    permissions: doc.permissions,
    seeded: doc.seeded,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * `scope` is re-joined into the tagged union `contracts/company` models it as. A `team` row whose
 * `teamId` is null reads as company scope, which is the rule `lib/identity` resolves permissions
 * by — encoding it any other way would let a client and the server disagree about a grant.
 */
export async function encodeRoleAssignment(
  ctx: QueryCtx,
  doc: Doc<"roleAssignments">,
): Promise<unknown> {
  return {
    id: doc.id,
    membershipId: await requireMembershipDomainId(ctx, doc.membershipId),
    roleId: await requireRoleDomainId(ctx, doc.roleId),
    scope:
      doc.scope === "company" || doc.teamId === null
        ? { kind: "company" }
        : { kind: "team", teamId: doc.teamId },
    createdAt: doc.createdAt,
  };
}

/** Public registry shape shared by direct reads, feed changes, and bootstrap snapshots. */
export async function encodeEnvironmentRegistration(
  ctx: QueryCtx,
  doc: Doc<"environmentRegistrations">,
) {
  return {
    id: doc.id,
    environmentId: doc.environmentId,
    publicKeyThumbprint: doc.publicKeyThumbprint,
    descriptor: doc.descriptor,
    relayLinkState: doc.relayLinkState,
    managedEndpointAvailable: doc.managedEndpointAvailable,
    lastSeenAt: doc.lastSeenAt,
    serviceRoleIds: doc.serviceRoleIds,
    teamIds: doc.teamIds,
    state: doc.state,
    registeredByMembershipId:
      doc.registeredByMembershipId === null
        ? null
        : await requireMembershipDomainId(ctx, doc.registeredByMembershipId),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function encodeEnvironmentBinding(
  ctx: QueryCtx,
  doc: Doc<"environmentBindings">,
): Promise<unknown> {
  return {
    id: doc.id,
    cloudProjectId: await requireCloudProjectDomainId(ctx, doc.cloudProjectId),
    environmentId: doc.environmentId,
    localProjectId: doc.localProjectId,
    localWorkspaceRoot: doc.localWorkspaceRoot,
    status: doc.status,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Durable command shape shared by direct command reads, feed changes, and bootstrap snapshots.
 * Terminal rows remain upserts: their outcome is history a replica renders, not a deleted entity.
 */
export async function encodeEnvironmentCommand(
  ctx: QueryCtx,
  doc: Doc<"environmentCommands">,
): Promise<unknown> {
  return {
    id: doc.id,
    targetEnvironmentId: doc.targetEnvironmentId,
    cloudProjectId:
      doc.cloudProjectId === null
        ? null
        : await requireCloudProjectDomainId(ctx, doc.cloudProjectId),
    bindingId: doc.bindingId,
    kind: doc.kind,
    args: doc.args,
    issuedByMembershipId: await requireMembershipDomainId(ctx, doc.issuedByMembershipId),
    onBehalfOfActor: doc.onBehalfOfActor,
    state: doc.state,
    claimedByEnvironmentId: doc.claimedByEnvironmentId,
    claimGeneration: doc.claimGeneration,
    claimExpiresAt: doc.claimExpiresAt,
    expiresAt: doc.expiresAt,
    result: doc.result,
    error: doc.error,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * One authoritative company-domain write, ready to become a feed row.
 *
 * Mirrors `DomainChange` in `sync.ts` minus `departure`: that flag exists for a saved view that
 * turned private, and no company record changes audience without changing state in a way every
 * permitted reader is entitled to see anyway.
 */
export interface CompanyChange {
  /** Company-domain kinds in ordinary mutations; issue kinds are also accepted by import. */
  readonly entityKind: SyncEntityKind;
  readonly entityId: string;
  readonly changeKind: SyncChangeKind;
  /**
   * Defaults to company-wide (`[]`), which is what every company record is: a team-scoped grant
   * must not see one, and `hasRecordPermission` enforces that by requiring a company-scoped grant
   * for an empty list.
   */
  readonly teamIds?: readonly string[];
  /**
   * The row to stamp with the version its feed entry carries, closing the bootstrap seed→drain
   * handoff. `null` for a `tombstone` whose row has been deleted, which has nothing left to stamp.
   */
  readonly versionDocId: Id<CompanyVersionedTable> | null;
  /** The encoded entity for `upsert`; must be `null` for `tombstone`. */
  readonly payload: unknown;
}

export interface AppendCompanyChangesOptions {
  readonly companyId: Id<"companies">;
  /** Who to attribute the rows to, in the shape the feed stores — `actorRecord(actor)`. */
  readonly actor: SyncActor;
  readonly changes: readonly CompanyChange[];
  /**
   * Appends a `company` upsert last, encoded from the company row *after* this call's own patch
   * has landed — including the `updatedAt` it stamps and the row `version` it takes from its own
   * run. A caller encoding it up front would ship the values from before the append, which is the
   * one shape of the payload that was never true. It is also the only change whose owners have to
   * be re-read, and this call already holds the transaction to do it in.
   */
  readonly companyUpsert?: boolean;
  /**
   * Increments `companies.authorizationEpoch` in the same transaction. Required of every change
   * that alters who may see what — membership state, team membership, role definition, role
   * assignment, ownership — because a client that sees a new epoch discards its replica and
   * reseeds, which is the only thing that purges rows it should no longer hold.
   */
  readonly bumpEpoch?: boolean;
}

export interface AppendCompanyChangesResult {
  /** The head this call found; the first row it wrote is `versionFrom + 1`. */
  readonly versionFrom: number;
  /** The head it left behind. Equal to {@link versionFrom} when nothing was appended. */
  readonly versionTo: number;
  /** One version per appended row, in order. */
  readonly versions: readonly number[];
  /** The epoch after any bump — what the caller should hand back to the client. */
  readonly authorizationEpoch: number;
}

/**
 * Appends company-domain changes to the company feed and advances its head.
 *
 * The version run is reserved exactly the way `sync.applyOperations` reserves one: read the head,
 * take a contiguous block one past it, stamp each written row with the version its feed entry
 * carries, and patch the head once at the end. Both writers therefore contend on the same field of
 * the same document, and Convex's OCC is what serializes them — a mutation that loses the race is
 * re-run against the committed head and re-derives its block, so an administration write and a
 * batch of issue operations landing together interleave into one gapless sequence rather than
 * colliding on a version. Nothing here may be called from an action for the same reason: the read
 * of the head and the write of the rows have to be one transaction.
 *
 * @see https://docs.convex.dev/database/advanced/occ
 */
export async function appendCompanyChanges(
  ctx: MutationCtx,
  options: AppendCompanyChangesOptions,
): Promise<AppendCompanyChangesResult> {
  // Read the row rather than trust a `CompanyActor` snapshot: a caller that patched the company
  // earlier in this transaction (a rename, a lifecycle change) must encode what it wrote, and a
  // second append in one transaction must start from the head the first one left.
  const company = await ctx.db.get(options.companyId);
  if (company === null) throw backendError("entity-not-found", "Company is missing.");

  const changes = options.changes;
  const companyUpsert = options.companyUpsert === true;
  const now = Date.now();
  const headBefore = company.syncVersion;
  const assignment = assignVersions(headBefore, changes.length + (companyUpsert ? 1 : 0));

  // One patch for everything the company row owes this call: the new head, the bumped epoch, and —
  // when the run ends in a `company` upsert — that row's own version, which is the last version of
  // the run. Applying it before the payload is encoded is what lets that payload be the row as it
  // will be read, rather than the row as it was a moment ago.
  const companyPatch: {
    syncVersion?: number;
    authorizationEpoch?: number;
    version?: number;
    updatedAt?: number;
  } = {};
  if (assignment.nextHead !== headBefore) companyPatch.syncVersion = assignment.nextHead;
  if (options.bumpEpoch === true) companyPatch.authorizationEpoch = company.authorizationEpoch + 1;
  if (companyUpsert) {
    companyPatch.version = assignment.lastVersion;
    companyPatch.updatedAt = now;
  }
  if (Object.keys(companyPatch).length > 0) {
    await ctx.db.patch(company._id, companyPatch);
  }
  const patched: Doc<"companies"> = { ...company, ...companyPatch };

  const insert = async (change: CompanyChange, version: number, payload: unknown) => {
    if (change.versionDocId !== null) await ctx.db.patch(change.versionDocId, { version });
    await ctx.db.insert("syncChanges", {
      companyId: company._id,
      version,
      entityKind: change.entityKind,
      entityId: change.entityId,
      changeKind: change.changeKind,
      teamIds: [...(change.teamIds ?? [])],
      payload,
      // Company administration is online-only: there is no client operation behind these rows, so
      // there is nothing to receipt and nothing to dedupe against.
      operationId: null,
      actor: options.actor,
      createdAt: now,
      retainUntil: changeRetainUntil(now),
    });
  };

  let cursor = 0;
  for (const change of changes) {
    const version = assignment.versions[cursor];
    if (version === undefined) break;
    await insert(change, version, change.changeKind === "tombstone" ? null : change.payload);
    cursor += 1;
  }

  if (companyUpsert) {
    const version = assignment.versions[cursor];
    if (version !== undefined) {
      await insert(
        {
          entityKind: "company",
          entityId: company.id,
          changeKind: "upsert",
          // The company row is stamped by `companyPatch` above, so the run has already accounted
          // for it; stamping it again here would be a redundant patch of the same value.
          versionDocId: null,
          payload: null,
        },
        version,
        await encodeCompany(ctx, patched),
      );
      cursor += 1;
    }
  }

  return {
    versionFrom: headBefore,
    versionTo: assignment.nextHead,
    versions: assignment.versions,
    authorizationEpoch: patched.authorizationEpoch,
  };
}

/**
 * Bumps the authorization epoch on its own, for a change that alters who may see what without
 * changing any record a replica holds — revoking an environment registration, say.
 *
 * Equivalent to {@link appendCompanyChanges} with no changes and `bumpEpoch`, and spelled
 * separately because that call needs an actor it would never use. Clients learn the new epoch from
 * the `authorizationEpoch` every `sync.listChanges` and `sync.bootstrap` page carries, so a bump
 * reaches them without a feed row.
 */
export async function bumpAuthorizationEpoch(
  ctx: MutationCtx,
  companyId: Id<"companies">,
): Promise<number> {
  const company = await ctx.db.get(companyId);
  if (company === null) throw backendError("entity-not-found", "Company is missing.");
  const authorizationEpoch = company.authorizationEpoch + 1;
  await ctx.db.patch(company._id, { authorizationEpoch });
  return authorizationEpoch;
}
