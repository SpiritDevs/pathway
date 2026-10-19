import * as NodeCrypto from "node:crypto";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  type IssuePullRequest,
  type VcsStatusResult,
} from "@spiritdevs/contracts";
import { EventSinkV2 } from "./EventSink.ts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodeAzureDevOpsPullRequestJson } from "../sourceControl/azureDevOpsPullRequests.ts";

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
  ) => Effect.Effect<VcsStatusResult | void, RunFinalizationRefreshError>;
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

/** PR creation commands can produce several links before the final branch status is read. */
export function detectedThreadPullRequests(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  branchPr: VcsStatusResult["pr"],
) {
  const found = new Map<string, { number: number; url: string }>();
  for (const item of items) {
    if (
      (item.type !== "command_execution" && item.type !== "dynamic_tool") ||
      item.status !== "completed"
    )
      continue;
    const input = `${item.type === "dynamic_tool" ? (item.toolName ?? "") : ""} ${typeof item.input === "string" ? item.input : (JSON.stringify(item.input) ?? "")}`;
    const createsPullRequest =
      /\b(?:gh\s+pr|glab\s+mr|az\s+repos\s+pr|bb\s+pr)\s+create\b/i.test(input) ||
      /(?:^|[\W_])create[_-]?(?:pull[_-]?request|merge[_-]?request)\b/i.test(input) ||
      (/\bPOST\b/i.test(input) &&
        /https?:\/\/api\.bitbucket\.org\/2\.0\/repositories\/[^\s"'\\]+\/pullrequests\b/i.test(
          input,
        ));
    if (!createsPullRequest) continue;
    const output =
      typeof item.output === "string" ? item.output : (JSON.stringify(item.output) ?? "");
    if (/\baz\s+repos\s+pr\s+create\b/i.test(input)) {
      // Azure's default JSON response may contain only a REST URL; reuse the provider normalizer.
      const decoded = decodeAzureDevOpsPullRequestJson(output);
      if (decoded._tag === "Success") {
        const { number, url } = decoded.success;
        if (/\/pullrequest\/\d+\b/.test(url)) found.set(url, { number, url });
      }
    }
    for (const match of output.matchAll(
      /https?:\/\/[^\s<>"'()\\]+\/(?:pull|merge_requests|pullrequest|pull-requests)\/(\d+)\b/g,
    )) {
      const url = match[0];
      found.set(url, { number: Number(match[1]), url });
    }
  }
  if (branchPr) found.set(branchPr.url, { number: branchPr.number, url: branchPr.url });
  return [...found.values()];
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
  const eventSink = yield* EventSinkV2;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    let refreshError: RunFinalizationError | undefined;
    const discovery = yield* Effect.gen(function* () {
      const projection = yield* projections
        .getThreadProjection(input.threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
      const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
      if (cwd !== undefined) {
        const status = yield* observer.refresh(input.threadId, cwd).pipe(
          Effect.catch((cause) => {
            refreshError = new RunFinalizationError({
              ...input,
              operation: "refresh-workspace",
              cause,
            });
            return Effect.void;
          }),
        );
        const candidates = detectedThreadPullRequests(
          projection.turnItems.filter((item) => item.runId === input.runId),
          status?.pr ?? null,
        );
        // A prior marker (including unlink) owns this identity. Automatic discovery must not undo it.
        const known = new Set(
          projection.turnItems.flatMap((item) =>
            item.type === "source_control" && item.pullRequest ? [item.pullRequest.url] : [],
          ),
        );
        const discovered = candidates.filter((pr) => !known.has(pr.url));
        if (discovered.length > 0) {
          const now = yield* DateTime.now;
          // A retry can discover more links after a failed refresh; it needs a new receipt.
          const identity = NodeCrypto.createHash("sha256")
            .update(
              discovered
                .map((pr) => pr.url)
                .sort()
                .join("\n"),
            )
            .digest("hex");
          const discoveryId = `${input.runId}:${identity}`;
          const commandId = CommandId.make(`command:effect:pull-requests:${discoveryId}`);
          const ordinal = projection.turnItems.reduce(
            (next, item) => Math.max(next, item.ordinal + 1),
            1,
          );
          yield* eventSink
            .commitCommand({
              commandId,
              threadId: input.threadId,
              commandType: "pull-requests.discover",
              acceptedAt: now,
              effects: [],
              events: discovered.map((pullRequest, index) => ({
                id: EventId.make(`event:pull-requests:${discoveryId}:${index}`),
                type: "turn-item.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`turn-item:pull-requests:${discoveryId}:${index}`),
                  threadId: input.threadId,
                  runId: input.runId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: ordinal + index,
                  status: "completed" as const,
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "source_control" as const,
                  committed: false,
                  pullRequestAction: "detected" as const,
                  pullRequest,
                },
              })),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
              ),
            );
        }
      }
    }).pipe(Effect.result);
    // Discover links before completion, but metadata failures must never prevent the checkpoint.
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    // Preserve retry/reporting of metadata errors after the completed turn is durable.
    if (discovery._tag === "Failure") return yield* discovery.failure;
    if (refreshError) return yield* refreshError;
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
          Effect.map(([, status]) => status),
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
            Effect.logWarning("Failed to attach a thread pull request to its task.", { cause }),
          ),
        ),
  })),
);
