import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type IssuePullRequest,
  type VcsStatusResult,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import { IssueTrackerService } from "../issues/IssueTrackerService.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedErrorClass<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedErrorClass<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refresh: (
    threadId: ThreadId,
    cwd: string,
  ) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("@spiritdevs/pathway/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void }),
}) {}

/** Optional issue-tracker sink. Other runtimes keep the no-op default. */
export class RunFinalizationPullRequestObserver extends Context.Reference<{
  readonly record: (
    input: Omit<IssuePullRequest, "createdAt" | "updatedAt">,
  ) => Effect.Effect<void>;
}>("@spiritdevs/pathway/orchestration-v2/RunFinalizationPullRequestObserver", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export function issuePullRequestFromStatus(
  threadId: ThreadId,
  status: VcsStatusResult,
): Omit<IssuePullRequest, "createdAt" | "updatedAt"> | null {
  if (status.pr === null) return null;
  return {
    threadId,
    provider: status.sourceControlProvider?.kind ?? "unknown",
    number: status.pr.number,
    title: status.pr.title,
    url: status.pr.url,
    state: status.pr.state,
  };
}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("@spiritdevs/pathway/orchestration-v2/RunFinalizationService") {}

export const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getThreadProjection(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      yield* observer
        .refresh(input.threadId, cwd)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const observerLive = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const pullRequests = yield* RunFinalizationPullRequestObserver;
    return {
      refresh: (threadId: ThreadId, cwd: string) =>
        Effect.all([workspaceEntries.refresh(cwd), vcsStatus.refreshStatus(cwd)], {
          concurrency: "unbounded",
        }).pipe(
          Effect.tap(([, status]) => {
            const pullRequest = issuePullRequestFromStatus(threadId, status);
            if (pullRequest === null) return Effect.void;
            return pullRequests.record(pullRequest);
          }),
          Effect.asVoid,
          Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause })),
        ),
    };
  }),
);

export const pullRequestObserverLive = Layer.effect(
  RunFinalizationPullRequestObserver,
  Effect.map(IssueTrackerService, (tracker) => ({
    record: (input: Omit<IssuePullRequest, "createdAt" | "updatedAt">) =>
      tracker
        .recordThreadPullRequest(input)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to attach a thread pull request to its issue.", { cause }),
          ),
        ),
  })),
);
