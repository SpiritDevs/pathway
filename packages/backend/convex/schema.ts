/**
 * Convex schema for the cloud-sync backend.
 *
 * **`packages/contracts` is the source of truth for every shape here.** `company.ts`,
 * `cloudProject.ts`, and `cloudSync.ts` define the entities, actors, literal sets, and wire
 * envelopes; this file is their hand-written Convex mirror. Convex validators are plain `v.*`
 * values built at module load and cannot import Effect Schema, so the duplication is unavoidable —
 * but it is a mirror, not a second opinion. When the two disagree, contracts win and this file is
 * what changes.
 *
 * Where a table deliberately stores something the contract does not describe, the field carries a
 * comment saying why: storage-only splits for indexing, and `v.any()` for shapes Convex validators
 * cannot express are the only two allowed reasons.
 *
 * Two conventions run through every table:
 *
 * - Domain ids are client-generated UUIDv7 strings carried in an `id` field. Convex `_id` values
 *   stay a storage detail so an offline client can build relationships before the server has ever
 *   seen the records.
 * - Everything company-owned carries `companyId` and is indexed by it. There is no cross-company
 *   read path, and the change feed is keyed by `(companyId, version)` so a client drains exactly
 *   one company's ordered history.
 *
 * @module schema
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Client-generated domain id (UUIDv7). Distinct from a Convex `_id`. */
const domainId = v.string();

/**
 * Who performed a write. Mirrors `SyncActor` in `contracts/cloudSync` (and `CloudActor` in
 * `contracts/company`, which is the same union): human attribution references a membership rather
 * than an anonymous user, and memberships are preserved as tombstones so it survives a departure.
 */
const actor = v.union(
  v.object({ kind: v.literal("member"), membershipId: domainId }),
  v.object({
    kind: v.literal("agent"),
    provider: v.string(),
    onBehalfOfMembershipId: v.union(domainId, v.null()),
  }),
  v.object({
    kind: v.literal("system"),
    source: v.union(
      v.literal("import"),
      v.literal("cycles"),
      v.literal("slack"),
      v.literal("automation"),
    ),
  }),
  v.object({ kind: v.literal("environment"), environmentId: v.string() }),
);

/**
 * Who an issue is assigned to. Mirrors `IssueAssignee` in `contracts/issues`, which is what
 * `SyncIssueCreateArgs.assignee` carries: narrower than {@link actor} because assignment records
 * intent, and nobody assigns work to `cycles` or to a server's service identity. The environment-
 * local `{kind: "user"}` variant stays accepted so rows imported from a pre-company tracker are
 * storable without a rewrite.
 */
const issueAssignee = v.union(
  v.object({ kind: v.literal("user") }),
  v.object({ kind: v.literal("member"), membershipId: domainId }),
  v.object({ kind: v.literal("agent"), provider: v.string() }),
);

/**
 * An issue's single workflow owner: the company chain, or exactly one attached team's chain.
 * Mirrors `WorkflowOwner` in `contracts/company` and `IssueWorkflowOwner` in `contracts/cloudSync`.
 */
const workflowOwner = v.union(
  v.object({ kind: v.literal("company") }),
  v.object({ kind: v.literal("team"), teamId: domainId }),
);

/**
 * The discriminator half of `RoleAssignmentScope` in `contracts/company`. The contract models the
 * scope as a tagged union `{kind: "company"} | {kind: "team", teamId}`; the table splits it into
 * this literal plus a nullable `teamId` so both "everything for this membership" and "everything
 * granted through this team" are single index reads. Storage-only: the wire shape stays tagged.
 */
const roleAssignmentScope = v.union(v.literal("company"), v.literal("team"));

const membershipState = v.union(v.literal("active"), v.literal("locked"), v.literal("left"));

const issueStatusCategory = v.union(
  v.literal("backlog"),
  v.literal("unstarted"),
  v.literal("started"),
  v.literal("review"),
  v.literal("completed"),
  v.literal("canceled"),
);

const issuePriority = v.union(
  v.literal("none"),
  v.literal("urgent"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);

const relayActivityPhase = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting_for_approval"),
  v.literal("waiting_for_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stale"),
);

const relayActivityState = v.object({
  environmentId: v.string(),
  threadId: v.string(),
  projectTitle: v.string(),
  threadTitle: v.string(),
  phase: relayActivityPhase,
  headline: v.string(),
  detail: v.optional(v.string()),
  modelTitle: v.string(),
  updatedAt: v.string(),
  deepLink: v.string(),
});

