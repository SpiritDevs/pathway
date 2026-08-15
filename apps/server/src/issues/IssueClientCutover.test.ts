import { ISSUES_WS_METHODS } from "@spiritdevs/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  enforceIssueClientCutover,
  ISSUE_CLIENT_UPGRADE_REQUIRED_MESSAGE,
  issueRpcRequiresCurrentClient,
  issueRpcRequiresUpgrade,
} from "./IssueClientCutover.ts";

const CUT_OVER_MUTATIONS = [
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
] as const;

const LEGACY_MUTATIONS = [
  ISSUES_WS_METHODS.setKeyPrefix,
  ISSUES_WS_METHODS.importCsv,
  ISSUES_WS_METHODS.uploadCommentAttachment,
  ISSUES_WS_METHODS.cancelCommentAgentRun,
  ISSUES_WS_METHODS.retryCommentAgentRun,
  ISSUES_WS_METHODS.startEnrichment,
  ISSUES_WS_METHODS.cancelEnrichment,
  ISSUES_WS_METHODS.slackSetToken,
  ISSUES_WS_METHODS.slackWatchCreate,
  ISSUES_WS_METHODS.slackWatchUpdate,
  ISSUES_WS_METHODS.slackWatchDelete,
] as const;

describe("IssueClientCutover", () => {
  it("classifies every cut-over and deliberately legacy mutation", () => {
    assert.isTrue(issueRpcRequiresUpgrade(ISSUES_WS_METHODS.getSnapshot, {}));
    assert.isTrue(issueRpcRequiresUpgrade(ISSUES_WS_METHODS.getDetail, {}));
    for (const method of CUT_OVER_MUTATIONS) {
      assert.isTrue(issueRpcRequiresUpgrade(method, {}), method);
    }
    for (const method of LEGACY_MUTATIONS) {
      assert.isFalse(issueRpcRequiresUpgrade(method, {}), method);
    }

    assert.isTrue(issueRpcRequiresUpgrade(ISSUES_WS_METHODS.update, { patch: { title: "old" } }));
    assert.isFalse(
      issueRpcRequiresUpgrade(ISSUES_WS_METHODS.update, {
        patch: { automationAssignment: null },
      }),
    );
    assert.isTrue(
      issueRpcRequiresCurrentClient(ISSUES_WS_METHODS.update, {
        patch: { automationAssignment: null },
      }),
    );
    assert.isTrue(
      issueRpcRequiresUpgrade(ISSUES_WS_METHODS.bulkUpdate, { patch: { priority: "high" } }),
    );
    assert.isFalse(
      issueRpcRequiresUpgrade(ISSUES_WS_METHODS.bulkUpdate, {
        patch: { automationAssignment: null },
      }),
    );
    assert.isTrue(issueRpcRequiresUpgrade(ISSUES_WS_METHODS.commentCreate, { body: "ordinary" }));
    assert.isFalse(issueRpcRequiresUpgrade(ISSUES_WS_METHODS.commentCreate, { agentMention: {} }));
    assert.isTrue(
      issueRpcRequiresCurrentClient(ISSUES_WS_METHODS.commentCreate, { agentMention: {} }),
    );
    for (const method of [
      ISSUES_WS_METHODS.milestoneHistory,
      ISSUES_WS_METHODS.importCsv,
      ISSUES_WS_METHODS.uploadCommentAttachment,
      ISSUES_WS_METHODS.cancelCommentAgentRun,
      ISSUES_WS_METHODS.retryCommentAgentRun,
      ISSUES_WS_METHODS.startEnrichment,
      ISSUES_WS_METHODS.cancelEnrichment,
      ISSUES_WS_METHODS.getEnrichmentRuns,
    ]) {
      assert.isTrue(issueRpcRequiresCurrentClient(method, {}), method);
    }
  });

  it.effect(
    "returns an old-client-decodable upgrade notice only when the replica is routable",
    () =>
      Effect.gen(function* () {
        const error = yield* enforceIssueClientCutover({
          method: ISSUES_WS_METHODS.create,
          payload: {},
          replicaRoutable: Effect.succeed(true),
          currentClient: Effect.succeed(false),
          effect: Effect.succeed("written"),
        }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "IssueTrackerError");
        assert.strictEqual(error.reason, "invalid");
        assert.strictEqual(error.message, ISSUE_CLIENT_UPGRADE_REQUIRED_MESSAGE);

        const legacy = yield* enforceIssueClientCutover({
          method: ISSUES_WS_METHODS.create,
          payload: {},
          replicaRoutable: Effect.succeed(false),
          currentClient: Effect.succeed(false),
          effect: Effect.succeed("written"),
        });
        assert.strictEqual(legacy, "written");

        const staleConditional = yield* enforceIssueClientCutover({
          method: ISSUES_WS_METHODS.commentCreate,
          payload: { agentMention: {} },
          replicaRoutable: Effect.succeed(true),
          currentClient: Effect.succeed(false),
          effect: Effect.succeed("written"),
        }).pipe(Effect.flip);
        assert.strictEqual(staleConditional.message, ISSUE_CLIENT_UPGRADE_REQUIRED_MESSAGE);

        const currentConditional = yield* enforceIssueClientCutover({
          method: ISSUES_WS_METHODS.commentCreate,
          payload: { agentMention: {} },
          replicaRoutable: Effect.succeed(true),
          currentClient: Effect.succeed(true),
          effect: Effect.succeed("written"),
        });
        assert.strictEqual(currentConditional, "written");
      }),
  );
});
