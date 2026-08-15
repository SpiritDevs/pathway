/**
 * The company domain on the sync engine: a permission-filtered read cache, and nothing more.
 *
 * Company, membership, team, and role administration is **online-only**. None of it has an
 * operation kind, none of it enters the outbox, and there is no optimistic overlay to reconcile —
 * a client that wants to lock a member or edit a role calls the Convex mutation and waits for the
 * answer. What this module adds is the other half of that bargain: the records still ride the
 * change feed, so a member list, a team picker, and a permission-greyed toolbar all render with no
 * connection.
 *
 * That makes the domain deliberately small. It declares the seven entity shapes the feed delivers
 * and the codecs that decode them, and it stops there:
 *
 * - **No `apply`.** There are no company operations to apply. The adapter in
 *   {@link module:sync/issueDomain} rejects any envelope naming a company kind rather than folding
 *   it into an overlay that could never be sent.
 * - **No merge.** The confirmed row wins outright. `mergeConfirmed` exists for domains keeping
 *   locally derived fields alive across a change; a read cache has none, so the engine's default
 *   replacement is exactly right.
 * - **No invitations.** Pending invitations are query-only (`invitations.list`) — administration
 *   state with a secret behind it, not something a client needs offline — and they have no wire
 *   kind at all.
 *
 * Ownership rides inside the company payload rather than as its own kind, so "who runs this
 * company" is one row that cannot half-arrive. See `contracts/cloudSync` for the payload field
 * lists and the reasoning behind each omission.
 *
 * @module sync/companyDomain
 */
import {
  SyncCompanyPayload,
  SyncCompanySettingsPayload,
  SyncMembershipPayload,
  SyncRoleAssignmentPayload,
  SyncRolePayload,
  SyncTeamMembershipPayload,
  SyncTeamPayload,
  type SyncEntityKind,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { SyncCodec } from "./codec.ts";

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

/**
 * The tables this domain replicates: every company-administration kind in the protocol, which is
 * the complement of {@link module:sync/issueDomain}'s twelve.
 */
export const COMPANY_SYNC_ENTITY_KINDS = [
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
] as const satisfies ReadonlyArray<SyncEntityKind>;
export type CompanySyncEntityKind = (typeof COMPANY_SYNC_ENTITY_KINDS)[number];

const COMPANY_SYNC_ENTITY_KIND_SET: ReadonlySet<string> = new Set<string>(
  COMPANY_SYNC_ENTITY_KINDS,
);

export function isCompanySyncEntityKind(value: string): value is CompanySyncEntityKind {
  return COMPANY_SYNC_ENTITY_KIND_SET.has(value);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// Each shape is the contract's wire payload plus the local `entityKind` tag. The tag is not on the
// wire — the change envelope carries it — so the codecs below attach it on decode and strip it on
// encode, exactly as the issue domain does. Fields, and the four `companyId`/`version`/`deletedAt`/
// derived-column omissions behind them, are documented once in `contracts/cloudSync`.

/** The company record, `companyOwners` embedded; ownership has no wire kind of its own. */
export const CompanyEntity = Schema.Struct({
  entityKind: Schema.Literal("company"),
  ...SyncCompanyPayload.fields,
});
export type CompanyEntity = typeof CompanyEntity.Type;

/** One row per company, so its `id` is the company's own domain id. */
export const CompanySettingsEntity = Schema.Struct({
  entityKind: Schema.Literal("companySettings"),
  ...SyncCompanySettingsPayload.fields,
});
export type CompanySettingsEntity = typeof CompanySettingsEntity.Type;

export const MembershipEntity = Schema.Struct({
  entityKind: Schema.Literal("membership"),
  ...SyncMembershipPayload.fields,
});
export type MembershipEntity = typeof MembershipEntity.Type;

export const TeamEntity = Schema.Struct({
  entityKind: Schema.Literal("team"),
  ...SyncTeamPayload.fields,
});
export type TeamEntity = typeof TeamEntity.Type;

/** A join row; its `id` is the `teamMembershipSyncEntityId` composite. */
export const TeamMembershipEntity = Schema.Struct({
  entityKind: Schema.Literal("teamMembership"),
  ...SyncTeamMembershipPayload.fields,
});
export type TeamMembershipEntity = typeof TeamMembershipEntity.Type;

/** `permissions` is intentionally open; read it through `grantedCompanyPermissions`. */
export const RoleEntity = Schema.Struct({
  entityKind: Schema.Literal("role"),
  ...SyncRolePayload.fields,
});
export type RoleEntity = typeof RoleEntity.Type;

export const RoleAssignmentEntity = Schema.Struct({
  entityKind: Schema.Literal("roleAssignment"),
  ...SyncRoleAssignmentPayload.fields,
});
export type RoleAssignmentEntity = typeof RoleAssignmentEntity.Type;

/** One replicated company-domain row, tagged with the kind that selected its shape. */
export const CompanySyncEntity = Schema.Union([
  CompanyEntity,
  CompanySettingsEntity,
  MembershipEntity,
  TeamEntity,
  TeamMembershipEntity,
  RoleEntity,
  RoleAssignmentEntity,
]);
export type CompanySyncEntity = typeof CompanySyncEntity.Type;

/** The member of {@link CompanySyncEntity} carrying one entity kind. */
export type CompanySyncEntityOf<K extends CompanySyncEntityKind> = Extract<
  CompanySyncEntity,
  { readonly entityKind: K }
>;

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

/**
 * Attaches the local tag on decode and strips it on encode.
 *
 * Mirrors the issue domain's helper rather than sharing one: the two are each closed over their
 * own entity union, and a shared generic would have to be cast back at every call site anyway.
 */
function taggedEntityCodec<A, I>(
  entityKind: CompanySyncEntityKind,
  payload: Schema.Codec<A, I>,
): SyncCodec<CompanySyncEntity> {
  const decode = Schema.decodeUnknownOption(payload);
  const encode = Schema.encodeSync(payload);
  return {
    decode: (input) =>
      Option.map(
        decode(input),
        (value) => ({ entityKind, ...(value as object) }) as CompanySyncEntity,
      ),
    encode: (value) => {
      const { entityKind: _entityKind, ...rest } = value;
      return encode(rest as unknown as A) as unknown;
    },
  };
}

/**
 * Every company codec by kind. Exported as the table rather than only behind
 * {@link companyEntityCodec} so the widened adapter can build its dispatch from a total map instead
 * of a lookup it would have to null-check per kind.
 */
export const COMPANY_ENTITY_CODECS: Record<CompanySyncEntityKind, SyncCodec<CompanySyncEntity>> = {
  company: taggedEntityCodec("company", SyncCompanyPayload),
  companySettings: taggedEntityCodec("companySettings", SyncCompanySettingsPayload),
  membership: taggedEntityCodec("membership", SyncMembershipPayload),
  team: taggedEntityCodec("team", SyncTeamPayload),
  teamMembership: taggedEntityCodec("teamMembership", SyncTeamMembershipPayload),
  role: taggedEntityCodec("role", SyncRolePayload),
  roleAssignment: taggedEntityCodec("roleAssignment", SyncRoleAssignmentPayload),
};

/** Codec for one entity kind, or `null` for a kind this domain does not replicate. */
export function companyEntityCodec(
  entityKind: SyncEntityKind,
): SyncCodec<CompanySyncEntity> | null {
  return isCompanySyncEntityKind(entityKind) ? COMPANY_ENTITY_CODECS[entityKind] : null;
}
