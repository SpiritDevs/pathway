import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type VcsStatusRemoteResult,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { isMatchingMergedPullRequest } from "./ResourceCleanupService.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export function temporaryPullRequestWatch(shell: OrchestrationV2ThreadShell) {
  const cwd = shell.worktreePath ?? shell.conversationDirectory;
  return shell.temporary === true &&
    shell.deletedAt === null &&
    shell.archivedAt === null &&
    shell.attachedPullRequest != null &&
    cwd !== undefined
    ? { cwd, pullRequest: shell.attachedPullRequest }
    : null;
}

function updatesTemporaryWatch(event: OrchestrationV2DomainEvent): boolean {
  return ["thread.created", "thread.metadata-updated", "thread.deleted", "thread.archived", "thread.unarchived"].includes(event.type) ||
    (event.type === "turn-item.updated" && event.payload.type === "source_control") ||
    (event.type === "run.updated" && ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status));
}

/** Reuses the VCS broadcaster's repository subscriptions, including startup snapshots. */
export const watchTemporaryThreads = Effect.fn("TemporaryThreadSettlement.watch")(function* () {
  const threads = yield* ThreadManagementService;
  const vcs = yield* VcsStatusBroadcaster;
  const scope = yield* Scope.Scope;
  const watchers = new Map<ThreadId, { readonly key: string; readonly fiber: Fiber.Fiber<void> }>();
  const events = yield* Stream.toQueue(threads.streamDomainEvents.pipe(Stream.filter(updatesTemporaryWatch)), { capacity: 256 });
  let requestOrdinal = 0;

  const reconcile = Effect.fn("TemporaryThreadSettlement.reconcile")(function* (
    shell: OrchestrationV2ThreadShell | null,
    threadId: ThreadId,
  ) {
    const watch = shell === null ? null : temporaryPullRequestWatch(shell);
    const key = watch === null ? null : `${watch.cwd}\n${watch.pullRequest.url}`;
    const existing = watchers.get(threadId);
    if (existing?.key === key && existing.fiber.pollUnsafe() === undefined) return;
    if (existing !== undefined) {
      watchers.delete(threadId);
      yield* Fiber.interrupt(existing.fiber);
    }
    if (watch === null || key === null) return;

    let remote: VcsStatusRemoteResult | null = null;
    const observe = vcs.streamStatus({ cwd: watch.cwd }, { runInBackground: true }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event._tag === "snapshot" || event._tag === "remoteUpdated") remote = event.remote;
          if (!isMatchingMergedPullRequest(watch.pullRequest, remote?.pr ?? null)) return;
          const current = yield* threads.getThreadShell(threadId);
          if (
            current === null ||
            current.temporary !== true ||
            current.deletedAt !== null ||
            current.attachedPullRequest?.url !== watch.pullRequest.url ||
            (current.worktreePath ?? current.conversationDirectory) !== watch.cwd
          )
            return;
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          // Dispatch checks fresh Git status and the matching attached PR under the thread lock.
          yield* threads
            .dispatch({
              type: "thread.settle",
              threadId,
              automatic: true,
              commandId: CommandId.make(
                `command:temporary-pr:${threadId}:${timestamp}:${++requestOrdinal}`,
              ),
            })
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Temporary thread PR monitoring stopped", { threadId, cause }),
      ),
    );
    watchers.set(threadId, { key, fiber: yield* Effect.forkIn(observe, scope) });
  });

  const initial = yield* threads.getShellSnapshot();
  for (const shell of initial.threads) yield* reconcile(shell, shell.id);
  yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((event) =>
      threads.getThreadShell(event.threadId).pipe(
        Effect.flatMap((shell) => reconcile(shell, event.threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Unable to update temporary thread PR monitoring", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
    ),
  );
});

export const workerLive = Layer.effectDiscard(
  watchTemporaryThreads().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Temporary thread PR monitoring failed", { cause }),
    ),
    Effect.forkScoped,
  ),
);
