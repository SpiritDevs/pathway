import { CommandId } from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { forkParked } from "../serverActivation.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ThreadWorkspaceService } from "./ThreadWorkspaceService.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

/** Reconcile temporary retention on the environment even when every client is disconnected. */
export const reconcileTemporaryThreads = Effect.fn("TemporaryThreadSettlement.reconcile")(
  function* () {
    const threads = yield* ThreadManagementService;
    const workspaces = yield* ThreadWorkspaceService;
    const snapshot = yield* threads.getShellSnapshot();
    for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (!thread.temporary || thread.deletedAt !== null || thread.archivedAt !== null) continue;
      if (thread.pinnedAt != null) continue;
      if (thread.lineage.relationshipToParent === "subagent") continue;
      if (["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
        continue;
      if (thread.pendingRuntimeRequest !== null) continue;
      if (thread.projectId === null && !thread.settleAfterCompletion) continue;
      yield* Effect.gen(function* () {
        const projection = yield* threads.getThreadProjection(thread.id);
        const latestRun = projection.runs.at(-1);
        const afterCompletion =
          projection.thread.settleAfterCompletion === true && latestRun?.status === "completed";
        if (!afterCompletion && !(yield* workspaces.hasMergedPullRequest(projection.thread)))
          return;
        if (yield* workspaces.hasUnfinishedGitWork(projection.thread)) return;
        yield* threads.dispatch({
          type: "thread.settle",
          threadId: thread.id,
          commandId: CommandId.make(yield* randomUuidV4),
          reason: afterCompletion ? "after-completion" : "merged-pr",
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Temporary thread settlement deferred", { threadId: thread.id, cause }),
        ),
      );
    }
  },
);

export const layer = Layer.effectDiscard(
  forkParked(
    reconcileTemporaryThreads().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Temporary thread reconciliation failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
    ),
  ),
);
