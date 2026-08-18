/** Applies one server-authored issue operation and appends its changes in the same transaction. */
import { changeRetainUntil } from "../../src/sync/changeFeed.ts";
import { assignVersions } from "../../src/sync/operations.ts";
import { SYNC_PROTOCOL_VERSION } from "../../src/sync/protocol.ts";
import type { SyncOperationEnvelope } from "../../src/sync/operations.ts";
import type { MutationCtx } from "../_generated/server.js";
import { backendError } from "./errors.ts";
import { syncOperationActorRecord, type EnvironmentActor } from "./identity.ts";
import { ISSUE_DOMAIN_APPLY } from "./issueApply.ts";

export interface DirectIssueOperation {
  readonly operationId: string;
  readonly kind: string;
  readonly entityId: string;
  readonly args: unknown;
  readonly source?: "slack" | "automation" | undefined;
}

export async function applyDirectIssueOperation(
  ctx: MutationCtx,
  actor: EnvironmentActor,
  input: DirectIssueOperation,
): Promise<void> {
  // This function is not a public mutation. Its callers have already proven a live Slack lease or
  // automation claim, so the central claim is the authorization boundary for the system write.
  // Preserve the environment identity for attribution while allowing the domain handlers to apply
  // the exact company/team-scoped operation selected transactionally by Convex.
  const systemActor: EnvironmentActor = {
    ...actor,
    permissions: { ...actor.permissions, isOwner: true },
  };
  const operation: SyncOperationEnvelope = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: input.operationId,
    companyId: actor.company.id,
    clientId: `environment:${actor.registration.environmentId}`,
    environmentId: actor.registration.environmentId,
    actor: { kind: "system", source: input.source ?? "slack" },
    localSequence: 0,
    baseVersion: actor.company.syncVersion,
    kind: input.kind,
    entityId: input.entityId,
    args: input.args,
    dependsOn: [],
  };
  const apply = ISSUE_DOMAIN_APPLY[input.kind as keyof typeof ISSUE_DOMAIN_APPLY];
  if (apply === undefined)
    throw backendError("invalid-arguments", "Unknown direct issue operation.");
  const outcome = await apply(ctx, systemActor, operation);
  if (outcome.status === "rejected") throw backendError(outcome.code, outcome.message);

  const company = await ctx.db.get(actor.company._id);
  if (company === null) throw backendError("entity-not-found", "The company is missing.");
  const assignment = assignVersions(company.syncVersion, outcome.changes.length);
  // @effect-diagnostics-next-line globalDate:off -- Convex transaction clock.
  const now = Date.now();
  const feedActor = syncOperationActorRecord(systemActor, operation.actor, operation.environmentId);
  for (const [index, change] of outcome.changes.entries()) {
    const version = assignment.versions[index];
    if (version === undefined) throw new Error("A direct issue change was not assigned a version.");
    if (change.versionDocId !== null) await ctx.db.patch(change.versionDocId, { version });
    await ctx.db.insert("syncChanges", {
      companyId: company._id,
      version,
      entityKind: change.entityKind,
      entityId: change.entityId,
      changeKind: change.changeKind,
      teamIds: [...change.teamIds],
      ...(change.departure === true ? { departure: true } : {}),
      payload: change.payload,
      operationId: input.operationId,
      actor: feedActor,
      createdAt: now,
      retainUntil: changeRetainUntil(now),
    });
  }
  if (assignment.nextHead !== company.syncVersion) {
    await ctx.db.patch(company._id, { syncVersion: assignment.nextHead });
  }
}
