/**
 * Cloud projects, environment bindings, the company environment registry, and the remote command
 * channel.
 *
 * The split this module encodes: a *cloud project* is a company-owned identity that exists whether
 * or not any machine has a checkout of it, while an *environment binding* is one machine's claim
 * that a particular folder is that project. A project with no binding is still a real project you
 * can file issues against; it just cannot start work. Nothing here is portable between hosts —
 * `localWorkspaceRoot` and `localProjectId` mean something only on the environment that published
 * them, which is exactly why they live on the binding and not on the project.
 *
 * The command channel is layer 2 of cross-machine control: it is the path that works when the two
 * machines can never reach each other directly. Live steering does not come through here.
 * Transcripts and file contents never travel in a command record.
 *
 * @module cloudProject
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  CloudActor,
  CloudTimestamp,
  CompanyId,
  MembershipId,
  RoleId,
  TeamId,
  WorkflowOwner,
} from "./company.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationSessionStatus } from "./orchestration.ts";
import {
  OrchestrationV2LatestVisibleMessageSummaryJson,
  OrchestrationV2ThreadShellJson,
} from "./orchestrationV2.ts";
import { RepositoryIdentity } from "./environment.ts";

const makeCloudProjectEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const CloudProjectId = makeCloudProjectEntityId("CloudProjectId");
export type CloudProjectId = typeof CloudProjectId.Type;
export const EnvironmentBindingId = makeCloudProjectEntityId("EnvironmentBindingId");
export type EnvironmentBindingId = typeof EnvironmentBindingId.Type;
export const EnvironmentRegistrationId = makeCloudProjectEntityId("EnvironmentRegistrationId");
export type EnvironmentRegistrationId = typeof EnvironmentRegistrationId.Type;
export const EnvironmentCommandId = makeCloudProjectEntityId("EnvironmentCommandId");
export type EnvironmentCommandId = typeof EnvironmentCommandId.Type;
export const AgentThreadId = makeCloudProjectEntityId("AgentThreadId");
export type AgentThreadId = typeof AgentThreadId.Type;

export const CLOUD_PROJECT_NAME_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Cloud projects
// ---------------------------------------------------------------------------

export const CloudProject = Schema.Struct({
  id: CloudProjectId,
  companyId: CompanyId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(CLOUD_PROJECT_NAME_MAX_CHARS)),
  description: Schema.String,
  /** Empty means company-wide, matching the issue visibility rule exactly. */
  teamIds: Schema.Array(TeamId),
  /** Which status chain issues filed here start in. Null defers to the company workflow. */
  defaultWorkflowOwner: Schema.NullOr(WorkflowOwner),
  /**
   * Which binding to use when several machines are eligible. Set by the user the first time they
   * are asked to choose, so they are asked once rather than on every start.
   */
  preferredBindingId: Schema.NullOr(EnvironmentBindingId),
  /** Repository chosen by the user when several checkouts disagree. */
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  archivedAt: Schema.NullOr(CloudTimestamp),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
  deletedAt: Schema.NullOr(CloudTimestamp),
});
export type CloudProject = typeof CloudProject.Type;

// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

/**
 * `stale` is a binding whose environment has not checked in; `missing` is one whose folder is gone.
 * They are distinct because only the second needs the user to rebind.
 */
export const EnvironmentBindingStatus = Schema.Literals(["active", "stale", "missing", "revoked"]);
export type EnvironmentBindingStatus = typeof EnvironmentBindingStatus.Type;

/**
 * One machine's claim that a folder is a cloud project. A cloud project may have none of these,
 * one, or several — one per environment that has a checkout.
 */
