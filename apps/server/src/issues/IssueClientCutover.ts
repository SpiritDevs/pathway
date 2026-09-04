import { ISSUES_WS_METHODS, IssueTrackerError } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

type IssueWsMethod = (typeof ISSUES_WS_METHODS)[keyof typeof ISSUES_WS_METHODS];

export const ISSUE_CLIENT_UPGRADE_REQUIRED_MESSAGE =
  "This workspace has moved to cloud sync. Update the app to continue.";

/**
 * RPCs the replica-aware web client sends through its own sync outbox instead of the environment.
 *
 * The service methods remain available to MCP and server automation: C7 routes those callers to
 * the durable outbox. This list is only the old web/Electron authorization boundary in `ws.ts`.
 */
const CUT_OVER_RPC_METHODS: ReadonlySet<IssueWsMethod> = new Set([
  ISSUES_WS_METHODS.getSnapshot,
  ISSUES_WS_METHODS.getDetail,
  ISSUES_WS_METHODS.create,
  ISSUES_WS_METHODS.delete,
  ISSUES_WS_METHODS.restore,
  ISSUES_WS_METHODS.setSortOrder,
  ISSUES_WS_METHODS.createStatus,
  ISSUES_WS_METHODS.updateStatus,
  ISSUES_WS_METHODS.deleteStatus,
  ISSUES_WS_METHODS.reorderStatuses,
  ISSUES_WS_METHODS.createLabel,
  ISSUES_WS_METHODS.updateLabel,
  ISSUES_WS_METHODS.deleteLabel,
  ISSUES_WS_METHODS.milestoneCreate,
  ISSUES_WS_METHODS.milestoneUpdate,
  ISSUES_WS_METHODS.milestoneDelete,
  ISSUES_WS_METHODS.milestonesReorder,
  ISSUES_WS_METHODS.cycleCreate,
  ISSUES_WS_METHODS.cycleUpdate,
  ISSUES_WS_METHODS.cycleDelete,
  ISSUES_WS_METHODS.todoCreate,
  ISSUES_WS_METHODS.todoUpdate,
  ISSUES_WS_METHODS.todoDelete,
  ISSUES_WS_METHODS.todosReorder,
  ISSUES_WS_METHODS.relationCreate,
  ISSUES_WS_METHODS.relationDelete,
  ISSUES_WS_METHODS.commentUpdate,
  ISSUES_WS_METHODS.commentDelete,
  ISSUES_WS_METHODS.viewCreate,
  ISSUES_WS_METHODS.viewUpdate,
  ISSUES_WS_METHODS.viewDelete,
  ISSUES_WS_METHODS.viewsReorder,
  ISSUES_WS_METHODS.linkThread,
  ISSUES_WS_METHODS.unlinkThread,
  ISSUES_WS_METHODS.triageAccept,
  ISSUES_WS_METHODS.triageReject,
]);

/** Current replica client calls that remain deliberately local until their domains sync. */
const CURRENT_CLIENT_ONLY_RPC_METHODS: ReadonlySet<IssueWsMethod> = new Set([
  ISSUES_WS_METHODS.milestoneHistory,
  ISSUES_WS_METHODS.importCsv,
  ISSUES_WS_METHODS.uploadCommentAttachment,
  ISSUES_WS_METHODS.cancelCommentAgentRun,
  ISSUES_WS_METHODS.retryCommentAgentRun,
  ISSUES_WS_METHODS.startEnrichment,
  ISSUES_WS_METHODS.cancelEnrichment,
  ISSUES_WS_METHODS.getEnrichmentRuns,
]);

function owns(input: unknown, key: string): boolean {
  return typeof input === "object" && input !== null && Object.hasOwn(input, key);
}

function patchOwns(input: unknown, key: string): boolean {
  if (!owns(input, "patch")) return false;
  return owns((input as { readonly patch: unknown }).patch, key);
}

/** True when this decoded request can only have come from the pre-cutover issue UI. */
export function issueRpcRequiresUpgrade(method: string, input: unknown): boolean {
  if (method === ISSUES_WS_METHODS.update || method === ISSUES_WS_METHODS.bulkUpdate) {
    return !patchOwns(input, "automationAssignment");
  }
  if (method === ISSUES_WS_METHODS.commentCreate) {
    return !owns(input, "agentMention");
  }
  return CUT_OVER_RPC_METHODS.has(method as IssueWsMethod);
}

export function issueRpcRequiresCurrentClient(method: string, input: unknown): boolean {
  if (method === ISSUES_WS_METHODS.update || method === ISSUES_WS_METHODS.bulkUpdate) {
    return patchOwns(input, "automationAssignment");
  }
  if (method === ISSUES_WS_METHODS.commentCreate) {
    return owns(input, "agentMention");
  }
  return CURRENT_CLIENT_ONLY_RPC_METHODS.has(method as IssueWsMethod);
}

/**
 * Keep the existing `invalid` reason so clients built before C8 can decode and render the message.
 * Adding a new reason would turn the intended upgrade notice into an RPC schema failure for them.
 */
const upgradeRequired = () =>
  new IssueTrackerError({ reason: "invalid", message: ISSUE_CLIENT_UPGRADE_REQUIRED_MESSAGE });

export function enforceIssueClientCutover<A, E, R, ReplicaR>(input: {
  readonly method: string;
  readonly payload: unknown;
  readonly replicaRoutable: Effect.Effect<boolean, IssueTrackerError, ReplicaR>;
  readonly currentClient: Effect.Effect<boolean>;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | IssueTrackerError, R | ReplicaR> {
  return Effect.flatMap(
    input.replicaRoutable,
    (routable): Effect.Effect<A, E | IssueTrackerError, R> => {
      if (routable && issueRpcRequiresUpgrade(input.method, input.payload)) {
        return Effect.fail(upgradeRequired());
      }
      if (routable && issueRpcRequiresCurrentClient(input.method, input.payload)) {
        return Effect.flatMap(
          input.currentClient,
          (currentClient): Effect.Effect<A, E | IssueTrackerError, R> =>
            currentClient ? input.effect : Effect.fail(upgradeRequired()),
        );
      }
      return input.effect;
    },
  );
}