const relayActivityAggregateState = v.object({
  title: v.string(),
  subtitle: v.string(),
  activeCount: v.number(),
  updatedAt: v.string(),
  activities: v.array(
    v.object({
      environmentId: v.string(),
      threadId: v.string(),
      projectTitle: v.string(),
      threadTitle: v.string(),
      modelTitle: v.string(),
      phase: relayActivityPhase,
      status: v.string(),
      updatedAt: v.string(),
      deepLink: v.string(),
    }),
  ),
});

export default defineSchema({
  // ---------------------------------------------------------------------------
  // Identity, companies, and authorization
  // ---------------------------------------------------------------------------

  users: defineTable({
    clerkSubject: v.string(),
    /** Normalized (trimmed, lower-cased) verified email; the key invitations bind to. */
    email: v.string(),
    displayName: v.string(),
    imageUrl: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_subject", ["clerkSubject"])
    .index("by_email", ["email"]),

  companies: defineTable({
    id: domainId,
    name: v.string(),
    issueKeyPrefix: v.string(),
    /** Next issue number to hand out; leases move it forward and never move it back. */
    nextIssueNumber: v.number(),
    lifecycleState: v.union(
      v.literal("active"),
      v.literal("deletionScheduled"),
      v.literal("purged"),
    ),
    deletionScheduledAt: v.union(v.number(), v.null()),
    purgeAfter: v.union(v.number(), v.null()),
    /** Bumped by any authorization change; a client that sees a new epoch reseeds its replica. */
    authorizationEpoch: v.number(),
    /** Head of the company change feed. Every accepted operation advances it contiguously. */
    syncVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * Feed version of the last `company` change, distinct from {@link syncVersion}: that is the
     * head of the whole feed, this is where this one row last moved. Optional because rows written
     * before the company domain joined the feed have none; `lib/companyApply` stamps it on the
     * first write and `?? 0` reads the rest as never-changed.
     */
    version: v.optional(v.number()),
  }).index("by_domain_id", ["id"]),

  companySettings: defineTable({
    companyId: v.id("companies"),
    /**
     * The owning company's domain id. Settings are a singleton per company, so they borrow its
     * identity rather than mint one — the feed still needs an `entityId`, and a second id for a row
     * that can only ever exist once would be a second thing to keep in step. Optional for rows
     * written before the column existed; `lib/companyApply` stamps it on the next write.
     */
    id: v.optional(domainId),
    /**
     * `OfflineAccessDays` from `contracts/company`: `OFFLINE_ACCESS_MIN_DAYS` to
     * `OFFLINE_ACCESS_MAX_DAYS`, which is 0-90. Zero means company data cannot be opened at all
     * without an online authorization check.
     */
    offlineAccessDays: v.number(),
    updatedByMembershipId: v.union(domainId, v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last change touching this row; optional for the reason above. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"]),

  memberships: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    userId: v.id("users"),
    state: membershipState,
    /** Snapshot kept so a removed member still reads as a person in audit history. */
    displayNameSnapshot: v.string(),
    emailSnapshot: v.string(),
    invitedByMembershipId: v.union(domainId, v.null()),
    joinedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last change touching this row; optional for pre-feed rows. */
    version: v.optional(v.number()),
  })
    .index("by_domain_id", ["id"])
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_user", ["companyId", "userId"])
    .index("by_company_and_state", ["companyId", "state"])
    .index("by_user", ["userId"]),

  /**
   * Ownership is a relation, not a role: it is never editable, always passes authorization, and is
   * protected transactionally so the last one cannot be removed.
   */
  companyOwners: defineTable({
    companyId: v.id("companies"),
    membershipId: v.id("memberships"),
    grantedByMembershipId: v.union(domainId, v.null()),
    createdAt: v.number(),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_membership", ["companyId", "membershipId"])
    .index("by_membership", ["membershipId"]),

  teams: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    name: v.string(),
    description: v.string(),
    archivedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last change touching this row; optional for pre-feed rows. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"]),

  teamMemberships: defineTable({
    companyId: v.id("companies"),
    /**
     * Domain id for the join row itself, so it can be a change-feed entity like every other kind.
     * The composite `${teamId}:${membershipId}` (`teamMembershipDomainId` in `lib/companyApply`,
     * matching `teamMembershipSyncEntityId` in `contracts/cloudSync`) rather than a minted id, so a
     * removal tombstone names the id its upsert used and re-adding a member converges on the same
     * entity. Optional for rows written before the column existed; stamped on the next write.
     */
    id: v.optional(domainId),
    teamId: v.id("teams"),
    membershipId: v.id("memberships"),
    createdAt: v.number(),
    /** Feed version of the last change touching this row; optional for pre-feed rows. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_team", ["teamId"])
    .index("by_membership", ["membershipId"])
    .index("by_team_and_membership", ["teamId", "membershipId"]),

  roles: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    name: v.string(),
    description: v.string(),
    /**
     * `CompanyPermission` values — the `COMPANY_PERMISSIONS` list in `contracts/company`, mirrored
     * by `src/permissions.ts`. Allow-only; there is no deny switch anywhere in the model. Stored as
     * strings so a role written by a newer deployment survives a rollback instead of failing the
     * table validator; `isPermissionKey` filters unknown entries at resolution.
     */
    permissions: v.array(v.string()),
    /** Seeded Admin/Manager/Member start true and stay editable; the flag is provenance only. */
    seeded: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last change touching this row; optional for pre-feed rows. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"]),

  /**
   * `scope` is split into a discriminator plus a nullable team so both "everything for this
   * membership" and "everything granted through this team" are single index reads.
   */
  roleAssignments: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    membershipId: v.id("memberships"),
    roleId: v.id("roles"),
    scope: roleAssignmentScope,
    /**
     * Domain id rather than a Convex `_id`: team scoping is compared against the `teamIds` an
     * issue, project, or view carries, and those are domain ids by construction.
     */
    teamId: v.union(domainId, v.null()),
    createdAt: v.number(),
    /** Feed version of the last change touching this row; optional for pre-feed rows. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_membership", ["membershipId"])
    .index("by_membership_and_scope", ["membershipId", "scope"])
    .index("by_role", ["roleId"])
    .index("by_team", ["teamId"]),

  companyInvitations: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    /** Normalized email the accepting Clerk identity must match, verified. */
    email: v.string(),
    /** SHA-256 of the emailed token. The plaintext never reaches the database. */
    tokenHash: v.string(),
    expiresAt: v.number(),
    teamIds: v.array(domainId),
    roleIds: v.array(domainId),
    invitedByMembershipId: v.id("memberships"),
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    /** Increments per deliberate resend and forms the Resend idempotency key. */
    deliveryAttempt: v.number(),
    lastDeliveryAt: v.union(v.number(), v.null()),
    lastDeliveryError: v.union(v.string(), v.null()),
    acceptedAt: v.union(v.number(), v.null()),
    acceptedMembershipId: v.union(v.id("memberships"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_company", ["companyId"])
    .index("by_company_and_email", ["companyId", "email"])
    .index("by_company_and_state", ["companyId", "state"])
    .index("by_state_and_expiry", ["state", "expiresAt"]),

  // ---------------------------------------------------------------------------
  // Cloud projects and environments
  // ---------------------------------------------------------------------------

  cloudProjects: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    name: v.string(),
    description: v.string(),
    /** Empty means company-wide, matching the issue visibility rule. */
    teamIds: v.array(domainId),
    defaultWorkflowOwner: v.union(workflowOwner, v.null()),
    preferredBindingId: v.union(domainId, v.null()),
    archivedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"]),

  /**
   * One Pathway environment may register with several companies, each with its own service roles
   * and team scope, so the registration — not the environment — carries authorization.
   */
  environmentRegistrations: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    environmentId: v.string(),
    /** Public-key thumbprint the relay binds its `pathway-convex` tokens to. */
    publicKeyThumbprint: v.string(),
    /** `ExecutionEnvironmentDescriptor` from `contracts/environment`. */
    descriptor: v.any(),
    relayLinkState: v.union(
      v.literal("unlinked"),
      v.literal("linked"),
      v.literal("degraded"),
      v.literal("revoked"),
    ),
    managedEndpointAvailable: v.boolean(),
    lastSeenAt: v.union(v.number(), v.null()),
    /** Service roles granted to the environment itself, separate from any acting member. */
    serviceRoleIds: v.array(domainId),
    teamIds: v.array(domainId),
    state: v.union(v.literal("active"), v.literal("revoked")),
    registeredByMembershipId: v.union(v.id("memberships"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last published registry change; heartbeats do not advance it. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_environment", ["companyId", "environmentId"])
    .index("by_company_and_state", ["companyId", "state"])
    .index("by_environment", ["environmentId"]),

  /**
   * Transient, single-use authorization for one relay connection. These rows deliberately stay
   * outside the company sync feed: replicas need the durable registration and membership state,
   * never bearer-token material or an append-only history of connect attempts.
   */
  connectGrants: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    environmentId: v.string(),
    /** Live revocation link: validation requires this exact registration to remain active. */
    targetRegistrationId: v.id("environmentRegistrations"),
    /** Live revocation link: validation resolves this exact membership's current permissions. */
    grantedMembershipId: v.id("memberships"),
    /** Storage stays open to future permission switches; issuance accepts only known switches. */
    permission: v.string(),
    /** SHA-256 of the opaque token returned once by `connectGrants.issue`. */
    tokenHash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.union(v.number(), v.null()),
    consumer: v.union(v.string(), v.null()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"]),

  /** Environment-local binding of a cloud project to a real folder. Never portable between hosts. */
  environmentBindings: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    cloudProjectId: v.id("cloudProjects"),
    environmentId: v.string(),
    localProjectId: v.string(),
    localWorkspaceRoot: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("stale"),
      v.literal("missing"),
      v.literal("revoked"),
    ),
    lastSeenAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last change touching this row. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_project", ["companyId", "cloudProjectId"])
    .index("by_company_and_environment", ["companyId", "environmentId"])
    .index("by_environment", ["environmentId"]),

  /**
   * Remote dispatch (layer 2). A command survives the target being offline, is claimed exactly
   * once, and records its expiry rather than disappearing.
   */
  environmentCommands: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    targetEnvironmentId: v.string(),
    cloudProjectId: v.union(v.id("cloudProjects"), v.null()),
    bindingId: v.union(domainId, v.null()),
    kind: v.union(
      v.literal("startThread"),
      v.literal("sendMessage"),
      v.literal("interrupt"),
      v.literal("statusQuery"),
    ),
    /**
     * `EnvironmentCommandArgs` from `contracts/cloudProject`, discriminated by the same `kind` the
     * row carries. Bounded like an operation payload: transcripts and file contents never ride here.
     */
    args: v.any(),
    issuedByMembershipId: v.id("memberships"),
    onBehalfOfActor: actor,
    state: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("expired"),
    ),
    claimedByEnvironmentId: v.union(v.string(), v.null()),
    /** Included with every side effect so a stale claimant's writes are rejected immediately. */
    claimGeneration: v.number(),
    claimExpiresAt: v.union(v.number(), v.null()),
    expiresAt: v.number(),
    /** `EnvironmentCommandResult` from `contracts/cloudProject`; a pointer at environment-owned
     * state, never a copy of it. */
    result: v.union(v.any(), v.null()),
    error: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Feed version of the last lifecycle transition; pure lease renewals do not advance it. */
    version: v.optional(v.number()),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_target_and_state", ["targetEnvironmentId", "state"])
    .index("by_company_and_state", ["companyId", "state"])
    .index("by_state_and_expiry", ["state", "expiresAt"]),

  // ---------------------------------------------------------------------------
  // Relay control-plane persistence
  // ---------------------------------------------------------------------------

  relayMobileDevices: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    label: v.string(),
    platform: v.literal("ios"),
    iosMajorVersion: v.number(),
    appVersion: v.union(v.string(), v.null()),
    bundleId: v.union(v.string(), v.null()),
    apsEnvironment: v.union(v.literal("sandbox"), v.literal("production"), v.null()),
    pushToken: v.union(v.string(), v.null()),
    pushToStartToken: v.union(v.string(), v.null()),
    preferences: v.object({
      liveActivitiesEnabled: v.boolean(),
      notificationsEnabled: v.boolean(),
      notifyOnApproval: v.boolean(),
      notifyOnInput: v.boolean(),
      notifyOnCompletion: v.boolean(),
      notifyOnFailure: v.boolean(),
    }),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_user_and_device", ["userId", "deviceId"])
    .index("by_user", ["userId"])
    .index("by_push_token", ["pushToken"])
    .index("by_push_to_start_token", ["pushToStartToken"]),

  relayLiveActivities: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    activityPushToken: v.union(v.string(), v.null()),
    remoteStartQueuedAt: v.union(v.string(), v.null()),
    remoteStartedAt: v.union(v.string(), v.null()),
    endedAt: v.union(v.string(), v.null()),
    lastAggregate: v.union(relayActivityAggregateState, v.null()),
    lastLiveActivityDeliveryAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_user_and_device", ["userId", "deviceId"])
    .index("by_user", ["userId"])
    .index("by_activity_push_token", ["activityPushToken"]),

  relayEnvironmentLinks: defineTable({
    userId: v.string(),
    environmentId: v.string(),
    environmentLabel: v.string(),
    environmentPublicKey: v.string(),
    endpointHttpBaseUrl: v.string(),
    endpointWsBaseUrl: v.string(),
    endpointProviderKind: v.string(),
    notificationsEnabled: v.boolean(),
    liveActivitiesEnabled: v.boolean(),
    managedTunnelsEnabled: v.boolean(),
    createdByDeviceId: v.union(v.string(), v.null()),
    revokedAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_user_and_environment", ["userId", "environmentId"])
    .index("by_user", ["userId"])
    .index("by_environment", ["environmentId"])
    .index("by_environment_and_key", ["environmentId", "environmentPublicKey"])
    .index("by_environment_key_and_revoked", [
      "environmentId",
      "environmentPublicKey",
      "revokedAt",
    ]),

  relayManagedEndpointAllocations: defineTable({
    userId: v.string(),
    environmentId: v.string(),
    hostname: v.string(),
    tunnelId: v.union(v.string(), v.null()),
    tunnelName: v.string(),
    dnsRecordId: v.union(v.string(), v.null()),
    readyAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_user_and_environment", ["userId", "environmentId"])
    .index("by_user", ["userId"])
    .index("by_hostname", ["hostname"])
    .index("by_tunnel_name", ["tunnelName"]),

  relayManagedTunnelLimits: defineTable({
    userId: v.string(),
    maxTunnels: v.number(),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_user", ["userId"]),

  relayEnvironmentCredentials: defineTable({
    credentialId: v.string(),
    environmentId: v.string(),
    environmentPublicKey: v.string(),
    credentialHash: v.string(),
    revokedAt: v.union(v.string(), v.null()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_credential_id", ["credentialId"])
    .index("by_credential_hash", ["credentialHash"])
    .index("by_environment", ["environmentId"])
    .index("by_environment_and_key", ["environmentId", "environmentPublicKey"])
    .index("by_environment_key_and_revoked", [
      "environmentId",
      "environmentPublicKey",
      "revokedAt",
    ]),

  relayAgentActivityRows: defineTable({
    environmentId: v.string(),
    environmentPublicKey: v.string(),
    threadId: v.string(),
    state: relayActivityState,
    phase: relayActivityPhase,
    updatedAt: v.string(),
    createdAt: v.string(),
  })
    .index("by_environment_key_and_thread", ["environmentId", "environmentPublicKey", "threadId"])
    .index("by_environment_and_thread", ["environmentId", "threadId"])
    .index("by_updated_at", ["updatedAt"])
    .index("by_phase_and_updated_at", ["phase", "updatedAt"]),

  relayDeliveryAttempts: defineTable({
    id: v.string(),
    createdAt: v.string(),
    userId: v.union(v.string(), v.null()),
    environmentId: v.union(v.string(), v.null()),
    threadId: v.union(v.string(), v.null()),
    deviceId: v.union(v.string(), v.null()),
    kind: v.string(),
    sourceJobId: v.union(v.string(), v.null()),
    tokenSuffix: v.union(v.string(), v.null()),
    apnsStatus: v.union(v.number(), v.null()),
    apnsReason: v.union(v.string(), v.null()),
    apnsId: v.union(v.string(), v.null()),
    transportError: v.union(v.string(), v.null()),
  })
    .index("by_attempt_id", ["id"])
    .index("by_source_job", ["sourceJobId"])
    .index("by_environment_thread_created", ["environmentId", "threadId", "createdAt"]),

  relayDpopProofs: defineTable({
    thumbprint: v.string(),
    jti: v.string(),
    iat: v.number(),
    expiresAt: v.string(),
    createdAt: v.string(),
  })
    .index("by_thumbprint_and_jti", ["thumbprint", "jti"])
    .index("by_expires_at", ["expiresAt"]),

  // ---------------------------------------------------------------------------
  // Sync feed
  // ---------------------------------------------------------------------------

  /**
   * The ordered company history clients drain — one row per `SyncChangeEnvelope` in
   * `contracts/cloudSync`, plus the storage-only `teamIds`, `actor`, and retention columns the wire
   * shape has no business carrying. Each row is a whole entity or a tombstone, never a field patch:
   * a client applies a change without knowing what it replaced.
   */
  syncChanges: defineTable({
    companyId: v.id("companies"),
    version: v.number(),
    /**
     * A `SYNC_ENTITY_KINDS` member. Left open rather than a 23-way literal union so a row written
     * by a newer deployment is still readable after a rollback; the closed set lives in
     * `src/sync/protocol.ts`, and a client that does not know a kind drops the row.
     */
    entityKind: v.string(),
    entityId: domainId,
    changeKind: v.union(v.literal("upsert"), v.literal("tombstone")),
    /** Empty means company-wide; otherwise any listed team grants the whole payload. */
    teamIds: v.array(domainId),
    /**
     * Set on a row whose only job is to tell an audience the entity just *left* it — today, a saved
     * view that turned private. Such a row is filtered on `teamIds` alone; the owner-private gate
     * that governs every other row of the same entity would withhold exactly the replicas that need
     * it. Absent (the default) means the ordinary gate applies.
     */
    departure: v.optional(v.boolean()),
    /** The encoded entity for `upsert`, `null` for `tombstone`; the schema is chosen by `entityKind`. */
    payload: v.any(),
    operationId: v.union(v.string(), v.null()),
    actor,
    createdAt: v.number(),
    /** 90-day retention; a cursor older than the surviving feed forces a full bootstrap. */
    retainUntil: v.number(),
  })
    .index("by_company_and_version", ["companyId", "version"])
    .index("by_company_and_entity", ["companyId", "entityKind", "entityId"])
    .index("by_retain_until", ["retainUntil"]),

  /**
   * The permanent dedupe ledger: one compact row per decided operation id, kept for the life of the
   * company.
   *
   * {@link syncOperationReceipts} carries the same decision with the detail a client's sync panel
   * needs — who sent it, from which client and sequence, and the rejection message — and expires at
   * the 90-day retention line with the change feed. That expiry cannot be allowed to reopen the
   * dedupe question: a durable outbox survives a bootstrap, and an accepted operation whose response
   * was lost can be resent long after its receipt is gone. Treating it as fresh then would re-apply
   * an old title over newer state and append a second audit event, or turn an accepted create into a
   * false `entity-exists` rejection.
   *
   * So this table stores only what a resend has to be answered with — the terminal status, the
   * version range an acceptance covered, and the rejection code — and no retention column at all.
   * Any prune job added for the feed must skip it. A row is ~100 bytes against Convex's 1 MiB
   * document ceiling, and the single index is the only read path.
   */
  syncOperationDecisions: defineTable({
    companyId: v.id("companies"),
    operationId: v.string(),
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    /** The run of company versions the acceptance wrote; both null for a rejection. */
    firstVersion: v.union(v.number(), v.null()),
    lastVersion: v.union(v.number(), v.null()),
    /**
     * A `SYNC_REJECTION_CODES` member, left open for the reason `syncChanges.entityKind` is. The
     * message is deliberately not stored — it is the unbounded half, and a resend answered from
     * this ledger falls back to a generic one.
     */
    rejectionCode: v.union(v.string(), v.null()),
    decidedAt: v.number(),
  }).index("by_company_and_operation", ["companyId", "operationId"]),

  /** Dedupe ledger. An operation id present here has already been applied, whatever the retry. */
  syncOperationReceipts: defineTable({
    companyId: v.id("companies"),
    operationId: v.string(),
    clientId: v.string(),
    localSequence: v.number(),
    actor,
    /**
     * Only the two terminal outcomes. `duplicate` is a `SyncOperationReceipt` status, not a stored
     * one: it is what replaying this row produces on a resend, so storing it would mean a receipt
     * that says a resend happened before one has.
     */
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    firstVersion: v.union(v.number(), v.null()),
    lastVersion: v.union(v.number(), v.null()),
    /** A `SYNC_REJECTION_CODES` member, left open for the reason `syncChanges.entityKind` is. */
    rejectionCode: v.union(v.string(), v.null()),
    rejectionMessage: v.union(v.string(), v.null()),
    createdAt: v.number(),
    retainUntil: v.number(),
  })
    .index("by_company_and_operation", ["companyId", "operationId"])
    .index("by_company_and_client", ["companyId", "clientId", "localSequence"])
    .index("by_retain_until", ["retainUntil"]),

  /** Leased key blocks. Kept so an exhausted or crashed client can be reconciled, never recycled. */
  issueKeyReservations: defineTable({
    companyId: v.id("companies"),
    clientId: v.string(),
    membershipId: v.union(v.id("memberships"), v.null()),
    environmentId: v.union(v.string(), v.null()),
    blockStart: v.number(),
    blockEnd: v.number(),
    createdAt: v.number(),
  })
    .index("by_company", ["companyId"])
    .index("by_company_and_client", ["companyId", "clientId"]),

  // ---------------------------------------------------------------------------
  // Issue domain
  // ---------------------------------------------------------------------------

  issues: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    key: v.string(),
    keyNumber: v.number(),
    title: v.string(),
    description: v.string(),
    statusId: domainId,
    priority: issuePriority,
    assignee: v.union(issueAssignee, v.null()),
    projectId: v.union(domainId, v.null()),
    milestoneId: v.union(domainId, v.null()),
    cycleId: v.union(domainId, v.null()),
    parentId: v.union(domainId, v.null()),
    /** Fractional order key with id tie-breaking, so offline reorders converge. */
    sortOrder: v.string(),
    labelIds: v.array(domainId),
    dueDate: v.union(v.string(), v.null()),
    triage: v.boolean(),
    /** `IssueSlackSource` from `contracts/issues`; a struct `v.*` cannot express. */
    slackSource: v.union(v.any(), v.null()),
    /** Empty means company-wide; any listed team exposes the complete issue. */
    teamIds: v.array(domainId),
    /** Exactly one, regardless of how many teams can see the issue. */
    workflowOwner,
    /** `ModelSelection` from `contracts/modelSelection`. */
    workModelSelection: v.union(v.any(), v.null()),
    /** `IssueAutomationAssignment` from `contracts/issues`. */
    automationAssignment: v.union(v.any(), v.null()),
    /**
     * `IssuePullRequest` from `contracts/issues`; a struct `v.*` cannot express (`PositiveInt`).
     *
     * Optional rather than required because this column arrived after the first issue rows did: a
     * deployment carrying phase-1 issues would fail schema validation on rollout the moment the
     * field became mandatory, and a table validator is checked against every existing row, not just
     * the ones a migration has reached. Readers normalize the absent field to `null`
     * ({@link module:lib/issueApply.encodeIssue}); once a bounded backfill has written `null`
     * everywhere, the `v.optional` wrapper can come off.
     */
    pullRequest: v.optional(v.union(v.any(), v.null())),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    /** Feed version of the last change touching this row; drives bootstrap consistency. */
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_key", ["companyId", "key"])
    .index("by_company_and_status", ["companyId", "statusId"])
    .index("by_company_and_project", ["companyId", "projectId"])
    /**
     * The sweeps: every live issue a status deletion or a milestone move has to migrate. `deletedAt`
     * is the last index field so the range covers live rows only — a company that has tombstoned a
     * decade of issues must not spend its transaction budget skipping them.
     */
    .index("by_company_status_and_deleted", ["companyId", "statusId", "deletedAt"])
    .index("by_company_milestone_and_deleted", ["companyId", "milestoneId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * One table for company base statuses, team overrides of them, and team-only statuses.
   * `baseStatusId` is what makes an untouched company edit keep flowing into a team's workflow.
   */
  issueStatuses: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    scope: v.union(v.literal("company"), v.literal("team")),
    teamId: v.union(domainId, v.null()),
    baseStatusId: v.union(domainId, v.null()),
    name: v.union(v.string(), v.null()),
    color: v.union(v.string(), v.null()),
    category: v.union(issueStatusCategory, v.null()),
    position: v.union(v.number(), v.null()),
    hidden: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_scope", ["companyId", "scope"])
    .index("by_company_and_team", ["companyId", "teamId"])
    .index("by_company_and_base_status", ["companyId", "baseStatusId"])
    /**
     * Resolving one effective workflow reads its whole chain, so the chain reads are the ones that
     * have to stay bounded: `deletedAt` last keeps a tombstoned column out of the range instead of
     * out of a post-read filter, and the reader takes one row past its ceiling to notice an
     * oversized workflow rather than silently truncating it.
     */
    .index("by_company_scope_and_deleted", ["companyId", "scope", "deletedAt"])
    .index("by_company_team_and_deleted", ["companyId", "teamId", "deletedAt"])
    /** Live overrides of one base: the delete sweep, and the one-override-per-(team, base) rule. */
    .index("by_company_base_and_deleted", ["companyId", "baseStatusId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  issueLabels: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    /** Null is a company label; a team label is usable by any issue attached to that team. */
    teamId: v.union(domainId, v.null()),
    name: v.string(),
    color: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_team", ["companyId", "teamId"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * Project-owned, unlike labels and cycles. Mirrors `IssueMilestone` in `contracts/issues`, whose
   * status is derived from the dates and the issue tally rather than stored: a milestone that went
   * overdue overnight would still read "in progress" from a stored copy.
   */
  issueMilestones: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    cloudProjectId: domainId,
    name: v.string(),
    /** Null rather than empty, so "cleared" is a state a patch can set. */
    description: v.union(v.string(), v.null()),
    /** `YYYY-MM-DD`. Null keeps a milestone a point on the timeline rather than a bar. */
    startDate: v.union(v.string(), v.null()),
    targetDate: v.union(v.string(), v.null()),
    position: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_project", ["companyId", "cloudProjectId"])
    /** Appending to a project's timeline reads one row — the last position — instead of them all. */
    .index("by_company_project_and_position", ["companyId", "cloudProjectId", "position"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * Mirrors `IssueCycle` in `contracts/issues`. Only the dates are stored: upcoming/active/ended is
   * a function of today, so a stored copy would be stale the moment the deployment went idle.
   */
  issueCycles: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    teamId: v.union(domainId, v.null()),
    name: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    /**
     * Set once the cycle has been finalised — unfinished issues carried forward, completed set
     * frozen. Finalisation is lazy, on read, so an ended cycle sits un-finalised until somebody
     * looks at the tracker again.
     */
    completedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_team", ["companyId", "teamId"])
    .index("by_company_and_version", ["companyId", "version"]),

  issueTodos: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    text: v.string(),
    done: v.boolean(),
    sortOrder: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId"])
    /** Appending to a checklist reads its last order key; the scope migration reads its live rows. */
    .index("by_company_issue_and_sort_order", ["companyId", "issueId", "sortOrder"])
    .index("by_company_issue_and_deleted", ["companyId", "issueId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * The canonical directed pair, named as `IssueRelation` in `contracts/issues` names it. `blocks`
   * is directed and `relates`/`duplicate` are symmetric, but all three store exactly one row:
   * "blocked by" is this row read from the other end, so the inverse is never materialised.
   */
  issueRelations: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    relatedIssueId: domainId,
    kind: v.union(v.literal("blocks"), v.literal("relates"), v.literal("duplicate")),
    createdAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId"])
    .index("by_company_and_related_issue", ["companyId", "relatedIssueId"])
    /** The duplicate check is one read of one live row, not a scan of an issue's whole edge list. */
    .index("by_company_pair_kind_and_deleted", [
      "companyId",
      "issueId",
      "relatedIssueId",
      "kind",
      "deletedAt",
    ])
    /** Both ends, live only: a relation is visible from either, so a scope change reaches both. */
    .index("by_company_issue_and_deleted", ["companyId", "issueId", "deletedAt"])
    .index("by_company_related_issue_and_deleted", ["companyId", "relatedIssueId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  issueComments: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    body: v.string(),
    author: actor,
    attachmentIds: v.array(domainId),
    /** `IssueCommentMention` from `contracts/issues`, pinned at submit so a later settings change
     * never relabels a finished run. */
    mentions: v.array(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId"])
    /** Live rows of one issue, for the scope migration a team change performs. */
    .index("by_company_issue_and_deleted", ["companyId", "issueId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  /** Metadata only. Bytes live in Convex file storage and never travel in operation arguments. */
  issueAttachments: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    commentId: v.union(domainId, v.null()),
    storageId: v.union(v.id("_storage"), v.null()),
    fileName: v.string(),
    mimeType: v.string(),
    byteSize: v.number(),
    checksum: v.string(),
    uploadedByMembershipId: v.union(v.id("memberships"), v.null()),
    /** `pending` uploads with no comment are garbage-collected. */
    state: v.union(v.literal("pending"), v.literal("finalized")),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId"])
    .index("by_company_and_state", ["companyId", "state"])
    /** Live rows of one issue, for the scope migration a team change performs. */
    .index("by_company_issue_and_deleted", ["companyId", "issueId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  issueViews: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    ownerMembershipId: v.id("memberships"),
    visibility: v.union(v.literal("private"), v.literal("teams"), v.literal("company")),
    teamIds: v.array(domainId),
    name: v.string(),
    /**
     * `IssueViewConfig` from `contracts/issues`. A saved chip bar is a dozen optional arrays with
     * per-array length checks, which `v.*` cannot express; the operation handler decodes it against
     * the contract before writing, so this stays the storage shape only.
     */
    config: v.any(),
    position: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_owner", ["companyId", "ownerMembershipId"])
    .index("by_company_and_visibility", ["companyId", "visibility"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * Retained until company deletion, unlike the 90-day change feed. `issueAuditEvent` is a
   * `SYNC_ENTITY_KINDS` member, but `contracts/cloudSync` does not yet define the cloud entity
   * behind it — the closest contract is `IssueEvent` in `contracts/issues`, which is the
   * environment-local tracker's log. Phase 4 pins the shape; until then the payload stays open.
   */
  issueAuditEvents: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    /** An `IssueEventKind` value. */
    kind: v.string(),
    actor,
    /** Includes before/after values, which is how a stale-base overwrite stays recoverable. */
    payload: v.any(),
    operationId: v.union(v.string(), v.null()),
    createdAt: v.number(),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId", "createdAt"])
    .index("by_company_and_version", ["companyId", "version"]),

  /**
   * The link is cloud-owned; the thread itself stays environment-owned, so both ids are stored and
   * neither pretends the thread is portable.
   */
  issueThreadLinks: defineTable({
    id: domainId,
    companyId: v.id("companies"),
    issueId: domainId,
    environmentId: v.string(),
    threadId: v.string(),
    origin: v.union(v.literal("start-work"), v.literal("manual"), v.literal("mention")),
    createdByMembershipId: v.union(v.id("memberships"), v.null()),
    createdAt: v.number(),
    deletedAt: v.union(v.number(), v.null()),
    version: v.number(),
  })
    .index("by_company_and_domain_id", ["companyId", "id"])
    .index("by_company_and_issue", ["companyId", "issueId"])
    .index("by_company_and_thread", ["companyId", "environmentId", "threadId"])
    /** One live row per (thread, issue): the duplicate check, without reading the thread's links. */
    .index("by_company_thread_issue_and_deleted", [
      "companyId",
      "environmentId",
      "threadId",
      "issueId",
      "deletedAt",
    ])
    /** Live rows of one issue, for the scope migration a team change performs. */
    .index("by_company_issue_and_deleted", ["companyId", "issueId", "deletedAt"])
    .index("by_company_and_version", ["companyId", "version"]),
});
