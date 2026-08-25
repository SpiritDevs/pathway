import { describe, expect, it } from "vite-plus/test";
import { RunId } from "./baseSchemas.ts";
import * as DateTime from "effect/DateTime";

import {
  canStartPushAutoSettlement,
  pushAutoSettlementActivityKey,
  pushAutoSettlementStillEligible,
  shouldStartPushAutoSettlement,
} from "./pushAutoSettlement.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread() {
  return {
    activeRunId: null,
    activityRunStatus: null,
    archivedAt: null,
    deletedAt: null,
    hasActionableProposedPlan: false,
    itemCount: 4,
    latestRunCompletedAt: at("2026-08-14T00:00:02.000Z"),
    latestRunId: RunId.make("run-1"),
    latestRunRequestedAt: at("2026-08-14T00:00:00.000Z"),
    latestRunStartedAt: at("2026-08-14T00:00:01.000Z"),
    latestUserMessageAt: at("2026-08-14T00:00:00.000Z"),
    latestVisibleMessage: null,
    pendingRuntimeRequest: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    status: "completed" as const,
    visibleItemCount: 4,
  };
}

function result(pushStatus: "pushed" | "skipped_not_requested" | "skipped_up_to_date") {
  return {
    action: "commit_push" as const,
    branch: { status: "skipped_not_requested" as const },
    commit: { status: "created" as const, commitSha: "abcdef0", subject: "Fix it" },
    push: { status: pushStatus, branch: "main" },
    pr: { status: "skipped_not_requested" as const },
    toast: { title: "Pushed", cta: { kind: "none" as const } },
  };
}

describe("push auto-settlement", () => {
  it("starts only when the action pushed commits to the default branch", () => {
    expect(shouldStartPushAutoSettlement(result("pushed"), true)).toBe(true);
    expect(shouldStartPushAutoSettlement(result("pushed"), false)).toBe(false);
    expect(shouldStartPushAutoSettlement(result("skipped_up_to_date"), true)).toBe(false);
    expect(shouldStartPushAutoSettlement(result("skipped_not_requested"), true)).toBe(false);
  });

  it("keeps metadata-only changes out of the activity fence", () => {
    const initial = thread();
    const activityKey = pushAutoSettlementActivityKey(initial);
    const afterMetadataSync = {
      ...initial,
      branch: "feature/pushed",
      title: "Updated title",
    };

    expect(pushAutoSettlementStillEligible(activityKey, afterMetadataSync)).toBe(true);
  });

  it("cancels when a message or run changes during the grace period", () => {
    const initial = thread();
    const activityKey = pushAutoSettlementActivityKey(initial);

    expect(
      pushAutoSettlementStillEligible(activityKey, {
        ...initial,
        itemCount: initial.itemCount + 1,
        latestUserMessageAt: at("2026-08-14T00:00:08.000Z"),
      }),
    ).toBe(false);
    expect(
      pushAutoSettlementStillEligible(activityKey, {
        ...initial,
        latestRunId: RunId.make("run-2"),
      }),
    ).toBe(false);
  });

  it("does not override explicit active, snoozed, or pinned lifecycle state", () => {
    const initial = thread();

    expect(canStartPushAutoSettlement({ ...initial, settledOverride: "active" })).toBe(false);
    expect(
      canStartPushAutoSettlement({
        ...initial,
        snoozedUntil: at("2026-08-14T01:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      canStartPushAutoSettlement({ ...initial, pinnedAt: at("2026-08-14T00:00:00.000Z") }),
    ).toBe(false);
  });
});