export const EnvironmentBinding = Schema.Struct({
  id: EnvironmentBindingId,
  companyId: CompanyId,
  cloudProjectId: CloudProjectId,
  environmentId: EnvironmentId,
  /** The environment-local Pathway project record. Meaningless anywhere else. */
  localProjectId: ProjectId,
  localWorkspaceRoot: TrimmedNonEmptyString,
  status: EnvironmentBindingStatus,
  lastSeenAt: Schema.NullOr(CloudTimestamp),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type EnvironmentBinding = typeof EnvironmentBinding.Type;

/**
 * Which binding to start work through.
 *
 * `Ambiguous` is not an error: it is the case where the user must pick, and it carries the
 * candidates so the picker does not have to re-derive them. `None` means the project has no
 * eligible checkout anywhere and the user is prompted to bind one.
 */
export type EnvironmentBindingChoice =
  | { readonly _tag: "None" }
  | { readonly _tag: "Selected"; readonly binding: EnvironmentBinding }
  | { readonly _tag: "Ambiguous"; readonly bindings: ReadonlyArray<EnvironmentBinding> };

/**
 * Applies the start-work rule: one eligible binding is used, the project's preferred binding wins
 * among several, and anything else is the user's choice. A binding is eligible when it is `active`
 * and its environment is currently reachable — starting work requires an *online* binding, so a
 * healthy binding on a sleeping laptop is not a candidate.
 */
export function selectEnvironmentBinding(input: {
  readonly bindings: ReadonlyArray<EnvironmentBinding>;
  readonly onlineEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly preferredBindingId: EnvironmentBindingId | null;
}): EnvironmentBindingChoice {
  const eligible = input.bindings.filter(
    (binding) =>
      binding.status === "active" && input.onlineEnvironmentIds.has(binding.environmentId),
  );
  if (eligible.length === 0) return { _tag: "None" };
  if (eligible.length === 1) return { _tag: "Selected", binding: eligible[0]! };
  const preferred = eligible.find((binding) => binding.id === input.preferredBindingId);
  if (preferred !== undefined) return { _tag: "Selected", binding: preferred };
  return { _tag: "Ambiguous", bindings: eligible };
}

// ---------------------------------------------------------------------------
// Agent thread discovery
// ---------------------------------------------------------------------------

const { latestVisibleMessage: _latestVisibleMessage, ...cloudAgentThreadShellFields } =
  OrchestrationV2ThreadShellJson.fields;

/**
 * The durable thread index replicated through Convex.
 *
 * This deliberately mirrors the ordinary shell while removing message text. The owning
 * environment remains authoritative for the transcript, diffs, files, approvals, and streaming
 * output; a client opens those through that environment's relay connection.
 */
export const CloudAgentThreadShell = Schema.Struct({
  ...cloudAgentThreadShellFields,
  latestVisibleMessage: Schema.NullOr(
    Schema.Struct({
      id: OrchestrationV2LatestVisibleMessageSummaryJson.fields.id,
      role: OrchestrationV2LatestVisibleMessageSummaryJson.fields.role,
      updatedAt: OrchestrationV2LatestVisibleMessageSummaryJson.fields.updatedAt,
    }),
  ),
});
export type CloudAgentThreadShell = typeof CloudAgentThreadShell.Type;

/** One environment-owned thread shell, mapped back to its company project identity. */
export const AgentThread = Schema.Struct({
  id: AgentThreadId,
  companyId: CompanyId,
  environmentId: EnvironmentId,
  cloudProjectId: CloudProjectId,
  shell: CloudAgentThreadShell,
  updatedAt: CloudTimestamp,
});
export type AgentThread = typeof AgentThread.Type;

// ---------------------------------------------------------------------------
// Company environment registry
// ---------------------------------------------------------------------------

/**
 * How the relay currently sees the environment. `degraded` is linked but unhealthy — worth showing
 * in discovery, not worth offering a connect button for without a warning.
 */
export const EnvironmentRelayLinkState = Schema.Literals([
  "unlinked",
  "linked",
  "degraded",
  "revoked",
]);
export type EnvironmentRelayLinkState = typeof EnvironmentRelayLinkState.Type;

export const EnvironmentRegistrationState = Schema.Literals(["active", "revoked"]);
export type EnvironmentRegistrationState = typeof EnvironmentRegistrationState.Type;

/**
 * An environment's membership in one company.
 *
 * One Pathway environment may register with several companies, each with its own service roles and
 * team scope, so authorization hangs off the registration rather than the environment: revoking a
 * registration removes discovery and blocks new connects in that company alone, immediately,
 * without waiting for a token to expire.
 */
export const EnvironmentRegistration = Schema.Struct({
  id: EnvironmentRegistrationId,
  companyId: CompanyId,
  environmentId: EnvironmentId,
  /** Public-key thumbprint the relay binds its `pathway-convex` tokens to. */
  publicKeyThumbprint: TrimmedNonEmptyString,
  /** What discovery renders: label, platform, server version, and capabilities. */
  descriptor: ExecutionEnvironmentDescriptor,
  relayLinkState: EnvironmentRelayLinkState,
  /** Whether the environment currently publishes a managed endpoint clients can reach. */
  managedEndpointAvailable: Schema.Boolean,
  lastSeenAt: Schema.NullOr(CloudTimestamp),
  /** Granted to the environment itself, separate from any member acting through it. */
  serviceRoleIds: Schema.Array(RoleId),
  teamIds: Schema.Array(TeamId),
  state: EnvironmentRegistrationState,
  registeredByMembershipId: Schema.NullOr(MembershipId),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type EnvironmentRegistration = typeof EnvironmentRegistration.Type;

// ---------------------------------------------------------------------------
// Remote dispatch commands
// ---------------------------------------------------------------------------

export const ENVIRONMENT_COMMAND_KINDS = [
  "startThread",
  "sendMessage",
  "interrupt",
  "statusQuery",
] as const;

export const EnvironmentCommandKind = Schema.Literals(ENVIRONMENT_COMMAND_KINDS);
export type EnvironmentCommandKind = typeof EnvironmentCommandKind.Type;

/** Same ceiling as one sync operation's arguments. Files never travel in a command. */
export const ENVIRONMENT_COMMAND_ARGS_MAX_BYTES = 512 * 1024;
/** A claim is held for this long and renewed well inside it; the same lease shape leases use. */
export const ENVIRONMENT_COMMAND_CLAIM_TTL_MS = 90_000;
export const ENVIRONMENT_COMMAND_CLAIM_RENEW_INTERVAL_MS = 30_000;

/**
 * What the target environment is being asked to do. Discriminated by the same `kind` the command
 * record carries, so a record and its arguments can never disagree about which command it is.
 */
export const EnvironmentCommandArgs = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("startThread"),
    prompt: TrimmedNonEmptyString,
    /** Null lets the target pick its own default rather than pinning the issuer's. */
    modelSelection: Schema.NullOr(ModelSelection),
  }),
  Schema.Struct({
    kind: Schema.Literal("sendMessage"),
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("interrupt"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("statusQuery"), threadId: ThreadId }),
]);
export type EnvironmentCommandArgs = typeof EnvironmentCommandArgs.Type;

/**
 * What came back. Deliberately thin: a result is a pointer at environment-owned state, not a copy
 * of it — the issuing client reads the thread over a live connection, never out of a command row.
 */
export const EnvironmentCommandResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("startThread"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("sendMessage"),
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
  }),
  Schema.Struct({ kind: Schema.Literal("interrupt"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("statusQuery"),
    threadId: ThreadId,
    sessionStatus: OrchestrationSessionStatus,
    activeTurnId: Schema.NullOr(TurnId),
  }),
]);
export type EnvironmentCommandResult = typeof EnvironmentCommandResult.Type;

/**
 * Command lifecycle. `expired` is a recorded outcome, never a silent disappearance: a command
 * aimed at a machine that stayed offline past its TTL has to be visibly different from one that was
 * never issued.
 */
export const EnvironmentCommandState = Schema.Literals([
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
export type EnvironmentCommandState = typeof EnvironmentCommandState.Type;

export const EnvironmentCommand = Schema.Struct({
  id: EnvironmentCommandId,
  companyId: CompanyId,
  targetEnvironmentId: EnvironmentId,
  /** Null for commands that are not project-bound, such as a bare status query. */
  cloudProjectId: Schema.NullOr(CloudProjectId),
  bindingId: Schema.NullOr(EnvironmentBindingId),
  kind: EnvironmentCommandKind,
  args: EnvironmentCommandArgs,
  issuedByMembershipId: MembershipId,
  /**
   * Whose permissions the target enforces. The issuing identity's dispatch grant gets the command
   * delivered; this is what decides whether it may run.
   */
  onBehalfOfActor: CloudActor,
  state: EnvironmentCommandState,
  claimedByEnvironmentId: Schema.NullOr(EnvironmentId),
  /** Travels with every side effect, so a stale claimant's writes are refused immediately. */
  claimGeneration: NonNegativeInt,
  claimExpiresAt: Schema.NullOr(CloudTimestamp),
  /** The command's own TTL, independent of any claim. */
  expiresAt: CloudTimestamp,
  result: Schema.NullOr(EnvironmentCommandResult),
  error: Schema.NullOr(Schema.String),
  createdAt: CloudTimestamp,
  updatedAt: CloudTimestamp,
});
export type EnvironmentCommand = typeof EnvironmentCommand.Type;

/** States a command can still be cancelled from: once claimed, the target owns the outcome. */
export function isCancellableEnvironmentCommand(state: EnvironmentCommandState): boolean {
  return state === "pending";
}

/**
 * The orchestration permission a command needs *in addition to* `remoteAgents.dispatch`.
 * Dispatching a "send message" must not be a way around not being allowed to send one.
 */
export function environmentCommandPermission(
  kind: EnvironmentCommandKind,
): "remoteAgents.control" | "environments.read" {
  return kind === "statusQuery" ? "environments.read" : "remoteAgents.control";
}
